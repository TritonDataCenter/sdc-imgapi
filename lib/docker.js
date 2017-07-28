/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * IMGAPI docker specific code.
 */

var crypto = require('crypto');
var util = require('util'),
    format = util.format;
var zlib = require('zlib');

var assert = require('assert-plus');
var drc = require('docker-registry-client');
var imgmanifest = require('imgmanifest');
var jsprim = require('jsprim');
var once = require('once');
var Readable = require('stream').Readable;
var streampeek = require('buffer-peek-stream');
var through2 = require('through2');
var vasync = require('vasync');

var constants = require('./constants');
var errors = require('./errors');
var magic = require('./magic');
var utils = require('./utils');


//---- globals

/*
 * DOCKER-893: Maintain an in-memory image cache (just the image/layer metadata)
 * for the docker layers that have been downloaded, but not yet registered with
 * an image. This is used when a docker image download fails, we keep all the
 * successfully downloaded layers from that image in this cache. If the image is
 * attempted to be downloaded again, this cache is checked to avoid
 * re-downloading those layers.
 */
var DOCKER_IMAGE_CACHE = {};


//---- helpers

/**
 * Check if the cmd is a metadata command - i.e. doesn't modify the filesystem.
 */
function isMetadataCmd(cmd) {
    assert.string(cmd, 'cmd');
    var marker = ' #(nop) ';
    var idx = cmd.indexOf(marker);
    if (idx === -1) {
        // Some older manifests don't include the #nop marker, e.g. for run
        // commands.
        return false;
    }
    var name = cmd.substr(idx + marker.length).split(' ')[0];
    return ['ADD', 'COPY', 'RUN'].indexOf(name) === -1;
}




/*
 * Called during `AdminImportDockerImage` to create (unactivated) and
 * download the file for a single type=docker image.
 *
 * Note that if this function returns an error that is a DownloadError instance,
 * the caller can schedule a retry of the download, whilst any other error
 * indicates that the caller should not retry the download.
 *
 * @param opts {Object}
 *      - @param ctx {Object} The run context for the
 *        `apiAdminImportRemoteImage` call.
 *      - @param imgJson {Object} Docker image object (config, rootfs, layers).
 *      - @param digest {String} This is the layer sha256 digest.
 *      - @param layerDigests {Array} All digests in the chain (including the
 *        current digest as the last entry).
 *      - @param uncompressedDigest {String} Digest of the uncompressed layer.
 * @param callback {Function}
 */
function dockerDownloadAndImportLayer(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalString(opts.compression, 'opts.compression');
    assert.object(opts.ctx, 'opts.ctx');
    assert.object(opts.ctx.digestFromUuid, 'opts.ctx.digestFromUuid');
    assert.func(opts.ctx.Image, 'opts.ctx.Image');
    assert.object(opts.ctx.rat, 'opts.ctx.rat');
    assert.object(opts.ctx.regClientV2, 'opts.ctx.regClientV2');
    assert.object(opts.ctx.req, 'opts.ctx.req');
    assert.func(opts.ctx.resMessage, 'opts.ctx.resMessage');
    assert.string(opts.digest, 'opts.digest');
    assert.object(opts.imgJson, 'opts.imgJson');
    assert.arrayOfString(opts.layerDigests, 'opts.layerDigests');
    assert.optionalString(opts.uncompressedDigest, 'opts.uncompressedDigest');
    assert.func(callback, 'callback');

    var compression = opts.compression;
    var ctx = opts.ctx;
    var digest = opts.digest;
    var imgJson = opts.imgJson;
    var req = ctx.req;
    var app = req._app;
    var log = req.log;
    var rat = ctx.rat;

    var fileSize = -1; // The same value used in Docker-docker for "don't know".
    var manifest;
    var newImage;
    var shortId = imgmanifest.shortDockerId(
        imgmanifest.dockerIdFromDigest(digest));
    var uncompressedDigest = opts.uncompressedDigest;
    var uuid = imgmanifest.imgUuidFromDockerDigests(opts.layerDigests);

    function progressStatus(msg, progressDetail) {
        var payload = {
            id: shortId,
            status: msg
        };
        if (progressDetail) {
            payload.progressDetail = progressDetail;
        }
        ctx.resMessage({
            type: 'progress',
            payload: payload
        });
    }

    // Remember the uuid -> digest relationship.
    ctx.digestFromUuid[uuid] = digest;

    log.debug({uuid: uuid, digest: digest},
        'dockerDownloadAndImportLayer: check if image already exists');
    ctx.Image.get(app, uuid, log, function (gErr, image) {
        if (!gErr) {
            assert.object(image, 'image');

            if (image.state !== 'unactivated') {
                // When the image already exists, just return the image as is.
                log.debug({uuid: uuid, repo: rat.canonicalName, digest: digest},
                    'dockerDownloadAndImportLayer: layer already exists');
                progressStatus('Already exists');
                callback(null, image);
                return;
            }

            // Mark this Image as existing in the database
            log.debug({uuid: uuid, repo: rat.canonicalName, digest: digest},
                'dockerDownloadAndImportLayer: '
                + 'layer exists, but is unactivated');
            newImage = image;

        } else if (gErr.restCode !== 'ResourceNotFound') {
            return callback(gErr);
        }

        // Check if this image layer has already been downloaded before.
        if (DOCKER_IMAGE_CACHE.hasOwnProperty(uuid)) {
            var cachedItem = DOCKER_IMAGE_CACHE[uuid];
            ctx.newFileInfoFromUuid[uuid] = cachedItem;
            newImage = cachedItem.image;

            log.debug({digest: digest, uuid: uuid},
                'dockerDownloadAndImportImage: image layer already cached');

            // IMGAPI-644 This cached image should not be activated.
            assert.equal(newImage.activated, false,
                'newImage.activated should be false');

            progressStatus('Download complete (cached)');
            callback(null, newImage);
            return;
        }

        log.debug({uuid: uuid, repo: rat.canonicalName, digest: digest},
            'dockerDownloadAndImportLayer: start import');

        vasync.pipeline({ arg: {}, funcs: [
            genImgapiManifest,
            handleOwner,
            handleChannels,
            createReadStream,
            detectCompression,
            uncompressAndSha256Contents,
            createImageFromManifest,
            addImageFile,
            addUncompressedDigest
        ]}, function afterPipe(pipeErr) {
            if (pipeErr) {
                callback(pipeErr);
                return;
            }
            progressStatus('Download complete');
            callback(null, newImage);
        });
    });

    function genImgapiManifest(_, next) {
        try {
            manifest = imgmanifest.imgManifestFromDockerInfo({
                uuid: uuid,
                layerDigests: opts.layerDigests,
                imgJson: imgJson,
                repo: rat,
                public: ctx.public_
            });
        } catch (e) {
            return next(new errors.InternalError(e,
                'could not convert Docker image JSON to a manifest'));
        }

        if (!manifest.os) {
           manifest.os = 'other';  // some docker layers have no `.os`
        }
        next();
    }

    function handleOwner(_, next) {
        if (newImage) {
            next();
            return;
        }

        /**
         * In 'dc' mode (i.e. with a UFDS user database) change owner from
         * UNSET_OWNER_UUID -> admin. In other modes (i.e. not user
         * database), change owner from anything -> UNSET_OWNER_UUID.
         *
         * This means that the cycle of publishing an image to a public
         * repo and importing into a DC makes the image cleanly owned by
         * the 'admin' user. See IMGAPI-408.
         */
        if (app.mode === 'dc') {
            if (manifest.owner === constants.UNSET_OWNER_UUID) {
                manifest.owner = app.config.adminUuid;
                return next();
            }
        } else {
            manifest.owner = constants.UNSET_OWNER_UUID;
        }

        return next();
    }

    function handleChannels(_, next) {
        if (newImage) {
            next();
            return;
        }

        delete manifest.channels;
        if (req.channel) {
            manifest.channels = [req.channel.name];
        }
        next();
    }

    function createReadStream(arg, next) {
        ctx.regClientV2.createBlobReadStream({digest: digest},
                function onStreamCb(err, blobStream) {
            if (err) {
                next(errors.wrapErrorFromDrc(err));
                return;
            }
            arg.httpResponse = blobStream;
            arg.stream = blobStream;
            next();
        });
    }

    function detectCompression(arg, next) {
        if (compression) {
            next();
            return;
        }

        streampeek(arg.stream, magic.maxMagicLen,
                function onpeek(err, buf, stream) {
            if (err) {
                next(err);
                return;
            }

            // Update stream reference.
            arg.stream = stream;

            if (buf.length < magic.maxMagicLen) {
                // Not a compressed file.
                compression = 'none';
                next();
                return;
            }

            compression = magic.compressionTypeFromBufSync(buf) || 'none';
            next();
        });
    }

    function uncompressAndSha256Contents(arg, next) {
        if (compression === 'none' || uncompressedDigest) {
            next();
            return;
        }

        // Need to uncompress the data to get the uncompressed sha256 digest.
        var uncompressStream;
        if (compression === 'gzip') {
            uncompressStream = zlib.createGunzip();
        } else if (compression === 'bzip2') {
            uncompressStream = zlib.createBunzip2();
        } else {
            // Unsupported compression stream.
            next(new errors.InternalError(format(
                'Unsupported layer compression: %s', compression)));
            return;
        }

        var sha256sum = crypto.createHash('sha256');
        sha256sum.on('readable', function () {
            var hash = sha256sum.read();
            if (hash) {
                uncompressedDigest = 'sha256:' + hash.toString('hex');
                // Check if the final callback is waiting for this hash.
                if (arg.uncompressedDigestCallback) {
                    arg.uncompressedDigestCallback(null, uncompressedDigest);
                }
            }
        });
        uncompressStream.pipe(sha256sum);

        // Pipe contents, but ensure stream is put back into paused mode.
        arg.stream.pipe(uncompressStream);
        arg.stream.pause();

        next();
    }

    function createImageFromManifest(_, next) {
        if (newImage) {
            next();
            return;
        }

        log.debug({ data: manifest },
            'dockerDownloadAndImportLayer: create it');
        ctx.Image.create(app, manifest, true, false, function (cErr, img) {
            if (cErr) {
                return next(cErr);
            }
            newImage = img;
            next();
        });
    }

    function addImageFile(arg, next) {
        log.debug({digest: digest}, 'AddImageFile: start');

        var connectionTimeoutHandler;
        var DOCKER_READ_STREAM_TIMEOUT = 15 * 1000;
        var md5sum = crypto.createHash('md5');
        // Send a progress message whenever we've downloaded at least
        // `progUpdateEvery` data (i.e. every 1/2 MiB).
        var progLastUpdateSize = 0;
        var progUpdateEvery = 512 * 1024;
        var resp = arg.httpResponse;
        var shasum = crypto.createHash('sha1');
        var sha256sum = crypto.createHash('sha256');
        var size = 0;
        var startTs = Math.floor(new Date().getTime() / 1000);
        var stor;  // the storage class
        var stream = arg.stream;

        progressStatus('Pulling fs layer');

        if (resp.headers['content-length'] !== undefined) {
            fileSize = Number(resp.headers['content-length']);
            if (fileSize > constants.MAX_IMAGE_SIZE) {
                // Using ImageFileTooBigError instead of DownloadError so the
                // caller doesn't retry to download.
                return next(new errors.ImageFileTooBigError(format(
                    'Image file size, %s, exceeds the maximum allowed ' +
                    'file size, %s', fileSize, constants.MAX_IMAGE_SIZE_STR)));
            }
        }

        // Setup a response timeout listener to handle connection timeout.
        assert.object(resp.connection, 'resp.connection');

        resp.connection.setTimeout(DOCKER_READ_STREAM_TIMEOUT);
        connectionTimeoutHandler = function onDockerConnectionTimeout() {
            log.info({digest: digest, size: size, fileSize: fileSize},
                'dockerDownloadAndImportImage: '
                + 'createBlobReadStream connection timed out');
            progressStatus('Connection timed out');
            // Note that by destroying the stream this will result in a
            // call to finish() with an error, as the drc
            // createBlobReadStream handler has an 'end' handler that
            // validates the size and digest of downloaded data and
            // emits an error event when all the data wasn't downloaded.
            resp.destroy();
        };
        resp.connection.on('timeout', connectionTimeoutHandler);

        function finish_(fErr, tmpFilename, filename) {
            // Remove connection timeout handler.
            resp.connection.removeListener('timeout', connectionTimeoutHandler);
            connectionTimeoutHandler = null;

            if (fErr) {
                log.info({digest: digest, err: fErr},
                    'dockerDownloadAndImportImage: error');
                return next(fErr);
            } else if (ctx.downloadsCanceled) {
                return next(new errors.DownloadError('Download canceled'));
            } else if (size > constants.MAX_IMAGE_SIZE) {
                // Using ImageFileTooBigError instead of DownloadError so the
                // caller doesn't retry to download.
                return next(new errors.ImageFileTooBigError(format(
                    'Image file size, %s, exceeds the maximum allowed ' +
                    'file size, %s', size, constants.MAX_IMAGE_SIZE_STR)));
            } else if (fileSize >= 0 && size !== fileSize) {
                return next(new errors.DownloadError(format(
                    'Download error: "Content-Length" header, %s, does ' +
                    'not match downloaded size, %d', fileSize, size)));
            }

            var sha1 = shasum.digest('hex');
            var fileDigest = 'sha256:' + sha256sum.digest('hex');

            // Validate the sha256 of the downloaded bits matches the
            // digest, if they don't match there is a corruption.
            if (fileDigest !== digest) {
                // Note that we don't cleanup the failed image file download,
                // that is handled by IMGAPI-616.
                log.warn({expectedDigest: digest, fileDigest: fileDigest},
                    'Downloaded layer digest does not match');
                next(new errors.DownloadError(format(
                    'layer digest does not match, got %s, expected %s',
                    fileDigest, digest)));
                return;
            }

            var file = {
                sha1: sha1,
                digest: fileDigest,
                size: size,
                contentMD5: md5sum.digest('base64'),
                mtime: (new Date()).toISOString(),
                stor: stor.type,
                compression: compression
            };

            ctx.newFileInfoFromUuid[uuid] = {
                file: file,
                image: newImage,
                storage: stor.type,
                tmpFilename: tmpFilename,
                filename: filename
            };

            log.info({digest: digest, fileSize: fileSize},
                'dockerDownloadAndImportImage: Download successful');
            return next();
        }
        var finish = once(finish_);

        stream.on('data', function (chunk) {
            if (ctx.downloadsCanceled) {
                resp.destroy();
                progressStatus('Aborted');
                return;
            }

            size += chunk.length;
            if (size > constants.MAX_IMAGE_SIZE) {
                finish(new errors.DownloadError(format(
                    'Download error: image file size exceeds the ' +
                    'maximum allowed size, %s', constants.MAX_IMAGE_SIZE_STR)));
            }
            shasum.update(chunk, 'binary');
            sha256sum.update(chunk, 'binary');
            md5sum.update(chunk, 'binary');

            if ((size - progLastUpdateSize) > progUpdateEvery) {
                progressStatus('Downloading', {
                    current: size,
                    total: fileSize,
                    start: startTs
                });
                progLastUpdateSize = size;
            }
        });

        stream.on('error', function (streamErr) {
            finish(errors.wrapErrorFromDrc(streamErr));
        });

        if (resp !== stream) {
            // IMGAPI-636: Listen for errors on the original response object,
            // as the stream is a buffer-peek-stream (for v2.1 image layers),
            // and drc will emit the error on the original stream (from the
            // createBlobReadStream call).
            resp.on('error', function (streamErr) {
                finish(errors.wrapErrorFromDrc(streamErr));
            });
        }

        stor = app.chooseStor(newImage);
        stor.storeFileFromStream({
            image: newImage,
            stream: stream,
            reqId: resp.id(),
            filename: 'file0',
            noStreamErrorHandler: true
        }, function (sErr, tmpFilename, filename) {
            if (sErr) {
                log.error({err: sErr, digest: digest},
                    'error storing image file');
                finish(errors.parseErrorFromStorage(
                    sErr, 'error receiving image file'));
            } else {
                finish(null, tmpFilename, filename);
            }
        });
    }

    function addUncompressedDigest(arg, next) {
        var newFileInfo = ctx.newFileInfoFromUuid[uuid];
        assert.object(newFileInfo, 'newFileInfo');
        assert.object(newFileInfo.file, 'newFileInfo.file');

        if (compression === 'none') {
            // Same sha256 - as there is no compression.
            newFileInfo.file.uncompressedDigest = 'sha256:'
                + newFileInfo.sha256;
            next();
            return;
        }

        if (uncompressedDigest) {
            newFileInfo.file.uncompressedDigest = uncompressedDigest;
            next();
            return;
        }

        // Data is still piping to the uncompress/sha256 function, set and wait
        // for it's callback.
        arg.uncompressedDigestCallback = function (err, uDigest) {
            if (!err) {
                newFileInfo.file.uncompressedDigest = uDigest;
                progressStatus('Uncompression completed');
            }
            next(err);
        };

        progressStatus('Uncompressing layer');
    }
}


function _dockerDownloadAndImportLayerWithRetries(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalNumber(opts.addImageFileAttempt, 'opts.addImageFileAttempt');
    assert.object(opts.ctx, 'opts.ctx');
    assert.object(opts.ctx.req, 'opts.ctx.req');
    assert.object(opts.ctx.req.log, 'opts.ctx.req.log');
    assert.func(opts.ctx.resMessage, 'opts.ctx.resMessage');
    assert.string(opts.digest, 'opts.digest');
    assert.func(callback, 'callback');

    var MAX_IMAGE_FILE_DOWNLOAD_ATTEMPTS = 5;
    var addImageFileAttempt = opts.addImageFileAttempt || 0;
    var ctx = opts.ctx;
    var digest = opts.digest;
    var log = ctx.req.log;

    function retryDownload(err) {
        addImageFileAttempt += 1;

        // Abort if we've exceeded the maximum retry attempts.
        if (addImageFileAttempt >= MAX_IMAGE_FILE_DOWNLOAD_ATTEMPTS) {
            log.info({digest: digest},
                'dockerDownloadAndImportImage: download failed after '
                + '%d attempts', addImageFileAttempt);
            callback(err);
            return;
        }

        // Give a short respite and then go again.
        setTimeout(function _retryDockerImgDownload() {
            if (ctx.downloadsCanceled) {
                log.info({err: err, digest: digest,
                    addImageFileAttempt: addImageFileAttempt},
                    'dockerDownloadAndImportImage: not retrying, ' +
                    'download already canceled');
                callback(new errors.DownloadError(err, 'Download canceled'));
                return;
            }

            log.info({digest: digest, addImageFileAttempt: addImageFileAttempt},
                'dockerDownloadAndImportImage: retrying blob download');
            opts.addImageFileAttempt = addImageFileAttempt;
            _dockerDownloadAndImportLayerWithRetries(opts, callback);
        }, 1000);
    }

    dockerDownloadAndImportLayer(opts, function _dockerDlImgCb(err, image) {
        // Return if no error, or the error is not a DownloadError.
        if (err) {
            if (err.name === 'DownloadError') {
                retryDownload(err);
                return;
            }

            callback(err);
            return;
        }

        callback(null, image);
    });
}


/*
 * This function is run as a forEach in adminImportDockerImage. We need
 * to ensure image objects are added serially into the database.
 * The function 'this' is bound to be { req: req, res: res }
 */
function _dockerActivateImage(newImage, ctx, callback) {
    var req = ctx.req;
    var resMessage = ctx.resMessage;
    var app = req._app;
    var log = req.log;
    var digest = ctx.digestFromUuid[newImage.uuid];
    // If newFileInfo exists, it means a new file was downloaded for this image.
    var newFileInfo = ctx.newFileInfoFromUuid[newImage.uuid];
    var shortId = imgmanifest.shortDockerId(
        imgmanifest.dockerIdFromDigest(digest));

    vasync.pipeline({ funcs: [
        archiveManifest,
        addManifestToDb,
        finishMoveImageLayer,
        activateImage
    ]}, function afterPipe(pipeErr, results) {
        if (pipeErr) {
            callback(pipeErr);
            return;
        }

        if (newFileInfo) {
            resMessage({
                type: 'progress',
                payload: {
                    id: shortId,
                    status: 'Pull complete'
                }
            });
        }

        callback();
    });

    function archiveManifest(_, next) {
        if (!newFileInfo) {
            next();
            return;
        }

        var local = app.storage.local;
        var serialized = newImage.serialize(app.mode, '*');

        local.archiveImageManifest(serialized, function (archErr) {
            if (archErr) {
                log.error({uuid: newImage.uuid},
                    'error archiving image manifest:', serialized);
                return next(archErr);
            }
            next();
        });
    }

    function addManifestToDb(_, next) {
        if (!newFileInfo) {
            next();
            return;
        }

        app.db.add(newImage.uuid, newImage.raw, function (addErr) {
            if (addErr) {
                log.error({uuid: newImage.uuid},
                    'error saving to database: raw data:',
                    newImage.raw);
                return next(new errors.InternalError(addErr,
                    'could not create local image'));
            }
            app.cacheInvalidateWrite('Image', newImage);
            next();
        });
    }

    function finishMoveImageLayer(_, next) {
        if (newImage.activated) {
            next();
            return;
        }

        log.debug({digest: digest}, 'MoveImageLayer: start');
        var stor = app.getStor(newFileInfo.storage);

        stor.moveImageFile(newImage, newFileInfo.tmpFilename,
                newFileInfo.filename,
                function (mErr) {
            if (mErr) {
                return next(mErr);
            }

            // The image file has been moved - remove it from the cache.
            delete DOCKER_IMAGE_CACHE[newImage.uuid];

            newImage.addFile(app, newFileInfo.file, req.log, function (err2) {
                if (err2) {
                    req.log.error(err2, 'error adding file info to Image');
                    return next(new errors.InternalError(err2,
                        'could not save image'));
                }

                next();
            });
        });
    }

    function activateImage(_, next) {
        if (newImage.activated) {
            next();
            return;
        }

        resMessage({
            type: 'progress',
            payload: {
                id: shortId,
                status: 'Activating image'
            }
        });

        newImage.activate(app, req.log, next);
    }
}


/**
 * Add image history entries.
 *
 *  [
 *    {
 *      "created": "2016-05-05T18:13:29.963947682Z",
 *      "author": "Me Now <me@now.com>",
 *      "created_by": "/bin/sh -c #(nop) MAINTAINER Me Now <me@now.com>",
 *      "empty_layer": true
 *    }, {
 *      "created": "2016-05-05T18:13:30.218788521Z",
 *      "author": "Me Now <me@now.com>",
 *      "created_by": "/bin/sh -c #(nop) ADD file:c59222783...364a in /"
 *    }, {
 *      "created": "2016-05-05T18:13:30.456465331Z",
 *      "author": "Me Now <me@now.com>",
 *      "created_by": "/bin/touch /odd.txt"
 *    }
 *  ]
 */
function historyEntryFromImageJson(imgJson) {
    assert.object(imgJson.container_config, 'imgJson.container_config');

    // IMGAPI-635 imgJson.container_config.Cmd can be null.
    var cmd = '';
    if (imgJson.container_config.Cmd) {
        assert.arrayOfString(imgJson.container_config.Cmd,
            'imgJson.container_config.Cmd');
        cmd = imgJson.container_config.Cmd.join(' ');
    }

    var entry = {
        created: imgJson.created,
        created_by: cmd
    };

    if (isMetadataCmd(entry.created_by)) {
        entry.empty_layer = true;
    }
    if (imgJson.author) {
        entry.author = imgJson.author;
    }
    if (imgJson.comment) {
        entry.comment = imgJson.comment;
    }

    return entry;
}

/**
 * Create a docker config object from the given arguments.
 *
 * @param layers {Array} Info on each layer (digest, imgFile, etc...).
 * @param fakeIt {Boolean} Create placeholder rootfs information.
 *
 * @returns {Object} The docker config object.
 */
function createImgJsonFromLayers(layers, fakeIt) {
    assert.arrayOfObject(layers, 'layers');
    assert.optionalBool(fakeIt, 'fakeIt');

    var imgJson = utils.objCopy(layers.slice(-1)[0].imgJson);
    if (imgJson.hasOwnProperty('id')) {
        delete imgJson.id;   // No longer needed.
    }
    imgJson.history = layers.map(function (layer) {
        return historyEntryFromImageJson(layer.imgJson);
    });

    assert.equal(layers.length, imgJson.history.length,
        'Layers and image history must be the same length');

    /**
     * Add RootFS layers.
     *
     * {
     *   "type": "layers",
     *   "diff_ids": [
     *       "sha256:3f69a7949970fe2d62a5...c65003d01ac3bbe8645d574b",
     *       "sha256:f980315eda5e9265282c...41b30de83027a2077651b465",
     *       "sha256:30785cd7f84479984348...533457f3a5dcf677d0b0c51e"
     *   ]
     * }
     */
    var nonEmptyLayers = layers.filter(function _filterEmpty(layer, idx) {
        return !imgJson.history[idx].empty_layer;
    });
    imgJson.rootfs = {
        type: 'layers',
        diff_ids: nonEmptyLayers.map(function _getRootfsDiffId(layer) {
            if (!layer.uncompressedDigest && fakeIt) {
                return '';
            }
            assert.string(layer.uncompressedDigest);
            return layer.uncompressedDigest;
        })
    };

    return imgJson;
}


/**
 * Create a docker manifest object (schemaVersion 2) from the given arguments.
 *
 * @param imgJson {Object} The docker image config.
 * @param layers {Array} Info on each layer (digest, imgFile, etc...).
 * @param fakeIt {Boolean} Create placeholder layer information.
 *
 * @returns {Object} The docker manifest object.
 */
function createV2Manifest(imgJson, layers, fakeIt) {
    assert.object(imgJson, 'imgJson');
    assert.arrayOfObject(imgJson.history, 'imgJson.history');
    assert.arrayOfObject(layers, 'layers');
    assert.optionalBool(fakeIt, 'fakeIt');

    assert.equal(imgJson.history.length, layers.length,
        'history length should equal layers length');

    var imageStr = JSON.stringify(imgJson);
    var imageDigest = 'sha256:' + crypto.createHash('sha256')
        .update(imageStr, 'binary').digest('hex');

    var manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        config: {
            'mediaType': 'application/vnd.docker.container.image.v1+json',
            'size': imageStr.length,
            'digest': imageDigest
        },
        layers: layers.filter(function _filterLayers(layer, idx) {
            return !(imgJson.history[idx].empty_layer);
        }).map(function _mapLayers(layer) {
            assert.string(layer.digest, 'layer.digest');
            // If we have an imgManifest, then we have already downloaded the
            // file/layer and thus we don't need to fake it, as we have the
            // information we need to create the docker layer information.
            if (!layer.imgManifest && fakeIt) {
                // Fake it until you make it.
                return {
                    digest: layer.digest,
                    mediaType: '(unknown)'
                };
            }
            assert.object(layer.imgFile, 'layer.imgFile');
            assert.string(layer.compression, 'layer.compression');
            var compressionSuffix = '';
            if (layer.compression && layer.compression !== 'none') {
                compressionSuffix = '.' + layer.compression;
            }
            return {
                digest: layer.digest,
                mediaType: 'application/vnd.docker.image.rootfs.diff.tar' +
                    compressionSuffix,
                size: layer.imgFile.size
            };
        })
    };

    return manifest;
}


function compressionFromMediaType(mediaType) {
    switch (mediaType) {
        case 'application/vnd.docker.image.rootfs.diff.tar.bzip2':
            return 'bzip2';
        case 'application/vnd.docker.image.rootfs.diff.tar.gzip':
            return 'gzip';
        case 'application/vnd.docker.image.rootfs.diff.tar.xz':
            return 'xz';
        case 'application/vnd.docker.image.rootfs.diff.tar':
        case 'application/vnd.docker.image.rootfs.diff':
            return 'none';
        default:
            return undefined;
    }
    return undefined;
}


/* BEGIN JSSTYLED */
/*
 * Pull a docker image (with schemaVersion === 2) using v2 registry.
 *
 * Example Docker-docker pull:
 *
 *  $ docker pull alpine@sha256:fb9f16730ac6316afa4d97caa5130219927bfcecf0b0ce35c01dcb612f449739
 *  sha256:fb9f16730ac6316afa4d97caa5130219927bfcecf0b0ce35c01dcb612f449739: Pulling from library/alpine
 *  f4fddc471ec2: Pull complete
 *  library/alpine:sha256:fb9f16730ac6316afa4d97caa5130219927bfcecf0b0ce35c01dcb612f449739: The image you are pulling has been verified. Important: image verification is a tech preview feature and should not be relied on to provide security.
 *  Digest: sha256:fb9f16730ac6316afa4d97caa5130219927bfcecf0b0ce35c01dcb612f449739
 *  Status: Downloaded newer image for alpine@sha256:fb9f16730ac6316afa4d97caa5130219927bfcecf0b0ce35c01dcb612f449739
 *
 *  $ docker pull alpine@sha256:fb9f16730ac6316afa4d97caa5130219927bfcecf0b0ce35c01dcb612f449739
 *  sha256:fb9f16730ac6316afa4d97caa5130219927bfcecf0b0ce35c01dcb612f449739: Pulling from library/alpine
 *  f4fddc471ec2: Already exists
 *  Digest: sha256:fb9f16730ac6316afa4d97caa5130219927bfcecf0b0ce35c01dcb612f449739
 *  Status: Image is up to date for alpine@sha256:fb9f16730ac6316afa4d97caa5130219927bfcecf0b0ce35c01dcb612f449739
 */
/* END JSSTYLED */
function _dockerV22Pull(ctx, cb) {
    assert.object(ctx, 'ctx');
    assert.string(ctx.dockerImageVersion, 'ctx.dockerImageVersion');
    assert.string(ctx.manifestDigest, 'ctx.manifestDigest');
    assert.object(ctx.manifestV2, 'ctx.manifestV2');
    assert.object(ctx.manifestV2.config, 'ctx.manifest.config');
    assert.object(ctx.rat, 'ctx.rat');
    assert.object(ctx.regClientV2, 'ctx.regClientV2');
    assert.func(ctx.resMessage, 'ctx.resMessage');
    assert.optionalObject(ctx.config, 'ctx.config');
    assert.func(cb, 'cb');

    var cacheDownloadedLayers = false;
    var configDigest = ctx.manifestV2.config.digest;
    var imgJson = ctx.imgJson;
    var req = ctx.req;
    var log = req.log;
    var resMessage = ctx.resMessage;
    var rat = ctx.rat;
    var tag = rat.tag;
    var digest = rat.digest;

    // Get the docker config layer id, from the manifest, then fetch the config
    // details.

    // Send initial status message.
    resMessage({
        type: 'status',
        payload: {
            /*
             * When pulling all images in a repository is supported
             * Docker-docker says: 'Pulling repository $localName'.
             */
            status: format('%s: Pulling from %s (req %s)',
                tag || digest, rat.localName, req.getId())
        }
    });

    vasync.pipeline({funcs: [
        function downloadImgJson(_, next) {
            if (imgJson) {
                // This should only be when upconverting a v2.1 image.
                assert.equal(ctx.dockerImageVersion, '2.1',
                    'ctx.dockerImageVersion');
                next();
                return;
            }
            ctx.regClientV2.createBlobReadStream({digest: configDigest},
                function (err, stream, res_) {
                if (err) {
                    next(errors.wrapErrorFromDrc(err));
                    return;
                }
                // Read, validate and store the config.
                log.debug({digest: configDigest},
                    'downloadConfig:: stream started');

                var configStr = '';
                var hadErr = false;
                var sha256sum = crypto.createHash('sha256');

                stream.on('end', function _downloadConfigStreamEnd() {
                    if (hadErr) {
                        return;
                    }
                    log.debug({digest: configDigest},
                        'downloadConfig:: stream ended, config: %s', configStr);
                    var fileDigest = 'sha256:' + sha256sum.digest('hex');
                    if (fileDigest !== configDigest) {
                        log.warn({expectedDigest: configDigest,
                            fileDigest: fileDigest},
                            'Downloaded config digest does not match');
                        next(new errors.DownloadError(format(
                            'config digest does not match, got %s, expected %s',
                            fileDigest, configDigest)));
                        return;
                    }
                    // Convert into JSON.
                    try {
                        imgJson = JSON.parse(configStr);
                    } catch (configErr) {
                        next(new errors.ValidationFailedError(configErr, format(
                            'invalid JSON for docker config, digest %s, err %s',
                            configDigest, configErr)));
                        return;
                    }
                    next();
                });

                stream.on('error', function _downloadConfigStreamError(sErr) {
                    hadErr = true;
                    log.warn({digest: configDigest},
                        'downloadConfig:: error downloading config: %s', sErr);
                    stream.destroy();
                    next(new errors.DownloadError(format(
                        'error downloading config with digest %s, %s',
                        configDigest, sErr)));
                    return;
                });

                stream.on('data', function _downloadConfigStreamData(chunk) {
                    if (ctx.downloadsCanceled) {
                        stream.destroy();
                        return;
                    }
                    configStr += String(chunk);
                    sha256sum.update(chunk, 'binary');
                });

                // Stream is paused, so get it moving again.
                stream.resume();
            });
        },

        function determineLayers(_, next) {
            assert.arrayOfObject(imgJson.history, 'imgJson.history');
            assert.arrayOfString(imgJson.rootfs.diff_ids,
                'imgJson.rootfs.diff_ids');
            assert.arrayOfObject(ctx.manifestV2.layers,
                'ctx.manifestV2.layers');
            // History is from oldest change (index 0) to the newest change. For
            // each entry in history, there should be a corresponding entry in
            // both the manifestV2.layers array and the imgJson.rootfs.diff_ids
            // array, except in the case the history entry has a 'empty_layer'
            // attribute set to true.
            var layerDigests = [];
            var layerInfos = [];
            var idx = -1;
            imgJson.history.forEach(function _histForEach(h, pos) {
                // Emulate Docker's synthetic image config for each layer, so we
                // can later generate the history entries. For reference, see:
                // JSSTYLED
                // https://github.com/docker/distribution/blob/docker/1.13/docs/spec/manifest-v2-2.md#backward-compatibility
                var layerImgJson = {
                    created: h.created,
                    container_config: {
                      Cmd: [ h.created_by ]
                    }
                };
                if (pos === (imgJson.history.length - 1)) {
                    // Last layer uses the original imgJson.
                    layerImgJson = imgJson;
                }

                if (h.empty_layer) {
                    layerInfos.push({
                        historyEntry: h,
                        imgJson: layerImgJson,
                        layerDigests: layerDigests.slice()  // A copy
                    });
                    return;
                }

                idx += 1;
                var compression = compressionFromMediaType(
                    ctx.manifestV2.layers[idx].mediaType);
                var layerDigest = ctx.manifestV2.layers[idx].digest;
                var id = imgmanifest.dockerIdFromDigest(layerDigest);
                layerDigests.push(layerDigest);
                layerInfos.push({
                    compression: compression,
                    digest: layerDigest,
                    historyEntry: h,
                    imgJson: layerImgJson,
                    layerDigests: layerDigests.slice(),  // A copy
                    uncompressedDigest: imgJson.rootfs.diff_ids[idx]
                });
                resMessage({
                    type: 'status',
                    payload: {
                        id: imgmanifest.shortDockerId(id),
                        progressDetail: {},
                        status: 'Pulling fs layer'
                    }
                });
            });
            ctx.layerInfos = layerInfos;
            next();
        },

        /*
         * In *parallel*, create (unactivated) and download the images.
         */
        function importImagesPart1(_, next) {
            cacheDownloadedLayers = true;
            ctx.downloadsCanceled = false;
            var pullQueueError;

            var pullQueue = vasync.queue(function (layerInfo, nextLayer) {
                if (layerInfo.historyEntry.empty_layer) {
                    // Nothing to download for this layer.
                    nextLayer();
                    return;
                }

                _dockerDownloadAndImportLayerWithRetries({
                    compression: layerInfo.compression,
                    digest: layerInfo.digest,
                    layerDigests: layerInfo.layerDigests,
                    imgJson: layerInfo.imgJson,
                    uncompressedDigest: layerInfo.uncompressedDigest,
                    ctx: ctx
                }, function _dockerDownloadLayerCb(err, image) {
                    if (err) {
                        log.info({err: err, digest: layerInfo.digest},
                            'dockerDownloadAndImportLayerWithRetries err');
                        nextLayer(err);
                        return;
                    }

                    var file0;
                    if (ctx.newFileInfoFromUuid.hasOwnProperty(image.uuid)) {
                        file0 = ctx.newFileInfoFromUuid[image.uuid].file;
                    } else {
                        // Existing image.
                        file0 = image.files[0];
                    }
                    layerInfo.imgFile = file0;
                    layerInfo.imgManifest = image;
                    nextLayer();
                });
            }, 5);

            pullQueue.on('end', function () {
                next(pullQueueError);
            });

            pullQueue.push(ctx.layerInfos, function (qErr) {
                if (qErr) {
                    log.debug(qErr, 'dockerDownloadAndImportLayer err');
                }
                if (qErr && pullQueueError === undefined) {
                    pullQueueError = qErr;
                    ctx.downloadsCanceled = true;
                    pullQueue.kill();
                }
            });
            pullQueue.close();
        },

        function recalculateConfigAndManifest(_, next) {
            if (ctx.dockerImageVersion !== '2.1') {
                next();
                return;
            }
            // Update compression and digest for all file layers.
            ctx.layerInfos.forEach(function (layer) {
                if (layer.historyEntry.empty_layer) {
                    return;
                }
                assert.object(layer.imgFile, 'layer.imgFile');
                assert.string(layer.imgFile.compression,
                    'layer.imgFile.compression');
                assert.string(layer.imgFile.uncompressedDigest,
                    'layer.imgFile.uncompressedDigest');
                layer.compression = layer.imgFile.compression;
                layer.uncompressedDigest = layer.imgFile.uncompressedDigest;
            });
            imgJson = createImgJsonFromLayers(ctx.layerInfos);
            ctx.manifestV2 = createV2Manifest(imgJson, ctx.layerInfos);
            ctx.manifestStr = JSON.stringify(ctx.manifestV2, null, 4);
            ctx.manifestDigest = 'sha256:' + crypto.createHash('sha256')
                .update(ctx.manifestStr, 'binary').digest('hex');
            configDigest = ctx.manifestV2.config.digest;

            log.debug({manifest: ctx.manifestV2},
                'recalculateConfigAndManifest');

            next();
        },

        /*
         * *Serially* complete the import of all the images:
         * - We only ActivateImage's at this stage after the file downloading
         *   (anticipated to be the most error-prone stage).
         * - We activate images in layerInfos order (parent before child) for
         *   db consistency.
         */
        function importImagesPart2(_, next) {
            cacheDownloadedLayers = false;
            vasync.forEachPipeline({
                inputs: ctx.layerInfos,
                func: function (layerInfo, nextLayer) {
                    assert.object(layerInfo.historyEntry,
                        'layerInfo.historyEntry');
                    if (layerInfo.historyEntry.empty_layer) {
                        nextLayer();
                        return;
                    }
                    assert.object(layerInfo.imgManifest,
                        'layerInfo.imgManifest');
                    _dockerActivateImage(layerInfo.imgManifest, ctx, nextLayer);
                }
            }, function (vErr, results) {
                next(vErr);
            });
        },

        function createSdcDockerImage(_, next) {
            // Create the sdc-docker image in the docker_images bucket.

            // Calculate total size and find the last image uuid.
            var finalUuid;
            var size = ctx.layerInfos.map(function (layer) {
                if (!layer.imgManifest) {
                    return 0;
                }
                assert.object(layer.imgFile, 'layer.imgFile');
                finalUuid = layer.imgManifest.uuid;
                return layer.imgFile && layer.imgFile.size || 0;
            }).reduce(function (a, b) { return a + b; }, 0);

            ctx.resMessage({
                type: 'create-docker-image',
                config_digest: configDigest,
                head: true,
                image: imgJson,
                image_uuid: finalUuid,
                manifest_digest: ctx.manifestDigest,
                manifest_str: ctx.manifestStr,
                size: size,
                dockerImageVersion: ctx.dockerImageVersion
            });
            next();
        },

        function finishingMessages(_, next) {
            resMessage({
                type: 'status',
                payload: {
                    status: 'Digest: ' + ctx.manifestDigest
                }
            });

            var status = (jsprim.isEmpty(ctx.newFileInfoFromUuid)
                ? 'Status: Image is up to date for ' + ctx.repoAndRef
                : 'Status: Downloaded newer image for ' + ctx.repoAndRef);
            resMessage({
                type: 'status',
                payload: {status: status}
            });

            next();
        }
    ]}, function (err) {
        if (cacheDownloadedLayers) {
            // There was a failure downloading one or more image layers - keep
            // the downloaded image metadata in memory, so we can avoid
            // downloading it again next time.
            Object.keys(ctx.newFileInfoFromUuid).forEach(function (u) {
                DOCKER_IMAGE_CACHE[u] = ctx.newFileInfoFromUuid[u];
            });
        }

        cb(err);
    });
}


/*
 * Pull a docker image using v2.1 image manifest format (schemaVersion === 1).
 *
 * We upconvert the manifest into a v2.2 format and then have the _dockerV22Pull
 * function do the bulk of the layer download work. Note that we have to fake a
 * part of the config and manifest, as we don't know the uncompressed digest or
 * the compression of the layer at this time - luckily the _dockerV22Pull can
 * work this out for us and then regenerates the config and manifest once this
 * information is known.
 */
function _dockerV21Pull(ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.string(ctx.manifestDigest, 'ctx.manifestDigest');
    assert.object(ctx.manifestV2, 'ctx.manifestV2');
    assert.object(ctx.req, 'ctx.req');
    assert.func(callback, 'callback');

    var req = ctx.req;
    var log = req.log;
    var layerDigest;
    var layerDigests = [];

    var layerInfos = [];  // Docker image info with the base image first.
    for (var i = ctx.manifestV2.history.length - 1; i >= 0; i--) {
        var imgJson;
        try {
            imgJson = JSON.parse(ctx.manifestV2.history[i].v1Compatibility);
        } catch (manifestErr) {
            return callback(
                new errors.ValidationFailedError(manifestErr, format(
                'invalid "v1Compatibility" JSON in docker manifest: %s (%s)',
                manifestErr, ctx.manifestV2.history[i].v1Compatibility)));
        }
        layerDigest = ctx.manifestV2.fsLayers[i].blobSum;
        layerDigests.push(layerDigest);
        layerInfos.push({
            digest: layerDigest,
            imgJson: imgJson,
            layerDigests: layerDigests.slice(),  // A copy - not a reference.
            shortId: imgmanifest.shortDockerId(
                imgmanifest.dockerIdFromDigest(layerDigest))
        });
    }

    log.debug({manifestV21: ctx.manifest},
        'Upconverting manifest from v2.1 to v2.2');
    var fakeIt = true;
    ctx.imgJson = createImgJsonFromLayers(layerInfos, fakeIt);
    ctx.manifestV2 = createV2Manifest(ctx.imgJson, layerInfos, fakeIt);
    ctx.manifestStr = JSON.stringify(ctx.manifestV2, null, 4);
    ctx.manifestDigest = 'sha256:' + crypto.createHash('sha256')
        .update(ctx.manifestStr, 'binary').digest('hex');

    _dockerV22Pull(ctx, callback);
}


// Done: Add progress messages.
// TODO: Add cross repository blob mount (requires knowledge of tag names).
// TODO: Support chunked uploads (using restify PATCH method).
// TODO: Support resumable uploads.
// TODO: Retry on failure?
function _pushOneDockerLayer(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.string(opts.digest, 'opts.digest');
    assert.object(opts.Image, 'opts.Image');
    assert.string(opts.imageUuid, 'opts.imageUuid');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.regClient, 'opts.regClient');
    assert.func(opts.resMessage, 'opts.resMessage');
    assert.func(callback, 'callback');

    var app = opts.app;
    var digest = opts.digest;
    var Image = opts.Image;
    var imageUuid = opts.imageUuid;
    var log = opts.log;
    var manifest;
    var REGISTRY_CONTAINS_IMAGE = true;  // Marker when image already exists.
    var regClient = opts.regClient;
    var resMessage = opts.resMessage;
    var shortId = imgmanifest.shortDockerId(
        imgmanifest.dockerIdFromDigest(digest));
    var uploading = true;

    function sendProgressStatus(msg, progressDetail) {
        var payload = {
            id: shortId,
            status: msg
        };
        if (progressDetail) {
            payload.progressDetail = progressDetail;
        }
        resMessage({
            type: 'progress',
            payload: payload
        });
    }

    vasync.pipeline({ arg: { bytesPiped: 0 }, funcs: [
        _getImage,
        _checkLayerExistsInRegistry,
        _getImgapiFileStream,
        _startProgressUpdater,
        _pipeStream,
        _sendPushedStatus
    ]}, _done);

    // Lookup image in IMGAPI.
    function _getImage(ctx, next) {
        log.trace({imageUuid: imageUuid}, '_pushOneDockerLayer: _getImage');
        Image.get(app, imageUuid, log, function (err, mnfst) {
            if (err) {
                next(err);
            } else if (mnfst.state !== 'active') {
                next(new errors.ResourceNotFoundError(imageUuid));
            } else {
                manifest = mnfst;
                ctx.file = manifest.files[0];
                assert.object(ctx.file, 'manifest.files[0]');
                opts.imageFromImgUuid[imageUuid] = manifest;
                sendProgressStatus('Preparing');
                next();
            }
        });
    }

    // Check if the image (with this digest) already exists in the registry.
    function _checkLayerExistsInRegistry(_, next) {
        log.trace({imageUuid: imageUuid},
            '_pushOneDockerLayer: _checkLayerExistsInRegistry');
        // Send back a status message saying we're looking at this layer.
        regClient.headBlob({digest: digest}, function (err  /* , ress */) {
            if (err) {
                // Allow 404 for when an image is not found - continue the push.
                if (err.statusCode === 404) {
                    next();
                    return;
                }
                // Any other error means a failure - we end the push.
                next(err);
                return;
            }
            // Otherwise, we already have this image in the registry - job done.
            sendProgressStatus('Layer already exists');
            next(REGISTRY_CONTAINS_IMAGE);
        });
    }

    // Get image file (stream).
    function _getImgapiFileStream(ctx, next) {
        log.trace({imageUuid: imageUuid},
            '_pushOneDockerLayer: _getImgapiFileStream');
        var stor = app.getStor(ctx.file.stor);
        stor.createImageFileReadStream(manifest, 'file0', {doNotPause: true},
                function (err, stream) {
            ctx.stream = stream;
            next(err);
        });
    }

    // Send upload progress updates periodically.
    function _startProgressUpdater(ctx, next) {
        assert.number(ctx.file.size, 'ctx.file.size');
        var bytesLastPiped = 0;
        var bytesTotal = ctx.file.size;
        var PROGRESS_UPDATE_TIMER = 2000;

        var checkProgress = function () {
            if (!uploading) {
                // Done.
                return;
            }
            if (ctx.bytesPiped > bytesLastPiped) {
                bytesLastPiped = ctx.bytesPiped;
                sendProgressStatus('Pushing', {
                    current: bytesLastPiped,
                    total: bytesTotal
                });
            }
            // And go again.
            ctx.progressId = setTimeout(checkProgress, PROGRESS_UPDATE_TIMER);
        };

        // Send a progress message every N seconds.
        ctx.progressId = setTimeout(checkProgress, PROGRESS_UPDATE_TIMER);
        next();
    }

    // Push image file (blob) to docker registry.
    function _pipeStream(ctx, next) {
        log.trace({digest: digest, imageUuid: imageUuid},
            '_pushOneDockerLayer: _pipeStream');
        var throughStream = through2(function onProgress(chunk, enc, cb) {
            ctx.bytesPiped += chunk.length;
            this.push(chunk);
            cb();
        });
        var contentLength = ctx.file.size;
        var blobOpts = {
            contentLength: contentLength,
            digest: digest,
            stream: throughStream
        };
        ctx.stream.pipe(throughStream);
        regClient.blobUpload(blobOpts, next);
    }

    function _sendPushedStatus(_, next) {
        sendProgressStatus('Pushed');
        next();
    }

    function _done(err, results) {
        log.trace({imageUuid: imageUuid, err: err},
            '_pushOneDockerLayer: _done');

        uploading = false;

        if (err === REGISTRY_CONTAINS_IMAGE) {  // shortcut code for success
            callback();
            return;
        }

        if (err) {
            sendProgressStatus('Image push failed');
        }

        callback(err);
    }
}


/**
 * Push a given docker repo:tag while streaming out progress messages.
 * Typically this is called by the sdc-docker 'push-image' workflow.
 */
function adminPushDockerImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(opts.Image, 'opts.Image');
    assert.object(opts.req, 'opts.req');
    assert.object(opts.req.log, 'opts.req.log');
    assert.object(opts.req.body, 'opts.req.body');
    assert.string(opts.req.body.manifest_str, 'opts.req.body.manifest_str');
    assert.object(opts.req.query, 'opts.req.query');
    assert.string(opts.req.query.repoAndTag, 'opts.req.query.repoAndTag');
    assert.object(opts.res, 'opts.res');
    assert.func(callback, 'callback');

    var req = opts.req;
    var res = opts.res;

    var app = req._app;
    var image = req.body;
    var log = req.log;
    var req_id = req.getId();
    var repoAndTag = req.query.repoAndTag;

    req.log.trace('req.query: ', req.query);

    var rat;
    try {
        rat = drc.parseRepoAndRef(repoAndTag);
    } catch (e) {
        return (callback(new errors.ValidationFailedError(
            e,
            e.message || e.toString(),
            [ {field: 'repoAndTag', code: 'Invalid'}])));
    }

    log.trace({image: image, repoAndTag: repoAndTag}, 'adminPushDockerImage');

    var manifest = image.manifest_str;
    var manifestStr = image.manifest_str;
    try {
        manifest = JSON.parse(manifestStr);
    } catch (e) {
        callback(new errors.ValidationFailedError(
            e,
            'JSON parse of manifest_str failed',
            [ { field: 'manifest_str', code: 'Invalid' } ]));
        return;
    }

    // TODO: Move auth parsing into a separate/shared function.
    var regAuth;
    var username, password;

    if (req.headers['x-registry-auth']) {
        /*
         * // JSSTYLED
         * https://github.com/docker/docker/blob/master/docs/reference/api/docker_remote_api_v1.23.md#create-an-image
         *
         * The 'x-registry-auth' header contains `username` and `password`
         * *OR* a `identitytoken`. We don't yet support identitytoken --
         * See DOCKER-771.
         */
        try {
            regAuth = JSON.parse(new Buffer(
                req.headers['x-registry-auth'], 'base64').toString('utf8'));
        } catch (e) {
            log.info(e, 'invalid x-registry-auth header, ignoring');
        }
        // Censor for audit logs.
        req.headers['x-registry-auth'] = '(censored)';
    }

    if (regAuth) {
        if (regAuth.identitytoken) {
            callback(new errors.NotImplementedError('OAuth to Docker '
                + 'registry is not yet supported, please "docker logout" '
                + 'and "docker login" and try again'));
            return;
        } else {
            username = regAuth.username;
            password = regAuth.password;
        }
    }

    function resMessage(data) {
        assert.string(data.type, 'data.type');
        if (data.type === 'progress') {
            assert.object(data.payload, 'data.payload');
        } else if (data.type === 'error') {
            assert.object(data.error, 'data.error');
        }
        data.id = req_id;
        res.write(JSON.stringify(data) + '\r\n');
    }

    var ctx = {
        alreadyExistsFromImgId: {},
        app: app,
        Image: opts.Image,
        image_uuid: image.image_uuid,
        imageFromImgUuid: {},  // <IMGAPI uuid> -> <IMGAPI image manifest>
        log: log,
        pushCancelled: false,
        rat: rat,
        regClient: null,
        regClientOpts: utils.commonHttpClientOpts({
            //insecure: app.config.dockerRegistryInsecure,
            insecure: true,
            log: log,
            repo: rat,
            username: username,
            password: password
        }, req),
        repoAndTag: repoAndTag,
        req: req,
        res: res,
        resMessage: resMessage
    };
    log.trace({rat: ctx.rat}, 'docker push');

    vasync.pipeline({funcs: [
        // Ensure the registry supports v2, otherwise we cannot push.
        function regSupportsV2(_, next) {
            var client = drc.createClientV2(ctx.regClientOpts);
            client.supportsV2(function (err, supportsV2) {
                if (err) {
                    next(err);
                } else {
                    log.info({indexName: rat.index.name,
                        supportsV2: supportsV2}, 'regSupportsV2');
                    if (!supportsV2) {
                        client.close();
                        next(new errors.NotAvailableError(format(
                            'registry %s does not support v2',
                            rat.index.name)));
                    } else {
                        ctx.regClient = client;
                        next();
                    }
                }
            });
        },

        /*
         * In *parallel*, upload image layers (blobs) to the docker registry.
         */
        function _pushDockerImageLayers(_, next) {
            var layerDigests = [];
            var layerInfos = manifest.layers.map(function (l) {
                layerDigests.push(l.digest);
                return {
                    digest: l.digest,
                    uuid: imgmanifest.imgUuidFromDockerDigests(layerDigests)
                };
            });
            var pushQueueError;
            var pushQueue = vasync.queue(function (layerInfo, nextImg) {
                log.debug({digest: layerInfo.digest, imageUuid: layerInfo.uuid},
                    'apiAdminPushDockerImage: pushing docker image');
                ctx.digest = layerInfo.digest;
                ctx.imageUuid = layerInfo.uuid;
                _pushOneDockerLayer(ctx, nextImg);
            }, 1);

            pushQueue.on('end', function () {
                next(pushQueueError);
            });

            pushQueue.push(layerInfos, function (qErr) {
                if (qErr) {
                    log.debug(qErr, '_pushDockerImages err');
                }
                // Take the first pushError and mark queue as cancelled.
                if (qErr && pushQueueError === undefined) {
                    pushQueueError = qErr;
                    ctx.pushCancelled = true;
                    pushQueue.kill();
                }
            });

            pushQueue.close();
        },

        // Push the docker image config layer.
        function _pushDockerConfigLayer(_, next) {
            var config = image.image;
            var configStr = JSON.stringify(config);
            // Check that the image has remained consistent, by verifying the
            // digest now to what it was initially created with.
            var configDigest = 'sha256:' + crypto.createHash('sha256')
                .update(configStr, 'binary').digest('hex');
            if (configDigest !== image.digest) {
                next(new errors.InvalidParameterError(
                    format('image config digest does not match: %s != %s',
                        configDigest, image.digest),
                    [ { field: 'digest', code: 'Invalid' } ]));
                return;
            }
            assert.equal(configDigest, image.digest,
                'Config sha256 should match image digest');
            var configBuf = Buffer.from(configStr, 'utf8');
            var stream = new Readable();
            stream.push(configBuf);
            stream.push(null);
            var blobOpts = {
                contentLength: configBuf.length,
                contentType: 'application/vnd.docker.container.image.v1+json',
                digest: configDigest,
                stream: stream
            };
            ctx.regClient.blobUpload(blobOpts, next);
        },

        // Push the docker image manifest.
        function _pushDockerManifest(_, next) {
            var manifestOpts = {
                log: log,
                manifest: manifestStr,
                ref: rat.tag
            };
            var size = manifestStr.length;

            ctx.regClient.putManifest(manifestOpts,
                    function (err, resp, digest) {
                if (err) {
                    next(err);
                    return;
                }
                resMessage({
                    type: 'progress',
                    payload:  {
                        status: format('%s: digest: %s size: %d',
                            rat.tag, digest, size)
                    }
                });
                resMessage({
                    type: 'progress',
                    payload:  {
                        progressDetail: {},
                        aux: {
                            Tag: rat.tag,
                            Digest: digest,
                            Size: size
                        }
                    }
                });
                next();
            });
        }

    ]}, function (err) {
        if (ctx.regClient) {
            ctx.regClient.close();
        }
        if (err) {
            // This is a chunked transfer so we can't return a restify error.
            log.info({err: err, repo: repoAndTag},
                'error pushing image layers, err: %j', err);
            resMessage({
                type: 'error',
                error: {
                    /*
                     * `restify.RestError` instances will have `err.code`. More
                     * vanilla `restify.HttpError` instances may have
                     * `err.body.code`.
                     */
                    code: err.code || (err.body && err.body.code),
                    message: err.message
                }
            });
        }
        log.debug('apiAdminPushDockerImage done - closing response');
        res.end();
        callback(false);
    });
}


/* BEGIN JSSTYLED */
/**
 * Import a given docker repo:tag while streaming out progress messages.
 * Typically this is called by the sdc-docker 'pull-image' workflow.
 *
 * Progress messages are one of the following (expanded here for clarity):
 *
 *      {
 *          "type":"status",
 *          // Used by the calling 'pull-image' workflow, and ultimately the
 *          // sdc-docker service to know which open client response this
 *          // belongs to.
 *          "id":"docker.io/busybox",
 *          // Per http://docs.docker.com/reference/api/docker_remote_api_v1.18/#create-an-image
 *          "payload":{"status":"Pulling repository busybox"}
 *      }
 *
 *      {"type":"progress","payload":{"id":"8c2e06607696","status":"Pulling dependent layers"},"id":"docker.io/busybox"}
 *      {"type":"progress","id":"docker.io/busybox","payload":{"id":"8c2e06607696","status":"Pulling metadata."}}
 *
 *      {
 *          "type":"create-docker-image",
 *          // Docker image. TODO: How used by caller?
 *          "image":{"container":"39e79119...
 *      }
 *
 *      {
 *          "type": "error",
 *          "error": {
 *              "code": "<CodeString>",
 *              "message": <error message>
 *          }
 *      }
 *
 * Dev Note: For now we only allow a single tag to be pulled. To eventually
 * support `docker pull -a ...` we'll likely want to support an empty `tag`
 * here to mean all tags.
 */
/* END JSSTYLED */
function adminImportDockerImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(opts.Image, 'opts.Image');
    assert.object(opts.req, 'opts.req');
    assert.object(opts.res, 'opts.res');
    assert.func(callback, 'callback');

    var req = opts.req;
    var res = opts.res;
    var log = req.log;

    // Validate inputs.
    var errs = [];
    var repo = req.query.repo;
    var tag = req.query.tag;
    var digest = req.query.digest;
    if (req.query.account) {
        return callback(new errors.OperatorOnlyError());
    }
    if (repo === undefined) {
        errs.push({ field: 'repo', code: 'MissingParameter' });
    }
    if (!tag && !digest) {
        errs.push({
            field: 'tag',
            code: 'MissingParameter',
            message: 'one of "tag" or "digest" is required'
        });
    } else if (tag && digest) {
        errs.push({
            field: 'digest',
            code: 'Invalid',
            message: 'cannot specify both "tag" and "digest"'
        });
    }
    if (errs.length) {
        log.debug({errs: errs}, 'apiAdminImportDockerImage error');
        return callback(new errors.ValidationFailedError(
            'missing parameters', errs));
    }

    var rat;
    try {
        rat = drc.parseRepoAndRef(
            repo + (tag ? ':'+tag : '@'+digest));
    } catch (e) {
        return callback(new errors.ValidationFailedError(
            e,
            e.message || e.toString(),
            [ {field: 'repo', code: 'Invalid'}]));
    }

    var regAuth;
    var username, password;
    if (req.headers['x-registry-config']) {
        /*
         * // JSSTYLED
         * https://github.com/docker/docker/blob/master/docs/reference/api/docker_remote_api_v1.23.md#build-image-from-a-dockerfile
         *
         * The 'x-registry-config' header is a map of the registry host name to
         * the registry auth (see 'x-registry-auth') below.
         */
        try {
            var regConfig = JSON.parse(new Buffer(
                req.headers['x-registry-config'], 'base64').toString('utf8'));
        } catch (e) {
            log.info(e, 'invalid x-registry-config header, ignoring');
        }
        // Censor for audit logs.
        req.headers['x-registry-config'] = '(censored)';

        // Find registry auth from the registry hostname map. Note that Docker
        // uses a special legacy name for the "official" docker registry, so
        // check for that too.
        if (regConfig) {
            var dockerV1CompatName = 'https://index.docker.io/v1/';
            var indexName = rat.index.name;
            if (regConfig.hasOwnProperty(indexName)) {
                regAuth = regConfig[indexName];
            } else if (indexName === 'docker.io' &&
                regConfig.hasOwnProperty(dockerV1CompatName))
            {
                regAuth = regConfig[dockerV1CompatName];
            }
        }
    }
    if (req.headers['x-registry-auth']) {
        /*
         * // JSSTYLED
         * https://github.com/docker/docker/blob/master/docs/reference/api/docker_remote_api_v1.23.md#create-an-image
         *
         * The 'x-registry-auth' header contains `username` and `password`
         * *OR* a `identitytoken`. We don't yet support identitytoken --
         * See DOCKER-771.
         */
        try {
            regAuth = JSON.parse(new Buffer(
                req.headers['x-registry-auth'], 'base64').toString('utf8'));
        } catch (e) {
            log.info(e, 'invalid x-registry-auth header, ignoring');
        }
        // Censor for audit logs.
        req.headers['x-registry-auth'] = '(censored)';
    }

    if (regAuth) {
        if (regAuth.identitytoken) {
            callback(new errors.NotImplementedError('OAuth to Docker '
                + 'registry is not yet supported, please "docker logout" '
                + 'and "docker login" and try again'));
            return;
        } else {
            username = regAuth.username;
            password = regAuth.password;
        }
    }

    try {
        var public_ = utils.boolFromString(req.query.public, true, 'public');
    } catch (publicErr) {
        return callback(publicErr);
    }

    function resMessage(data) {
        data.id = rat.canonicalName;
        res.write(JSON.stringify(data) + '\r\n');
    }

    var context = {
        Image: opts.Image,
        req: req,
        res: res,
        resMessage: resMessage,

        repoAndRef: rat.localName + (rat.tag ? ':'+rat.tag : '@'+rat.digest),
        rat: rat,
        regClientOpts: utils.commonHttpClientOpts({
            name: repo,
            log: req.log,
            insecure: req._app.config.dockerRegistryInsecure,
            acceptManifestLists: true,
            maxSchemaVersion: 2,
            username: username,
            password: password
        }, req),

        digestFromUuid: {},  // <uuid> -> <docker digest>
        newFileInfoFromUuid: {},  // <uuid> -> <file import info>
        public_: public_
    };
    log.trace({rat: context.rat}, 'docker pull');

    vasync.pipeline({arg: context, funcs: [
        /*
         * Use Docker Registry v2 to pull - v1 is no longer supported.
         *
         * Check v2.getManifest for the tag/digest. If it exists,
         * then we'll be using v2 for the pull, else error.
         */
        function v2GetManifest(ctx, next) {
            var ref = rat.tag || rat.digest;
            ctx.regClientV2 = drc.createClientV2(ctx.regClientOpts);
            ctx.regClientV2.getManifest({ref: ref},
                    function (err, manifest, res_, manifestStr) {
                if (err) {
                    next(errors.wrapErrorFromDrc(err));
                } else {
                    log.debug({ref: ref, manifest: manifest},
                        'v2.getManifest found');
                    ctx.manifestV2 = manifest;
                    ctx.manifestStr = manifestStr;
                    ctx.manifestDigest = res_.headers['docker-content-digest'];
                    if (!ctx.manifestDigest) {
                        // Some registries (looking at you Amazon ECR) do not
                        // provide the docker-content-digest header in the
                        // response, so we have to calculate it.
                        ctx.manifestDigest = drc.digestFromManifestStr(
                            manifestStr);
                    }
                    next();
                }
            });
        },

        /*
         * Handle manifest lists - select the appropriate manifest from the
         * list of possible platforms.
         */
        function handleV2ManifestList(ctx, next) {
            assert(ctx.manifestV2, 'ctx.manifestV2');
            var manifestV2 = ctx.manifestV2;

            if (manifestV2.mediaType !== drc.MEDIATYPE_MANIFEST_LIST_V2) {
                next();
                return;
            }

            // Note that drc.getManifest() verifies manifestV2.manifests, so
            // this should never be triggered.
            assert.arrayOfObject(manifestV2.manifests);

            // Find the linux-amd64 manifest.
            var match = manifestV2.manifests.find(function _maniFind(mani) {
                var p = mani.platform;
                return p && p.os === 'linux' && p.architecture === 'amd64';
            });
            if (!match) {
                var plats = manifestV2.manifests.map(function _maniMap(mani) {
                    return mani.platform && format('%s-%s', mani.platform.os,
                        mani.platform.architecture) || '<unknown>';
                });
                next(new errors.ValidationFailedError(
                    format('no linux-amd64 platform found in manifest list: %s',
                        plats),
                    [ {field: 'platform', code: 'Invalid'} ]));
                return;
            }

            // Fetch the actual v2 manifest.
            ctx.regClientV2.getManifest({ref: match.digest},
                    function (err, manifest, res_, manifestStr) {
                if (err) {
                    next(errors.wrapErrorFromDrc(err));
                    return;
                }
                log.debug({ref: match.digest, manifest: manifest},
                    'v2.getManifest from manifest list');
                ctx.manifestV2 = manifest;
                ctx.manifestStr = manifestStr;
                ctx.manifestDigest = res_.headers['docker-content-digest'];
                if (!ctx.manifestDigest) {
                    // Some registries (looking at you Amazon ECR) do not
                    // provide the docker-content-digest header in the
                    // response, so we have to calculate it.
                    ctx.manifestDigest = drc.digestFromManifestStr(
                        manifestStr);
                }
                next();
            });
        },

        /*
         * Determine if this is a private Docker image by trying the same
         * without auth. The only thing this does is determine `ctx.isPrivate`
         * so the caller (typically sdc-docker) can note that.
         * We still used the auth'd client for doing the image pull.
         *
         * Note: It is debatable whether we should bother with this. Is there
         * a need to have this 'isPrivate' boolean?
         */
        function determineIfPrivate(ctx, next) {
            if (!username) {
                ctx.isPrivate = false;
                return next();
            }

            var regClientOpts = utils.objCopy(ctx.regClientOpts);
            delete regClientOpts.username;
            delete regClientOpts.password;
            var noAuthClient;

            var ref = ctx.manifestDigest;
            noAuthClient = drc.createClientV2(regClientOpts);
            noAuthClient.getManifest({ref: ref}, function (err, man, res_) {
                if (err) {
                    if (err.statusCode === 404 ||
                        err.statusCode === 403 ||
                        err.statusCode === 401)
                    {
                        log.debug({ref: ref, code: err.code,
                            statusCode: err.statusCode}, 'isPrivate: true');
                        err = null;
                        ctx.isPrivate = true;
                    } else {
                        log.debug({ref: ref, code: err.code,
                            statusCode: err.statusCode},
                            'isPrivate: unexpected err code/statusCode');
                    }
                } else {
                    var noAuthDigest = res_.headers['docker-content-digest'];
                    assert.equal(noAuthDigest, ctx.manifestDigest);
                    ctx.isPrivate = false;
                }
                noAuthClient.close();
                next(errors.wrapErrorFromDrc(err));
            });
        },

        /*
         * Only now do we start the streaming response. This allows us
         * to do some sanity validation (we can talk to the registry and have
         * found an image for the given ref) and return a non-200 status code
         * on failure. I'm not sure this matches Docker Remote
         * API's behaviour exactly.
         */
        function startStreaming(ctx, next) {
            res.status(200);
            res.header('Content-Type', 'application/json');

            if (ctx.manifestV2.schemaVersion === 1) {
                ctx.dockerImageVersion = '2.1';
                _dockerV21Pull(ctx, next);
            } else if (ctx.manifestV2.schemaVersion === 2) {
                ctx.dockerImageVersion = '2.2';
                _dockerV22Pull(ctx, next);
            } else {
                next(new errors.NotImplementedError(
                    'unexpected manifest schemaVersion: %d',
                    ctx.manifestV2.schemaVersion));
                return;
            }
        }

    ]}, function (err) {
        if (context.regClientV2) {
            context.regClientV2.close();
        }

        if (err) {
            // This is a chunked transfer so we can't return a restify error.
            log.info(err, 'error pulling image layers for %s',
                context.repoAndRef);
            resMessage({
                type: 'error',
                id: repo,
                error: {
                    /*
                     * `restify.RestError` instances will have `err.code`. More
                     * vanilla `restify.HttpError` instances may have
                     * `err.body.code` (if the response body was JSON with a
                     * "code"), else the contructor name is a code.
                     */
                    code: err.code || (err.body && err.body.code) || err.name,
                    message: err.message
                }
            });
        }
        res.end();
        callback(false);
    });
}




//---- exports

module.exports = {
    adminImportDockerImage: adminImportDockerImage,
    adminPushDockerImage: adminPushDockerImage
};
