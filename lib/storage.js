/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
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


//---- base interface

/**
 * Create a storage handler.
 *
 * @params options {Object} with:
 *      - log {Bunyan Logger}
 *      - config {Object} The relevant section from the IMGAPI config.
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
 * Return a readable stream to storage for the image file for the given image.
 *
 * @param image {Image}
 * @param filename {string} Optional, defaults to file0
 * @param callback {Function} `function (err, stream)`
 */
Storage.prototype.createImageFileReadStream =
        function createImageFileReadStream(image, filename, callback) {
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
 * argument (manta's put())
 *
 * @param image {Image}
 * @param stream {ReadableStream} Input stream, normally a req object
 * @param callback {Function} `function (err)`
 */
Storage.prototype.storeFileFromStream =
    function storeFileFromStream(image, stream, filename, callback) {
};

/**
 * Moves an image file from source to destination. This function is used by
 * `storeFileFromStream` to move a tmp file to its real destination. If the
 * tmp file was not uploaded correctly we won't overwrite a previous working
 * copy of an image file
 *
 * @param image {Image}
 * @param from {String} Source filename
 * @param to {String} Destination filename
 * @param callback {Function} `function (err)`
 */
Storage.prototype.moveImageFile = function (image, from, to, callback) {};


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
    assert.object(options.config, 'options.config');
    var config = options.config;
    assert.string(config.baseDir, 'options.config.baseDir');

    this.type = 'local';
    this.log = options.log.child({stor: this.type}, true);

    this.baseDir = path.resolve(config.baseDir);
    this.dir = path.join(this.baseDir, 'images');
    this.archiveDir = path.join(this.baseDir, 'archive');

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
 * @param uuid {UUID} Image UUID
 * @param filename {string} defaults to 'file0' if not specified
 */
LocalStorage.prototype._storPathFromImageUuid = function (uuid, filename) {
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

    var storPath = this._storPathFromImageUuid(image.uuid, filename);
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
        function (image, filename, callback) {
    assert.object(image, 'image');
    assert.string(image.uuid, 'image.uuid');
    if (callback === undefined) {
        callback = filename;
        filename = 'file0';
    }
    assert.func(callback, 'callback');

    var stream;
    try {
        var storPath = this._storPathFromImageUuid(image.uuid, filename);
        stream = fs.createReadStream(storPath);
    } catch (err) {
        return callback(err);
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

    var storPath = this._storPathFromImageUuid(image.uuid, filename);
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
    function (image, stream, filename, callback) {
    var tmpName = format('%s.%s', filename, stream.id());

    this.createImageFileWriteStream(image, tmpName, function (sErr, output) {
        if (sErr) {
            onFileWriteStream(sErr);
            return;
        }

        stream.on('error', function (err) {
            onFileWriteStream(err);
        });

        stream.on('end', function () {
            output.end();
        });

        output.on('finish', function () {
            onFileWriteStream();
        });

        stream.pipe(output);
        stream.resume(); // Was paused in `server.pre`.
    });

    function onFileWriteStream(err) {
        if (err) {
            callback(err);
            return;
        }

        return callback(null, tmpName, filename);
    }
};

LocalStorage.prototype.storeFileFromFile =
    function (image, stream, filename, callback) {
    var toPath = this._storPathFromImageUuid(image.uuid, filename);
    // Make sure we mkdir -p the destination directory
    var storDir = path.dirname(toPath);
    mkdirp(storDir, function (err) {
        if (err) {
            return callback(err);
        }
        rimraf(toPath, function (err2) {
            if (err2) {
                return callback(err2);
            }

            var toStream = fs.createWriteStream(toPath);

            toStream.on('close', function () {
                return callback();
            });

            toStream.on('error', function (err3) {
                return callback(err3);
            });

            stream.pipe(toStream);
            stream.resume();
        });
    });
};


LocalStorage.prototype.moveImageFile = function (image, from, to, callback) {
    assert.object(image, 'image');
    assert.string(image.uuid, 'image.uuid');
    assert.string(from, 'from');
    assert.string(to, 'to');
    assert.func(callback, 'callback');

    var fromPath = this._storPathFromImageUuid(image.uuid, from);
    var toPath = this._storPathFromImageUuid(image.uuid, to);

    fs.rename(fromPath, toPath, function (err) {
        if (err) {
            return callback(err);
        }
        return callback(null);
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
    var config = options.config;
    assert.string(config.url, 'options.config.url');
    assert.string(config.user, 'options.config.user');
    assert.string(config.key, 'options.config.key');
    assert.string(config.keyId, 'options.config.keyId');
    assert.optionalBool(config.insecure, 'options.config.insecure');
    assert.string(config.baseDir, 'options.config.baseDir');

    this.type = 'manta';
    this.log = options.log.child({stor: this.type}, true);

    // Manta variables
    this.url = config.url;
    this.user = config.user;
    this.baseDir = config.baseDir;
    this.dir = path.join(this.baseDir, 'images');
    this.archiveDir = path.join(this.baseDir, 'archive');
    var insecure = config.hasOwnProperty('insecure') ? config.insecure : false;
    this.client = manta.createClient({
        log: this.log,
        sign: {
            key: config.key,
            keyId: config.keyId,
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

// In manta we don't create a writable stream but we still need the path to
// write to, that's why the 2nd argument to the callback is a path and not a
// stream object (this overload might be problematic?). Also, I don't think we
// need a 'rimraf' equivalent because manta.put() is an overwrite
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
    function (image, stream, filename, callback) {
    var tmpName = format('%s.%s', filename, stream.id());
    var self = this;

    self.createImageFileWriteStream(image, tmpName, function (sErr, aPath) {
        if (sErr) {
            onFileWriteStream(sErr);
            return;
        }

        self.client.put(aPath, stream, {}, onFileWriteStream);
    });

    function onFileWriteStream(err) {
        if (err) {
            callback(err);
            return;
        }

        return callback(null, tmpName, filename);
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
        function (image, filename, callback) {
    assert.object(image, 'image');
    assert.string(image.uuid, 'image.uuid');
    if (callback === undefined) {
        callback = filename;
        filename = 'file0';
    }
    assert.func(callback, 'callback');

    var storPath = this._storPathFromImageUuid(image.uuid, filename);
    this.client.get(storPath, function (err, stream, res) {
        if (err) {
            callback(err);
            return;
        }
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
