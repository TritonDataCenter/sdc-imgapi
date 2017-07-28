/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * IMGAPI abstracted handling for storage: storage of the (large) image
 * files in Manta, DCLS, or a local dir.
 */

var util = require('util');
var format = util.format;
var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var manta = require('manta');
var crypto = require('crypto');
var MemoryStream = require('memorystream');
var once = require('once');

var constants = require('./constants');
var errors = require('./errors');
var utils = require('./utils');


//---- base interface

/**
 * Create a storage handler.
 *
 * @params options {Object} with:
 *      - log {Bunyan Logger}
 *      - config {Object} The full IMGAPI config.
 */
function Storage(options) {
    this.type = null;
}

/**
 * Prepare storage for usage, if necessary.
 *
 * @param callback {Function} `function (err)`
 */
Storage.prototype.setup = function (callback) {
    callback();
};

/**
 * Return a writeable stream to storage for the image file for the given image.
 *
 * @param image {Image}
 * @param filename {string} Optional, defaults to file0
 * @param callback {Function} `function (err, stream)`
 */
Storage.prototype.createImageFileWriteStream =
        function createImageFileWriteStream(image, filename, callback) {
};

/**
 * Return a *paused* readable stream to storage for the image file for the given
 * image.
 *
 * @param image {Image}
 * @param filename {string} Optional, defaults to file0
 * @param opts {Object} Optional.
 *      - @param doNotPause {Boolean} Optional. Do not pause the read stream,
 *        default is false.
 * @param callback {Function} `function (err, stream)`
 */
Storage.prototype.createImageFileReadStream =
        function createImageFileReadStream(image, filename, opts, callback) {
};

/**
 * Delete the image file for the given image.
 *
 * @param image {Image}
 * @param filename {string} Optional, defaults to file0
 * @param callback {Function} `function (err)`
 */
Storage.prototype.deleteImageFile =
        function deleteImageFile(image, filename, callback) {
};

/**
 * Pipes the passed stream directly to an instance of a writable stream. This is
 * a higher level function for storage backends that take an input stream as an
 * argument (manta's put()).
 *
 * This function is typically used together with `moveImageFile`:
 * 1. `storeFileFromStream` will write to a temporary file name (which
 *    includes the given reqId to avoid two requests overwriting each other)
 * 2. `moveImageFile` will move from the `tmpFilename` to the final `filename`.
 *
 * @param opts {Object}
 *      - @param image {Image}
 *      - @param stream {ReadableStream} A *paused* input stream, e.g. a req
 *        object to 'AddImageFile'.
 *      - @param reqId {UUID} An identifier of this request. This is used
 *        in the returned `tmpFilename`.
 *      - @param filename {String} The base name of the file stored in this
 *        images storage dir. Typically this is either 'file0' or 'icon'.
 *      - @param type {String} Optional Content-Type string to pass to
 *        the storage backend, if applicable (e.g. this is used for Manta
 *        which holds a content-type).
 *      - @param size {Number} Optional Content-Length size for the upload.
 *        If given, it will be checked.
 *      - @param contentMD5 {String} Optional Content-MD5 of the file content.
 *        Per HTTP spec this is the *base64* digest of the MD5 checksum. If
 *        provided, this will be checked on upload.
 * @param callback {Function} `function (err, tmpFilename, filename)`
 */
Storage.prototype.storeFileFromStream =
    function storeFileFromStream(opts, callback) {
};

/**
 * Moves an image file from source to destination. This function is used
 * after `storeFileFromStream` to move a tmp file to its final destination.
 * If the tmp file was not uploaded correctly we won't overwrite a previous
 * working copy of an image file.
 *
 * @param image {Image}
 * @param from {String} Source filename
 * @param to {String} Destination filename
 * @param callback {Function} `function (err)`
 */
Storage.prototype.moveImageFile = function (image, from, to, callback) {};

/**
 * Moves an image file from one image to another image.
 *
 * @param fromImage {Image}
 * @param toImage {Image}
 * @param filename {String} Image filename (i.e. 'file0')
 * @param callback {Function} `function (err)`
 */
Storage.prototype.moveFileBetweenImages =
    function (fromImage, toImage, filename, callback) {
};


/**
 * Returns the archive path for image manifests. Image manifests are archived
 * with the following directory structure:
 *
 * /archive/$prefix/$uuid.json
 *
 * Where $prefix are the first 3 characters of a manifest UUID.
 *
 * @param uuid {UUID} Image UUID
 */
Storage.prototype._archivePathFromImageUuid = function (uuid) {};



//---- local storage

function LocalStorage(options) {
    assert.object(options.log, 'options.log');

    this.type = 'local';
    this.log = options.log.child({stor: this.type}, true);

    this.dir = constants.STORAGE_LOCAL_IMAGES_DIR;
    this.archiveDir = constants.STORAGE_LOCAL_ARCHIVE_DIR;

    assert.ok(this.dir && this.dir !== '/',
        'cannot have empty or root dir for local storage');
    assert.ok(this.archiveDir && this.archiveDir !== '/',
        'cannot have empty or root dir for local archive storage');
}
util.inherits(LocalStorage, Storage);

LocalStorage.prototype.setup = function (callback) {
    assert.func(callback, 'callback');
    var self = this;
    // Assumption for now: it is writable for us.
    self.log.info('mkdir -p %s', this.dir);
    mkdirp(self.dir, function (err) {
        if (err) {
            return callback(err);
        }
        self.log.info('mkdir -p %s', self.archiveDir);
        mkdirp(self.archiveDir, callback);
    });
};


/**
 * Returns the storage path for image files
 *
 * Note: This is not part of the `Storage` "interface". However it is made
 * public for usage by adm.js (i.e. `imgapiadm`).
 *
 * @param uuid {UUID} Image UUID
 * @param filename {string} Typically 'file0'.
 */
LocalStorage.prototype.storPathFromImageUuid = function (uuid, filename) {
    return path.resolve(this.dir, uuid.slice(0, 3), uuid, filename);
};


/**
 * Returns the archive path for image manifests. Image manifests are archived
 * with the following directory structure:
 *
 * /archive/$prefix/$uuid.json
 *
 * Where $prefix are the first 3 characters of a manifest UUID.
 *
 * @param uuid {UUID} Image UUID
 */
LocalStorage.prototype._archivePathFromImageUuid = function (uuid) {
    return path.resolve(this.archiveDir, uuid.slice(0, 3), uuid + '.json');
};


LocalStorage.prototype.createImageFileWriteStream =
        function (image, filename, callback) {
    assert.object(image, 'image');
    assert.string(image.uuid, 'image.uuid');
    if (callback === undefined) {
        callback = filename;
        filename = 'file0';
    }
    assert.func(callback, 'callback');

    var storPath = this.storPathFromImageUuid(image.uuid, filename);
    var storDir = path.dirname(storPath);
    mkdirp(storDir, function (err) {
        if (err) {
            return callback(err);
        }
        rimraf(storPath, function (err2) {
            if (err2) {
                return callback(err2);
            }
            var stream = fs.createWriteStream(storPath);
            callback(null, stream);
        });
    });
};

LocalStorage.prototype.createImageFileReadStream =
        function (image, filename, opts, callback) {
    assert.object(image, 'image');
    assert.string(image.uuid, 'image.uuid');
    if (opts === undefined) {
        callback = filename;
        filename = 'file0';
        opts = {};
    }
    if (callback === undefined) {
        callback = opts;
        opts = {};
    }
    assert.string(filename, 'filename');
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');

    var stream;
    try {
        var storPath = this.storPathFromImageUuid(image.uuid, filename);
        stream = fs.createReadStream(storPath);
    } catch (err) {
        return callback(err);
    }
    if (!opts.doNotPause) {
        utils.pauseStream(stream);
    }
    callback(null, stream);
};

LocalStorage.prototype.deleteImageFile = function (image, filename, callback) {
    assert.object(image, 'image');
    assert.string(image.uuid, 'image.uuid');
    if (callback === undefined) {
        callback = filename;
        filename = 'file0';
    }
    assert.func(callback, 'callback');

    var storPath = this.storPathFromImageUuid(image.uuid, filename);
    var storDir = path.dirname(storPath);
    this.log.debug({path: storPath}, 'unlink');
    fs.unlink(storPath, function (fErr) {
        if (fErr) {
            return callback(fErr);
        }
        fs.readdir(storDir, function (rErr, files) {
            if (rErr) {
                return callback(rErr);
            }
            if (files.length === 0) {
                fs.rmdir(storDir, callback);
            } else {
                return callback();
            }
        });
    });
};

LocalStorage.prototype.storeFileFromStream =
        function localStoreFileFromStream(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.image, 'opts.image');
    assert.object(opts.stream, 'opts.stream'); // paused
    assert.uuid(opts.reqId, 'opts.reqId');
    assert.string(opts.filename, 'opts.filename');
    assert.optionalNumber(opts.size, 'opts.size');
    assert.optionalString(opts.contentMD5, 'opts.contentMD5');
    assert.optionalBool(opts.noStreamErrorHandler, 'opts.noStreamErrorHandler');
    assert.func(callback, 'callback');
    var callbackOnce = once(callback);

    var tmpFilename = format('%s.%s', opts.filename, opts.reqId);

    var md5sum;
    var size;
    if (opts.contentMD5) {
        md5sum = crypto.createHash('md5');
    }
    if (opts.size !== undefined) {
        size = 0;
    }

    this.createImageFileWriteStream(opts.image, tmpFilename,
            function (sErr, output) {
        if (sErr) {
            onFileWriteStream(sErr);
            return;
        }

        if (!opts.noStreamErrorHandler) {
            opts.stream.on('error', function (err) {
                onFileWriteStream(err);
            });
        }

        if (opts.size !== undefined || opts.contentMD5) {
            opts.stream.on('data', function (chunk) {
                size += chunk.length;
                if (md5sum) {
                    md5sum.update(chunk, 'binary');
                }
            });
        }

        opts.stream.on('end', function () {
            output.end();
        });

        output.on('finish', function () {
            onFileWriteStream();
        });

        opts.stream.pipe(output);
        try {
            opts.stream.resume();
        } catch (streamErr) {
            callbackOnce(streamErr);
            return;
        }
    });

    function onFileWriteStream(err) {
        if (err) {
            callbackOnce(err);
            return;
        }

        if (opts.size !== undefined && size !== opts.size) {
            callbackOnce(new errors.DownloadError(format(
                'error downloading image %s file: downloaded %d bytes, '
                + 'expected %d', opts.image.uuid, size, opts.size)));
            return;
        }

        if (opts.contentMD5) {
            var contentMD5 = md5sum.digest('base64');
            if (contentMD5 !== opts.contentMD5) {
                callbackOnce(new errors.DownloadError(format(
                    'error downloading image %s file: downloaded Content-MD5 '
                    + 'is "%s", expected "%s"', opts.image.uuid, contentMD5,
                    opts.contentMD5)));
                return;
            }
        }

        return callbackOnce(null, tmpFilename, opts.filename);
    }
};

LocalStorage.prototype.storeFileFromFile =
    function (image, stream, filename, callback) {
    assert.object(image, 'image');
    assert.object(stream, 'stream');
    assert.string(filename, 'filename');
    assert.func(callback, 'callback');
    var callbackOnce = once(callback);

    var toPath = this.storPathFromImageUuid(image.uuid, filename);
    // Make sure we mkdir -p the destination directory
    var storDir = path.dirname(toPath);
    mkdirp(storDir, function (err) {
        if (err) {
            return callbackOnce(err);
        }
        rimraf(toPath, function (err2) {
            if (err2) {
                return callbackOnce(err2);
            }

            var toStream = fs.createWriteStream(toPath);

            toStream.on('close', function () {
                return callbackOnce();
            });

            toStream.on('error', function (err3) {
                return callbackOnce(err3);
            });

            stream.pipe(toStream);
            try {
                stream.resume();
            } catch (streamErr) {
                callbackOnce(streamErr);
                return;
            }
        });
    });
};


LocalStorage.prototype.moveImageFile = function (image, from, to, callback) {
    assert.object(image, 'image');
    assert.string(image.uuid, 'image.uuid');
    assert.string(from, 'from');
    assert.string(to, 'to');
    assert.func(callback, 'callback');

    var fromPath = this.storPathFromImageUuid(image.uuid, from);
    var toPath = this.storPathFromImageUuid(image.uuid, to);

    fs.rename(fromPath, toPath, function (err) {
        if (err) {
            return callback(err);
        }
        return callback(null);
    });
};


LocalStorage.prototype.moveFileBetweenImages =
function (fromImage, toImage, filename, callback) {
    assert.object(fromImage, 'fromImage');
    assert.uuid(fromImage.uuid, 'fromImage.uuid');
    assert.object(toImage, 'toImage');
    assert.uuid(toImage.uuid, 'toImage.uuid');
    assert.string(filename, 'filename');
    assert.func(callback, 'callback');

    var fromPath = this.storPathFromImageUuid(fromImage.uuid, filename);
    var toPath = this.storPathFromImageUuid(toImage.uuid, filename);

    var toDir = path.dirname(toPath);
    mkdirp(toDir, function (mkdirErr) {
        if (mkdirErr) {
            return callback(mkdirErr);
        }
        fs.rename(fromPath, toPath, function (err) {
            if (err) {
                return callback(err);
            }
            return callback(null);
        });
    });
};


LocalStorage.prototype.archiveImageManifest = function (manifest, callback) {
    assert.object(manifest, 'manifest');
    assert.string(manifest.uuid, 'manifest.uuid');
    assert.func(callback, 'callback');

    var archPath = this._archivePathFromImageUuid(manifest.uuid);
    var archDir = path.dirname(archPath);
    mkdirp(archDir, function (err) {
        if (err) {
            return callback(err);
        }
        rimraf(archPath, function (err2) {
            if (err2) {
                return callback(err2);
            }
            var serialized = JSON.stringify(manifest, null, 2);
            fs.writeFile(archPath, serialized, 'utf8', function (err3) {
                if (err3) {
                    return callback(err3);
                }
                callback();
            });
        });
    });
};


//---- manta storage

function MantaStorage(options) {
    assert.object(options.log, 'options.log');
    assert.object(options.config, 'options.config');
    var mantaConfig = options.config.manta;
    assert.object(mantaConfig, 'options.config.manta');
    assert.string(mantaConfig.url, 'options.config.manta.url');
    assert.string(mantaConfig.user, 'options.config.manta.user');
    assert.string(mantaConfig.key, 'options.config.manta.key');
    assert.string(mantaConfig.keyId, 'options.config.manta.keyId');
    assert.optionalBool(mantaConfig.insecure, 'options.config.manta.insecure');
    assert.string(mantaConfig.rootDir, 'options.config.manta.rootDir');

    this.type = 'manta';
    this.log = options.log.child({stor: this.type}, true);

    // Manta variables
    this.url = mantaConfig.url;
    this.user = mantaConfig.user;
    this.dir = path.join(mantaConfig.rootDir, 'images');
    this.archiveDir = path.join(mantaConfig.rootDir, 'archive');
    var insecure = mantaConfig.hasOwnProperty('insecure')
        ? mantaConfig.insecure : false;
    this.client = manta.createClient({
        log: this.log,
        sign: {
            key: mantaConfig.key,
            keyId: mantaConfig.keyId,
            user: this.user
        },
        user: this.user,
        url: this.url,
        // manta.createClient doesn't take 'insecure' currently
        // (manta.createBinClient *does*).
        rejectUnauthorized: !insecure
    });
}
util.inherits(MantaStorage, Storage);

MantaStorage.prototype.setup = function setup(callback) {
    assert.func(callback, 'callback');
    // Succeeed here, lazily mkdir -p when storing or reading files.
    // Assumption for now: it is writable for us.
    return callback();
};

MantaStorage.prototype._storPathFromImageUuid = function (uuid, filename) {
    return path.resolve(this.dir, uuid.slice(0, 3), uuid, filename);
};

/**
 * Returns the archive path for image manifests. Image manifests are archived
 * with the following directory structure:
 *
 * /imgapi-archive/$dcname/$prefix/$uuid.json
 *
 * Where $prefix are the first 3 characters of a manifest UUID.
 *
 * @param uuid {UUID} Image UUID
 */
MantaStorage.prototype._archivePathFromImageUuid = function (uuid) {
    return path.resolve(this.archiveDir, uuid.slice(0, 3), uuid + '.json');
};

/*
 * In manta we don't create a writable stream but we still need the path to
 * write to, that's why the 2nd argument to the callback is a path and not a
 * stream object. Also, we don't need a 'rimraf' equivalent because manta.put()
 * is an overwrite.
 */
MantaStorage.prototype.createImageFileWriteStream =
        function (image, filename, callback) {
    assert.object(image, 'image');
    assert.string(image.uuid, 'image.uuid');
    if (callback === undefined) {
        callback = filename;
        filename = 'file0';
    }
    assert.func(callback, 'callback');

    var storPath = this._storPathFromImageUuid(image.uuid, filename);
    var storDir = path.dirname(storPath);
    this.client.mkdirp(storDir, function (err) {
        if (err) {
            return callback(err);
        }
        callback(null, storPath);
    });
};


MantaStorage.prototype.storeFileFromStream =
        function mantaStoreFileFromStream(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.image, 'opts.image');
    assert.object(opts.stream, 'opts.stream');
    assert.uuid(opts.reqId, 'opts.reqId');
    assert.string(opts.filename, 'opts.filename');
    assert.optionalString(opts.type, 'opts.type');
    assert.optionalNumber(opts.size, 'opts.size');
    assert.optionalString(opts.contentMD5, 'opts.contentMD5');
    assert.func(callback, 'callback');

    var self = this;
    var tmpFilename = format('%s.%s', opts.filename, opts.reqId);

    self.createImageFileWriteStream(opts.image, tmpFilename,
            function (sErr, aPath) {
        if (sErr) {
            onFileWriteStream(sErr);
            return;
        }

        var putOpts = {};
        if (opts.type !== undefined) { putOpts.type = opts.type; }
        if (opts.size !== undefined) { putOpts.size = opts.size; }
        if (opts.contentMD5 !== undefined) { putOpts.md5 = opts.contentMD5; }
        self.client.put(aPath, opts.stream, putOpts, onFileWriteStream);
    });

    function onFileWriteStream(err) {
        if (err) {
            callback(err);
            return;
        }

        return callback(null, tmpFilename, opts.filename);
    }
};


MantaStorage.prototype.exportImageManifest =
function (string, storPath, callback) {
    var self = this;
    var stream = new MemoryStream();
    var opts = {
        md5: crypto.createHash('md5').update(string, 'utf8').digest('base64'),
        size: Buffer.byteLength(string),
        type: 'application/json'
    };

    self.client.put(storPath, stream, opts, callback);
    stream.end(string);
};

MantaStorage.prototype.snapLinkImageFile =
function (image, toPath, callback) {
    assert.object(image, 'image');
    assert.string(image.uuid, 'image.uuid');
    assert.string(toPath, 'toPath');
    assert.func(callback, 'callback');

    var fromPath = this._storPathFromImageUuid(image.uuid, 'file0');
    this.client.ln(fromPath, toPath, callback);
};

MantaStorage.prototype.createImageFileReadStream =
        function (image, filename, opts, callback) {
    assert.object(image, 'image');
    assert.string(image.uuid, 'image.uuid');
    if (opts === undefined) {
        callback = filename;
        filename = 'file0';
        opts = {};
    }
    if (callback === undefined) {
        callback = opts;
        opts = {};
    }
    assert.string(filename, 'filename');
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');

    var storPath = this._storPathFromImageUuid(image.uuid, filename);
    this.client.get(storPath, function (err, stream, res) {
        if (err) {
            callback(err);
            return;
        }
        utils.pauseStream(stream);
        callback(null, stream);
    });
};

MantaStorage.prototype.deleteImageFile =
        function (image, filename, callback) {
    assert.object(image, 'image');
    assert.string(image.uuid, 'image.uuid');
    if (callback === undefined) {
        callback = filename;
        filename = 'file0';
    }
    assert.func(callback, 'callback');

    var storPath = this._storPathFromImageUuid(image.uuid, filename);
    var storDir = path.dirname(storPath);
    var self = this;
    self.log.debug({path: storPath}, 'unlink');
    self.client.unlink(storPath, function (fErr) {
        if (fErr) {
            return callback(fErr);
        }

        self.client.ls(storDir, function (lsErr, res) {
            if (lsErr) {
                return callback(lsErr);
            }

            var found = 0;
            res.on('object', function (obj) {
                found++;
            });
            res.on('directory', function (dir) {
                found++;
            });
            // Only remove directory if it's empty
            res.once('end', function () {
                if (found > 0) {
                    return callback();
                }

                self.client.rmr(storDir, function (rmErr) {
                    if (rmErr) {
                        return callback(rmErr);
                    }
                    return callback();
                });
            });
        });
    });
};


MantaStorage.prototype.moveImageFile = function (image, from, to, callback) {
    assert.object(image, 'image');
    assert.string(image.uuid, 'image.uuid');
    assert.string(from, 'from');
    assert.string(to, 'from');
    assert.func(callback, 'callback');

    var fromPath = this._storPathFromImageUuid(image.uuid, from);
    var toPath = this._storPathFromImageUuid(image.uuid, to);

    var self = this;
    self.client.ln(fromPath, toPath, function (err) {
        if (err) {
            return callback(err);
        }

        self.deleteImageFile(image, from, function (delErr) {
            if (delErr) {
                return callback(delErr);
            }
            return callback();
        });
    });
};

MantaStorage.prototype.moveFileBetweenImages =
function (fromImage, toImage, filename, callback) {
    assert.object(fromImage, 'fromImage');
    assert.uuid(fromImage.uuid, 'fromImage.uuid');
    assert.object(toImage, 'toImage');
    assert.uuid(toImage.uuid, 'toImage.uuid');
    assert.string(filename, 'filename');
    assert.func(callback, 'callback');

    var fromPath = this._storPathFromImageUuid(fromImage.uuid, filename);
    var toPath = this._storPathFromImageUuid(toImage.uuid, filename);
    var toDir = path.dirname(toPath);

    var self = this;

    self.client.mkdirp(toDir, function (mkdirErr) {
        if (mkdirErr) {
            return callback(mkdirErr);
        }
        self.client.ln(fromPath, toPath, function (err) {
            if (err) {
                return callback(err);
            }

            self.deleteImageFile(fromImage, filename, function (delErr) {
                if (delErr) {
                    return callback(delErr);
                }
                return callback();
            });
        });
    });
};

MantaStorage.prototype.archiveImageManifest =
function (manifest, callback) {
    assert.object(manifest, 'manifest');
    assert.string(manifest.uuid, 'manifest.uuid');
    assert.func(callback, 'callback');

    var self = this;
    var stream = new MemoryStream();
    var archPath = self._archivePathFromImageUuid(manifest.uuid);
    var archDir = path.dirname(archPath);

    self.client.mkdirp(archDir, function (err) {
        if (err) {
            return callback(err);
        }

        var serialized = JSON.stringify(manifest, null, 2);
        var opts = {
            md5: crypto.createHash('md5').update(serialized, 'utf8')
                    .digest('base64'),
            size: Buffer.byteLength(serialized),
            type: 'application/json'
        };

        self.client.put(archPath, stream, opts, callback);
        stream.end(serialized);
    });
};


//---- exports

module.exports = {
    local: LocalStorage,
    manta: MantaStorage
};
