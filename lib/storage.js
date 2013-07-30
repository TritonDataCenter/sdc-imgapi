/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
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



//---- local storage

function LocalStorage(options) {
    assert.object(options.log, 'options.log');
    assert.object(options.config, 'options.config');
    var config = options.config;
    assert.string(config.dir, 'options.config.dir');

    this.type = 'local';
    this.log = options.log.child({stor: this.type}, true);

    this.dir = path.resolve(config.dir);
    assert.ok(this.dir && this.dir !== '/',
        'cannot have empty or root dir for local storage');
}
util.inherits(LocalStorage, Storage);

LocalStorage.prototype.setup = function (callback) {
    assert.func(callback, 'callback');
    // Assumption for now: it is writable for us.
    this.log.info('mkdir -p %s', this.dir);
    mkdirp(this.dir, callback);
};


/**
 * Returns the storage path for image files
 *
 * @param uuid {UUID} Image UUID
 * @param filename {string} defaults to 'file0' if not specified
 */
LocalStorage.prototype._storPathFromImageUuid = function (uuid, filename) {
    return path.resolve(this.dir, uuid, filename);
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

LocalStorage.prototype.deleteImageFile =
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

        stream.on('end', function () {
            onFileWriteStream();
        });
        stream.on('close', function () {
            onFileWriteStream();
        });
        stream.on('error', function (err) {
            onFileWriteStream(err);
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
    assert.string(to, 'from');
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

    this.type = 'manta';
    this.log = options.log.child({stor: this.type}, true);

    // Manta variables
    this.url = config.url;
    this.user = config.user;
    this.dir = format('/%s/stor/imgapi', this.user);
    var insecure = config.hasOwnProperty('insecure') ? config.insecure : false;
    this.client = manta.createClient({
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
    return path.resolve(this.dir, uuid, filename);
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
    // var storDir = path.dirname(storPath);
    this.log.debug({path: storPath}, 'unlink');
    this.client.unlink(storPath, function (fErr) {
        if (fErr) {
            return callback(fErr);
        }
        return callback();
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



//---- exports

module.exports = {
    local: LocalStorage,
    manta: MantaStorage
};
