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
var childprocess = require('child_process');

var assert = require('assert-plus');
var async = require('async');
var bytes = require('bytes');
var genUuid = require('libuuid');
var LRU = require('lru-cache');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var manta = require('manta');
var crypto = require('crypto');
var MemoryStream = require('memorystream');


const uuidRegex = new RegExp('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-'
                            + '[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-'
                            + '[0-9a-fA-F]{12}$');


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


/**
 * Clears storage cache information.
 */
Storage.prototype.clearCache = function () {};



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
    var self = this;
    var tmpName = format('%s.%s', filename, genUuid.create());
    var storPath = self._storPathFromImageUuid(image.uuid, tmpName);

    this.createImageFileWriteStream(image, tmpName, function (sErr, output) {
        self.log.debug('storeFileFromStream', storPath);
        if (sErr) {
            onFileWriteStream(sErr);
            return;
        }

        stream.on('error', function (err) {
            onFileWriteStream(err);
        });

        stream.on('end', function () {
            self.log.debug('got end event for', storPath);
// BAD            output.end();
            onFileWriteStream();
        });

        output.on('finish', function () {
            self.log.debug('got finish event for', storPath);
            //onFileWriteStream();
        });

        stream.pipe(output);
        //stream.pause();
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


/**
 * Local filecache for Manta storage.
 *
 * Important: Any image that exists in the cache *must* also exist in Manta.
 *
 * Uses a LRU list to track and cache the most frequently used images.
 *
 * I'd imagine the most optimal solution would be keeping track of images used
 * over time, but to keep things simple it just keeps track of last N images
 * used.
 *
 * Notes:
 *  1. Maintains a LRU list of manta images that are cached locally on disk.
 * TODO:
 *  2. Periodically examines disk space to check config v's usage.
 *  3. Cull old images as required.
 */
function LocalFileCacheStorage(options) {
    assert.object(options.log, 'options.log');
    assert.object(options.config, 'options.config');
    var config = options.config;
    assert.string(config.baseDir, 'options.config.baseDir');

    this.config = config;
    this.type = 'manta'; // TODO: Even though we're a local filecache??
    //this.log = options.log.child({stor: this.type}, true);
    this.log = options.log.child({stor: 'filecache'}, true);

    this.baseDir = path.resolve(config.filecache.baseDir);
    this.dir = path.join(this.baseDir);

    assert.ok(this.dir && this.dir !== '/',
        'cannot have empty or root dir for local storage');
}
util.inherits(LocalFileCacheStorage, LocalStorage);

LocalFileCacheStorage.prototype.setup = function (callback) {
    assert.func(callback, 'callback');

    var self = this;
    // Assumption for now: it is writable for us.
    self.log.info('mkdir -p %s', this.dir);

    // TODO:
    // 1. Check/update zfs quota from config.

    async.waterfall([
        function ensureDir(next) {
            mkdirp(self.dir, next);
        },
        function lruCache(_, next) {
            self.setupLru(next);
        },
        function initStats(next) {
            self.resetStats();
            next();
        },
        function loadCache(next) {
            self.loadCacheFromDisk(next);
        }
    ], callback);
};

LocalFileCacheStorage.prototype.getStorPath = function (image, filename)
{
    return this._storPathFromImageUuid(image.uuid, filename);
};

LocalFileCacheStorage.prototype.isAcceptableFilesize = function (val, callback)
{
    return val < this.lru.max;
};

/**
 * Get the number of bytes that filecache is configured to use.
 *
 * @param val {String} The configuration maxDiskUsage value.
 * @param callback(err, numBytes)
 */
LocalFileCacheStorage.prototype.getMaxDiskUsage = function (val, callback) {
    assert.func(callback, 'callback');

    var self = this;

    if (val.substr(-1) === '%') {
         // Percentage of all available space.
        var percentage = parseInt(val, 10);
        if (percentage < 0 || percentage > 100) {
            this.log.warn('Invalid filecache.maxDiskUsage percentage: ',
                          percentage, ' - defaulting to 20%');
            percentage = 20;
        }
        // Determine all available space.
        var parentDir = path.dirname(this.dir);
        childprocess.exec('/usr/bin/df -b "' + parentDir + '" '
                        + '| awk \'{ print $2 }\' | tail -1',
                        function (err, stdout, stderr)
        {
            if (err) {
                return callback(err);
            }
            var diskSize = stdout.trim();
            self.log.debug('diskSize:', diskSize, 'KB');
            // Convert to byte size (from kilobytes).
            diskSize = diskSize * 1024;
            // Return the percentage allotment.
            var diskAllotment = Math.ceil((diskSize / 100) * percentage);
            callback(null, diskAllotment);
        });
    } else {
        // Real disk size.
        callback(null, bytes.parse(val));
    }
};

LocalFileCacheStorage.prototype.setupLru = function (callback) {
    assert.func(callback, 'callback');

    this.log.debug('setupLru');
    var self = this;

    async.waterfall([
        function maxDisk(next) {
            self.getMaxDiskUsage(self.config.filecache.maxDiskUsage, next);
        },
        function loadLru(maxDiskUsage, next) {
            self.log.debug('setupLru, maxDiskUsage',
                           bytes.format(maxDiskUsage));
            var lruOptions = {
                max: maxDiskUsage,
                // Calculates filesize of image - used to enforce the quota.
                length: function lruGetLength(storPath) {
                    try {
                        return fs.statSync(storPath).size;
                    } catch (ex) {
                        self.log.debug('lru length calculate failed for:',
                                       storPath, ',', ex);
                        return 0;
                    }
                },
                dispose: self.onLruRemoveEntry.bind(self)
            };
            self.lru = new LRU(lruOptions);
            next();
        }
    ], callback);
};

LocalFileCacheStorage.prototype.updateFromConfig = function (config, callback) {
    assert.object(config, 'config');
    assert.func(callback, 'callback');

    this.log.debug('updateFromConfig');
    var self = this;
    // Determine what changed.
    var oldconfig = this.config;
    this.config = config;
    var maxChanged = (oldconfig.filecache.maxDiskUsage
                        != config.filecache.maxDiskUsage);

    if (maxChanged) {
        this.getMaxDiskUsage(config.filecache.maxDiskUsage,
                             function (err, maxDiskUsage)
        {
            if (!err) {
                self.log.debug('Changing lru max to be:', maxDiskUsage);
                self.lru.max = maxDiskUsage;
                self.log.debug('num lru cache items: ', self.lru.keys().length);
                self.log.debug('lru cache length now:', self.lru.length);
            }
            callback(err);
        });
        return;
    }
    callback();
};

LocalFileCacheStorage.prototype.loadCacheFromDisk = function (callback) {
    assert.func(callback, 'callback');

    this.log.debug('loadCacheFromDisk');
    // TODO: This would be better read straight from a json lru-cache file.
    var self = this;
    async.waterfall([
        function getDirEntries(next) {
            fs.readdir(self.dir, next);
        },
        function getPrefixEntries(files, next) {
            // cache looks like this:  .../filecache/$prefix/$uuid/file0
            files = files.filter(function (filename) {
                if (!filename.match(/^[0-9a-fA-F]{3}$/)) {
                    self.log.info('Ignoring unexpected filecache entry: ',
                                  filename);
                    return false;
                }
                return true;
            });
            var prefixpaths = files.map(function (filename) {
                return path.join(self.dir, filename);
            });
            next(null, prefixpaths);
        },
        function getUuidEntries(prefixpaths, next) {
            // cache looks like this:  .../filecache/$prefix/$uuid/file0
            var uuidpaths = [];
            prefixpaths.forEach(function (p) {
                var uuids = fs.readdirSync(p);
                uuids = uuids.filter(function (uuid) {
                    if (!uuid.match(uuidRegex)) {
                        self.log.info('Ignoring unexpected filecache '
                                        + 'entry: ', uuid);
                        return false;
                    }
                    return true;
                });
                uuidpaths = uuidpaths.concat(uuids.map(function (uuid) {
                    return path.join(p, uuid);
                }));
            });
            next(null, uuidpaths);
        },
        function getImageEntries(uuidpaths, next) {
            // cache looks like this:  .../filecache/$prefix/$uuid/file0
            var count = 0;
            uuidpaths.forEach(function (p) {
                var filenames = fs.readdirSync(p);
                filenames.forEach(function (filename) {
                    var storPath = path.join(p, filename);
                    self.lru.set(storPath, storPath);
                });
                count += filenames.length;
            });
            var cacheSize = bytes.format(self.lru.length);
            self.log.info('', count, 'images in the filecache, taking up',
                          cacheSize, 'space');
            next();
        }

    ], callback);
};

/**
 * Called when a lru cache entry is removed.
 *
 * @param key {string} The path of the filecache image.
 */
LocalFileCacheStorage.prototype.onLruRemoveEntry = function (key, _) {
    var self = this;
    fs.unlink(key, function (err) {
        if (err) {
            self.log.warn('Unable to delete filecache entry: ', key);
        } else {
            self.log.debug('Deleted filecache entry: ', key);
            // TODO: Delete empty directories?
            //       find /data/filecache/ -type d -empty -delete
        }
    });
    this.stats.drops += 1;
};

LocalFileCacheStorage.prototype.createImageFileReadStream =
        function (image, filename, callback) {
    var storPath = this._storPathFromImageUuid(image.uuid, filename);
    this.log.debug('createImageFileReadStream storPath: ', storPath);
    var isCached = this.lru.get(storPath);
    if (isCached) {
        this.stats.hits += 1;

        LocalStorage.prototype.createImageFileReadStream.apply(this, arguments);
        return;
    }
    this.stats.misses += 1;
    // TODO: String error seems ugly.
    callback('not cached');
};

LocalFileCacheStorage.prototype.pipeStream =
    function (image, filename, stream, output, callback) {

    var self = this;
    var storPath = self._storPathFromImageUuid(image.uuid, filename);

    stream.on('error', function (err) {
        onWriteDone(err);
    });

    stream.on('end', function () {
        self.log.debug('got end event for', storPath);
        onWriteDone();
    });

    output.on('finish', function () {
        self.log.debug('got finish event for', storPath);
        //onFileWriteStream();
    });

    stream.pipe(output);

    var onWriteDone = function (err) {
        callback(err, "cache");
    };
};

LocalFileCacheStorage.prototype.cacheStream =
    function (image, stream, filename, addCacheKey, callback) {
    // TODO:
    // 1. First check image size and see if there is enough free space on disk.
    // 2. Evict old images if there is not enough space.

    var self = this;
    var storPath = self._storPathFromImageUuid(image.uuid, filename);

    LocalStorage.prototype.storeFileFromStream.call(this, image,
                stream, filename,
                function (err, tmpName, _)
    {
        if (err) {
            callback(err);
            return;
        }

        var tmpPath = self._storPathFromImageUuid(image.uuid, tmpName);
        fs.rename(tmpPath, storPath, function (err2) {
            self.log.debug('renamed', tmpPath, 'to', storPath);
            if (err2) {
                callback(err2);
                return;
            }
            if (addCacheKey) {
                self.log.debug('cacheStream storPath: ', storPath);
                if (!self.lru.has(storPath)) {
                    self.lru.set(storPath, storPath);
                }
            }
            callback(null, storPath);
        });
    });
};

LocalFileCacheStorage.prototype.deleteImageFile =
        function (image, filename, callback) {
    this.log.debug('deleteImageFile');
    // Lru delete will also cause image to be deleted on disk.
    var storPath = this._storPathFromImageUuid(image.uuid, filename);
    if (!this.lru.has(storPath)) {
        this.log.debug('deleteImageFile: file not cached %s - ignoring',
                        storPath);
    } else {
        this.lru.del(storPath);
    }
    callback();
};

LocalFileCacheStorage.prototype.getStats = function () {
    var result = {};
    result['keys'] = this.lru.keys();
    result['stats'] = this.stats;
    return result;
};

LocalFileCacheStorage.prototype.resetStats = function () {
    this.stats = {hits: 0, misses: 0, drops: 0};
};

LocalFileCacheStorage.prototype.clearCache = function () {
    // Lru reset will delete the filesystem bits.
    this.lru.reset();
    this.resetStats();
    this.log.debug('cleared filecache');
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
        sign: {
            key: config.key,
            keyId: config.keyId,
            user: this.user
        },
        user: this.user,
        url: this.url,
        log: this.log,
        // manta.createClient doesn't take 'insecure' currently
        // (manta.createBinClient *does*).
        rejectUnauthorized: !insecure
    });

    // Local manta filecache
    this.filecache = new LocalFileCacheStorage(options);
}
util.inherits(MantaStorage, Storage);

MantaStorage.prototype.setup = function setup(callback) {
    assert.func(callback, 'callback');
    // Succeeed here, lazily mkdir -p when storing or reading files.
    // Assumption for now: it is writable for us.

    this.filecache.setup(function (err) {
        if (err) {
            this.log.error('Unable to setup LocalFileCacheStorage, '
                            + 'will use manta only, err: ', err);
        }
        callback();
    });
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

    var numCompleted = 0;
    var streamDoneCallback = function (err, name) {
        numCompleted += 1;
        self.log.debug('storeFileFromStream: streamDoneCallback ', numCompleted, 'of 2', image.uuid);
        if (err) {
            // Don't abort on a caching error.
            if (name === 'cache') {
                self.log.warn('Unable to cache image', image.uuid, 'file', filename);
            } else {
                callback(err);
                return;
            }
        }
        //if (numCompleted === 2) {
        if (numCompleted === 1) {
            // Success.
            callback(null, tmpName, filename);
        }
    };

    stream.on('end', function () {
        self.log.debug('XXX stream end for', image.uuid);
    });

    // Wait until manta stream is also hooked up.
    async.waterfall([
        //function createCacheWriteStream(next) {
        //    self.filecache.createImageFileWriteStream(image, tmpName,
        //                                function (err, cachestream) {
        //        self.filecache.pipeStream(image, tmpName, stream, cachestream, streamDoneCallback);
        //        // Wait until manta stream is also hooked up.
        //        stream.pause();
        //        self.log.debug('storeFileFromStream: pipeStream running, moving to next');
        //        next();
        //    });
        //},
        function createMantaWriteStream(next) {
            self.createImageFileWriteStream(image, tmpName, next);
        },
        function writeFiles(storPath, next) {
            self.log.debug('storeFileFromStream: writeToManta', image.uuid);
            // Send to manta (and subsequently the filecache).
            // Note: manta.put will perform a stream.resume().
            self.client.put(storPath, stream, {}, next);
        }
    ], streamDoneCallback);
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

    var self = this;
    var storPath = self._storPathFromImageUuid(image.uuid, filename);

    async.waterfall([
        function cacheGet(next) {
            // Check the local filecache, then fallback to manta when not available.
            self.filecache.createImageFileReadStream(image, filename,
                                                    function (err, cachestream) {
                if (!err && cachestream) {
                    self.log.debug('createImageFileReadStream: using local filecache');
                    cachestream.pause(); // caller will resume (see images.js)
                    callback(null, cachestream);
                    return;
                }
                self.log.debug('Could not get image from local filecache, trying '
                               + 'manta next, err: ', err);
                next();
            });
        },
        function mantaGet(next) {
            self.log.debug('mantaGet');
            self.client.get(storPath, next);
        },
        function streamToFilecache(stream, resp, next) {
            self.log.debug('streamToFilecache');
            stream.pause(); // caller will resume (see images.js)

            var filesize = resp.headers['content-length'];
            var streamCount = 1;

            if (!self.filecache.isAcceptableFilesize(filesize)) {
                self.log.debug('skipping filecache - file too large:',
                               filesize);
            } else {
                // Copy stream to filecache then stream back to requester.
                streamCount = 2;
                self.filecache.cacheStream(image, stream, filename, true,
                                            function (err, cachePath)
                {
                    self.log.debug('streamToFilecache.cacheStream callback for',
                                   cachePath);
                    if (err) {
                        self.log.warn('Could not stream image to filecache - '
                                        + 'err ', err);
                    }
                    next(null, null, streamCount);
                });
            }

            // Stream manta resp back to the requester.
            next(null, stream, streamCount);
        }
    ], callback);
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

    var self = this;
    var storPath = self._storPathFromImageUuid(image.uuid, filename);
    var storDir = path.dirname(storPath);

    async.waterfall([
        function deleteCacheImage(next) {
            self.filecache.deleteImageFile(image, filename, next);
        },
        function deleteMantaImage(next) {
            self.log.debug({path: storPath}, 'unlink');
            self.client.unlink(storPath, next);
        },
        function getMantaDir(res, next) {
            self.client.ls(storDir, next);
        },
        function removeEmptyMantaDir(res, next) {
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
                    return next();
                }

                self.client.rmr(storDir, next);
            });
        }
    ], callback);
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

    async.waterfall([
        function cacheMove(next) {
            self.filecache.moveImageFile(image, from, to, function (err) {
                if (err) {
                    self.log.warn('Unable to moveImageFile for filecache - '
                                + 'ignoring, image: %s, err: %s', image, err);
                } else {
                    // It's now considered active - cache it.
                    var cachePath = self.filecache.getStorPath(image, to);
                    self.filecache.log.debug('lru added ', cachePath);
                    self.filecache.lru.set(cachePath, cachePath);
                }
                next();
            });
        },
        function mantaLn(next) {
            self.client.ln(fromPath, toPath, next);
        },
        function mantaDelete(res, next) {
            self.deleteImageFile(image, from, next);
        }
    ], callback);
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

MantaStorage.prototype.getCacheStats = function () {
    return this.filecache.getStats();
};

MantaStorage.prototype.clearCache = function () {
    this.filecache.clearCache();
};

//---- exports

module.exports = {
    local: LocalStorage,
    manta: MantaStorage
};
