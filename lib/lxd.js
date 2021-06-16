/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

/*
 * IMGAPI lxd images.
 */

var crypto = require('crypto');
var util = require('util'),
    format = util.format;

var assert = require('assert-plus');
var jsprim = require('jsprim');
var once = require('once');
var vasync = require('vasync');

var constants = require('./constants');
var errors = require('./errors');
var lxdclient = require('./lxdclient');


//---- globals

function sanitizeManifestName(name) {
    assert.string(name, 'name');

    return name.replace(/[^0-9a-zA-Z-_./ ]/g, '_');
}

function sanitizeManifestVersion(version) {
    assert.string(version, 'version');

    return version.replace(/[^0-9a-zA-Z-_./+]/g, '_');
}


/**
 * Return a uuid from the given sha256 string.
 */
function uuidFromSha256(sha256) {
    assert.string(sha256, 'sha256');
    assert.ok(sha256.length >= 32);
    return (sha256.slice(0, 8) +
        '-' + sha256.slice(8, 12) +
        '-' + sha256.slice(12, 16) +
        '-' + sha256.slice(16, 20) +
        '-' + sha256.slice(20, 32));
}


function versionToDate(version) {
    assert.string(version, 'version');
    assert.ok(version.length >= 8);

    return new Date(Date.parse(
        version.substr(0, 4) + '-' +
        version.substr(4, 2) + '-' +
        version.substr(6, 2)));
}


/**
 * Make an IMGAPI image manifest from lxd "image" object.
 *
 * @param img {Object} The lxd image object.
 * @param opts {Object}
 *      - repo {Object} The URL of where this image came from.
 *      - owner {String} Optional.
 *      - public {Boolean} Optional. Defaults to true.
 *      - tags {String} Optional.
 */
function imgManifestFromImg(img, opts) {
    assert.object(img, 'img');
    opts = opts || {};
    assert.optionalObject(opts, 'opts');
    assert.optionalString(opts.repo, 'opts.repo');
    assert.optionalString(opts.owner, 'opts.owner');
    assert.optionalBool(opts.public, 'opts.public');

    var bestFile = img.bestFile;
    var createdDate = versionToDate(img.chosenVersion);
    var manifestFile = img.manifestFile;

    // Generate the root filesystem layer.
    var imgManifest = {
        v: 2,
        description: img.fullname,
        disabled: false,
        name: sanitizeManifestName(img.pubname || img.fullname),
        os: 'linux',
        owner: opts.owner || '00000000-0000-0000-0000-000000000000',
        public: opts.public && true || false,
        published_at: createdDate.toISOString(),
        requirements: {
            brand: 'lx'
        },
        tags: {
            'lxd:arch': img.arch,
            'lxd:aliases': img.aliases,
            'lxd:fingerprint': manifestFile.fingerprint,
            'lxd:ftype': bestFile.ftype,
            'lxd:name': img.pubname || img.fullname,
            'lxd:os': img.os,
            'lxd:path': manifestFile.path,
            'lxd:release': img.release,
            'lxd:release_title': img.release_title,
            'lxd:repo': opts.repo,
            'lxd:sha256': manifestFile.sha256
        },
        type: 'lxd',
        uuid: uuidFromSha256(manifestFile.fingerprint),
        version: sanitizeManifestVersion(img.chosenVersion)
    };

    return imgManifest;
}


function compressionFromFiletype(ftype) {
    if (ftype.endsWith('.xz')) {
        return 'xz';
    }
    if (ftype.endsWith('.gz')) {
        return 'gzip';
    }
    if (ftype.endsWith('.bz2')) {
        return 'bzip2';
    }
    return '';
}

/*
 * Called during `adminImportLxdImage` to create (unactivated) and
 * download the file for a single type=lxd image.
 *
 * Note that if this function returns an error that is a DownloadError instance,
 * the caller can schedule a retry of the download, whilst any other error
 * indicates that the caller should not retry the download.
 *
 * @param manifest {Object} Imgapi image manifest.
 * @param opts {Object}
 *      - @param img {Object} Lxd image object (config, rootfs, layers).
 *      - @param opts {Object} options for the import.
 * @param callback {Function}
 */
function lxdDownloadAndImportImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.imgManifest, 'opts.imgManifest');
    assert.object(opts.imgManifest.tags, 'opts.imgManifest.tags');
    assert.string(opts.imgManifest.tags['lxd:path'],
        'opts.imgManifest.tags["lxd:path"]');
    assert.string(opts.imgManifest.tags['lxd:sha256'],
        'opts.imgManifest.tags["lxd:sha256"]');
    assert.func(opts.Image, 'opts.Image');
    assert.object(opts.img, 'opts.img');
    assert.object(opts.parsedAlias, 'opts.parsedAlias');
    assert.string(opts.parsedAlias.full, 'opts.parsedAlias.full');
    assert.object(opts.registryClient, 'opts.registryClient');
    assert.object(opts.req, 'opts.req');
    assert.func(opts.resMessage, 'opts.resMessage');
    assert.func(callback, 'callback');

    var img = opts.img;
    var manifest = opts.imgManifest;
    var parsedAlias = opts.parsedAlias;
    var req = opts.req;
    var app = req._app;
    var log = req.log;
    var fileSize = -1;
    var newImage;
    var uuid = manifest.uuid;

    function progressStatus(msg, progressDetail) {
        var payload = {
            id: parsedAlias.full,
            status: msg
        };
        if (progressDetail) {
            payload.progressDetail = progressDetail;
        }
        opts.resMessage({
            type: 'progress',
            payload: payload
        });
    }

    log.debug({uuid: uuid, parsedAlias: parsedAlias},
        'lxdDownloadAndImportImage: check if the image already exists');
    opts.Image.get(app, uuid, log, function (gErr, image) {
        if (!gErr) {
            assert.object(image, 'image');

            if (image.state !== 'unactivated') {
                // When the image already exists, just return the image as is.
                log.debug({uuid: uuid, parsedAlias: parsedAlias},
                    'lxdDownloadAndImportImage: image already exists');
                progressStatus('Already exists');
                callback(null, image);
                return;
            }

            // Mark this Image as existing in the database
            log.debug({uuid: uuid, parsedAlias: parsedAlias},
                'lxdDownloadAndImportImage: image exists, but is unactivated');
            newImage = image;

        } else if (gErr.restCode !== 'ResourceNotFound') {
            return callback(gErr);
        }

        log.debug({uuid: uuid, parsedAlias: parsedAlias},
            'lxdDownloadAndImportImage: start import');

        vasync.pipeline({ arg: {}, funcs: [
            handleOwner,
            handleChannels,
            createImgapiImage,
            addManifestFile,
            addRootFsFile
        ]}, function afterPipe(pipeErr) {
            if (pipeErr) {
                callback(pipeErr);
                return;
            }
            progressStatus('Download complete');
            callback(null, newImage);
        });
    });

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

    function createImgapiImage(_, next) {
        if (newImage) {
            next();
            return;
        }

        log.debug({ data: manifest },
            'lxdDownloadAndImportImage: create it');
        opts.Image.create(app, manifest, true, false, function (cErr, imgM) {
            if (cErr) {
                next(cErr);
                return;
            }

            newImage = imgM;
            next();
        });
    }

    function addImageFile(imgapiFilename, stream, imgFile, next) {
        log.debug({parsedAlias: parsedAlias}, 'AddImageFile: start');

        var connectionTimeoutHandler;
        var expectedSha256 = imgFile.sha256;
        var READ_STREAM_TIMEOUT = 15 * 1000;
        // Send a progress message whenever we've downloaded at least
        // `progUpdateEvery` data (i.e. every 1/2 MiB).
        var progLastUpdateSize = 0;
        var progUpdateEvery = 512 * 1024;
        var md5sum = crypto.createHash('md5');
        var shasum = crypto.createHash('sha1');
        var sha256sum = crypto.createHash('sha256');
        var size = 0;
        var startTs = Math.floor(new Date().getTime() / 1000);
        var stor;  // the storage class

        progressStatus('Downloading image');

        function finish_(fErr, tmpFilename, filename) {
            // Remove connection timeout handler.
            stream.connection.removeListener('timeout',
                connectionTimeoutHandler);
            connectionTimeoutHandler = null;

            if (fErr) {
                log.info({parsedAlias: parsedAlias, err: fErr},
                    'lxdDownloadAndImportImage: error');
                return next(fErr);
            }

            var md5 = md5sum.digest('base64');
            var sha1 = shasum.digest('hex');
            var sha256 = sha256sum.digest('hex');

            // Validate the sha256 of the downloaded bits matches the
            // digest, if they don't match there is a corruption.
            if (sha256 !== expectedSha256) {
                // Note that we don't cleanup the failed image file download,
                // that is handled by IMGAPI-616.
                log.warn({sha256: sha256, expectedSha256: expectedSha256},
                    'Downloaded layer digest does not match');
                next(new errors.DownloadError(format(
                    'sha256 digest does not match, received %s, expected %s',
                    sha256, expectedSha256)));
                return;
            }

            var compression = compressionFromFiletype(imgFile.path);

            var file = {
                contentMD5: md5,
                sha1: sha1,
                sha256: sha256,
                size: size,
                mtime: (new Date()).toISOString(),
                stor: stor.type,
                compression: compression
            };

            if (!Array.isArray(newImage.newFileInfo)) {
                newImage.newFileInfo = [];
            }
            newImage.newFileInfo.push({
                file: file,
                storage: stor.type,
                tmpFilename: tmpFilename,
                filename: filename
            });

            log.info({parsedAlias: parsedAlias, fileSize: fileSize},
                'lxdDownloadAndImportImage: Download successful');
            return next();
        }
        var finish = once(finish_);

        // Setup a response timeout listener to handle connection timeout.
        assert.object(stream.connection, 'stream.connection');
        stream.connection.setTimeout(READ_STREAM_TIMEOUT);
        connectionTimeoutHandler = function onConnectionTimeout() {
            log.info({parsedAlias: parsedAlias, size: size, fileSize: fileSize},
                'lxdDownloadAndImportImage: image stream connection timed out');
            progressStatus('Connection timed out');
            stream.destroy();
            finish(new errors.DownloadError('Image connection timed out'));
        };
        stream.connection.on('timeout', connectionTimeoutHandler);

        stream.on('data', function (chunk) {
            size += chunk.length;
            if (size > constants.MAX_IMAGE_SIZE) {
                finish(new errors.DownloadError(format(
                    'Download error: image file size exceeds the ' +
                    'maximum allowed size, %s', constants.MAX_IMAGE_SIZE_STR)));
            }
            md5sum.update(chunk, 'binary');
            shasum.update(chunk, 'binary');
            sha256sum.update(chunk, 'binary');

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
            finish(streamErr);
        });

        stor = app.chooseStor(newImage);
        stor.storeFileFromStream({
            image: newImage,
            stream: stream,
            reqId: stream.id(),
            filename: imgapiFilename,
            noStreamErrorHandler: true
        }, function (sErr, tmpFilename, filename) {
            if (sErr) {
                log.error({err: sErr, parsedAlias: parsedAlias},
                    'error storing image file');
                finish(errors.parseErrorFromStorage(
                    sErr, 'error receiving image file'));
            } else {
                finish(null, tmpFilename, filename);
            }
        });
    }

    function addManifestFile(_, next) {
        var fpath = img.manifestFile.path;

        opts.registryClient.getFileStreamForPath(fpath,
                function onStreamCb(err, stream) {
            if (err) {
                next(err);
                return;
            }

            addImageFile('file0', stream, img.manifestFile, next);
        });
    }

    function addRootFsFile(_, next) {
        if (lxdclient.isCombinedImage(img)) {
            // The manifest also contains the root fs.
            next();
            return;
        }

        var fpath = img.bestFile.path;

        opts.registryClient.getFileStreamForPath(fpath,
                function onStreamCb(err, stream) {
            if (err) {
                next(err);
                return;
            }

            addImageFile('file1', stream, img.bestFile, next);
        });
    }
}


/*
 * Activate the given lxd imgapi image.
 */
function activateLxdImage(newImage, ctx, callback) {
    assert.object(ctx, 'ctx');
    assert.object(ctx.parsedAlias, 'ctx.parsedAlias');
    assert.string(ctx.parsedAlias.full, 'ctx.parsedAlias.full');
    assert.string(ctx.parsedAlias.image, 'ctx.parsedAlias.image');
    assert.string(ctx.parsedAlias.repo, 'ctx.parsedAlias.repo');
    assert.object(ctx.registryClient, 'ctx.registryClient');
    assert.object(ctx.req, 'ctx.req');
    assert.func(ctx.resMessage, 'ctx.resMessage');
    assert.func(callback, 'callback');

    var req = ctx.req;
    var resMessage = ctx.resMessage;
    var app = req._app;
    var log = req.log;
    var parsedAlias = ctx.parsedAlias;

    // If newFileInfo exists, it means a file object was downloaded for this
    // image, else the file object (and possibly the image manifest) already
    // existed in imgapi storage.
    var newFileInfo = newImage.newFileInfo;
    var hasNewFiles = Array.isArray(newFileInfo) && newFileInfo.length;
    delete newImage.newFileInfo;

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

        if (hasNewFiles) {
            resMessage({
                type: 'progress',
                payload: {
                    id: parsedAlias.full,
                    status: 'Pull complete'
                }
            });
        }

        callback();
    });

    function archiveManifest(_, next) {
        if (!hasNewFiles) {
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
        if (!hasNewFiles) {
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

        log.debug({parsedAlias: parsedAlias}, 'finishMoveImageLayer');

        var filePos = -1;

        vasync.forEachPipeline({inputs: newFileInfo,
            func: function _eachFile(fileInfo, nextFile) {
                var stor = app.getStor(fileInfo.storage);
                stor.moveImageFile(newImage, fileInfo.tmpFilename,
                        fileInfo.filename,
                        function (mErr) {
                    if (mErr) {
                        nextFile(mErr);
                        return;
                    }

                    filePos += 1;
                    newImage.addFile(app, fileInfo.file, req.log, filePos,
                            function _onImgapiAddFileCb(err) {
                        if (err) {
                            req.log.error(err,
                                'error adding file info to Image');
                            nextFile(new errors.InternalError(err,
                                'could not save image'));
                            return;
                        }

                        nextFile();
                    });
                });
        }}, next);
    }

    function activateImage(_, next) {
        if (newImage.activated) {
            next();
            return;
        }

        resMessage({
            type: 'progress',
            payload: {
                id: parsedAlias.full,
                status: 'Activating image'
            }
        });

        newImage.activate(app, req.log, next);
    }
}

function parseLxdImageAlias(fullAlias) {
    var errs = [];

    if (!fullAlias) {
        errs.push({ field: 'alias', code: 'MissingParameter' });
        return new errors.ValidationFailedError(
            'missing parameters', errs);
    }

    var idx = fullAlias.indexOf(':');
    if (idx === -1) {
        errs.push({ field: 'alias', code: 'InvalidParameter' });
        return new errors.InvalidParameterError(
            'alias must include a semicolon', errs);
    }

    var repo = fullAlias.substr(0, idx);
    var image = fullAlias.substr(idx+1);

    return {
        full: fullAlias,
        image: image,
        repo: repo
    };
}


/* BEGIN JSSTYLED */
/**
 * Import a given lxd image/alias while streaming out progress messages.
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
 */
/* END JSSTYLED */
function adminImportLxdImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(opts.Image, 'opts.Image');
    assert.object(opts.req, 'opts.req');
    assert.object(opts.res, 'opts.res');
    assert.func(callback, 'callback');

    var req = opts.req;
    var res = opts.res;
    var app = req._app;
    var log = req.log;
    var alias = req.query.alias;

    var lxdRegistries = app.config.lxdRegistries;
    if (!lxdRegistries) {
        lxdRegistries = lxdclient.DEFAULT_REGISTRIES;
    }

    if (req.query.account) {
        callback(new errors.OperatorOnlyError());
        return;
    }

    // Validate inputs.
    var parsedAlias = parseLxdImageAlias(alias);
    if (parsedAlias instanceof errors.ValidationFailedError) {
        callback(parsedAlias);
        return;
    }

    // TODO: Come up with a messaging system.
    function resMessage(data) {
        data.alias = alias;
        res.write(JSON.stringify(data) + '\r\n');
    }

    var ctx = {
        Image: opts.Image,
        img: null, // Lxd image - set in findImageFromAlias()
        parsedAlias: parsedAlias,
        registryClient: null, // Set in chooseLxdClient()
        req: req,
        res: res,
        resMessage: resMessage
    };
    log.trace({alias: parsedAlias}, 'lxd import image');

    vasync.pipeline({funcs: [
        function chooseLxdClient(_, next) {
            var registryKeys = Object.keys(lxdRegistries);
            var registryName = registryKeys.find(
                function _findReg(repo) {
                    return repo === parsedAlias.repo;
                });

            if (!registryName) {
                next(new errors.InvalidParameterError(format(
                    'No registry found for "%s" - valid registries are "%s"',
                    parsedAlias.repo, registryKeys.join(', ')),
                    [ { field: 'alias', code: 'Invalid' } ]));
                return;
            }

            var clientConfig = {
                log: log,
                url: lxdRegistries[registryName]
            };
            ctx.registryClient = new lxdclient.LxdClient(clientConfig);

            next();
        },

        // Find the matching lxd image for the given alias.
        function findImageFromAlias(_, next) {
            ctx.registryClient.getImage(parsedAlias.image,
                    function _onLookupAliasCb(err, img) {
                if (err) {
                    next(err);
                    return;
                }

                log.debug({img: img, alias: parsedAlias},
                    'Found image for alias');

                // Verify that the file isn't too large.
                var fileSize = img.bestFile.size;
                if (fileSize > constants.MAX_IMAGE_SIZE) {
                    // Using ImageFileTooBigError instead of DownloadError so
                    // the caller doesn't retry to download.
                    next(new errors.ImageFileTooBigError(format(
                        'Image file size, %s, exceeds the max allowed file ' +
                        'size, %s', fileSize, constants.MAX_IMAGE_SIZE_STR)));
                    return;
                }

                ctx.img = img;
                next();
            });
        },

        function generateManifest(_, next) {
            try {
                ctx.imgManifest = imgManifestFromImg(ctx.img, {
                    repo: parsedAlias.repo,
                    public: false
                });
            } catch (e) {
                log.warn('Error generating imgapi manifest: %s', e);
                next(new errors.InternalError(e,
                    'could not convert lxd image into an imgapi manifest'));
                return;
            }

            next();
        },

        /*
         * Only now do we start the streaming response. We've done some sanity
         * validation (i.e. we can talk to the registry and have found an image
         * for the given alias) so we return a 200 status code and any future
         * failures will be reported back through the streaming response.
         */
        function downloadAndActivateLxdImage(_, next) {
            res.status(200);
            res.header('Content-Type', 'application/json');

            lxdDownloadAndImportImage(ctx, function _onDownload(err, image) {
                if (err) {
                    next(err);
                    return;
                }
                activateLxdImage(image, ctx, next);
            });
        }

    ]}, function (err) {
        if (err) {
            // This is a chunked transfer so we can't return a restify error.
            resMessage({
                type: 'error',
                id: alias,
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
    adminImportLxdImage: adminImportLxdImage
};
