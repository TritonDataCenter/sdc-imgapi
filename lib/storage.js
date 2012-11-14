/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * IMGAPI abstracted handling for storage: storage of the (large) image
 * files in Manta, DCLS, or a local dir.
 */

var util = require('util');
var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var mkdirp = require('mkdirp');



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
Storage.prototype.setup = function setup(callback) {
    callback();
};

/**
 * Return a writeable stream to storage for the image file for the given image.
 *
 * @param image {Image}
 * @param callback {Function} `function (err, stream)`
 */
Storage.prototype.createImageFileWriteStream =
        function createImageFileWriteStream(image, callback) {
};

/**
 * Return a readable stream to storage for the image file for the given image.
 *
 * @param image {Image}
 * @param callback {Function} `function (err, stream)`
 */
Storage.prototype.createImageFileReadStream =
        function createImageFileReadStream(image, callback) {
};



//---- local storage

function LocalStorage(options) {
    assert.object(options.log, 'options.log');
    assert.object(options.config, 'options.config');
    var config = options.config;
    assert.string(config.dir, 'options.config.dir');

    this.type = 'local';
    this.log = options.log

    this.dir = path.resolve(config.dir);
    assert.ok(this.dir && this.dir !== '/',
        'cannot have empty or root dir for local storage')
}
util.inherits(LocalStorage, Storage);

LocalStorage.prototype.setup = function setup(callback) {
    assert.func(callback, 'callback');
    // Assumption for now: it is writable for us.
    this.log.info('mkdir -p %s', this.dir)
    mkdirp(this.dir, callback);
};

LocalStorage.prototype._storPathFromImageUuid = function (uuid) {
    return path.resolve(this.dir, 'images', uuid, 'file0');
};

LocalStorage.prototype.createImageFileWriteStream =
        function createImageFileWriteStream(image, callback) {
    assert.object(image, 'image');
    assert.string(image.uuid, 'image.uuid');
    assert.func(callback, 'callback');

    var storPath = this._storPathFromImageUuid(image.uuid);
    var storDir = path.dirname(storPath);
    mkdirp(storDir, function (err) {
        if (err) {
            return callback(err);
        }
        var stream = fs.createWriteStream(storPath);
        callback(null, stream);
    });
};

LocalStorage.prototype.createImageFileReadStream =
        function createImageFileReadStream(image, callback) {
    assert.object(image, 'image');
    assert.string(image.uuid, 'image.uuid');
    assert.func(callback, 'callback');

    var stream;
    try {
        var storPath = this._storPathFromImageUuid(image.uuid);
        stream = fs.createReadStream(storPath);
    } catch (err) {
        return callback(err);
    }
    callback(null, stream);
};



//---- exports

module.exports = {
    local: LocalStorage
};
