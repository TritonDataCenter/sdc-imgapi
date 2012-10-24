/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * IMGAPI model and endpoints for '/images/...'.
 */

var debug = console.warn;
var format = require('util').format;
var fs = require('fs');
var crypto = require('crypto');

var assert = require('assert-plus');
var genUuid = require('node-uuid');
var restify = require('restify');

var ufdsmodel = require('./ufdsmodel');
var utils = require('./utils'),
    objCopy = utils.objCopy,
    boolFromString = utils.boolFromString;
var errors = require('./errors');



//---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- Image model

/**
 * Create a Image object from raw DB (i.e. UFDS) data.
 * External usage should use `Image.create(...)`.
 *
 * @param app
 * @param raw {Object} The raw instance data from the DB (or manually in
 *      that form). E.g.:
 *          { dn: 'image=:uuid, ou=images, o=smartdc',
 *            uuid: ':uuid',
 *            ...
 *            objectclass: 'image' }
 * @throws {Error} if the given data is invalid.
 */
function Image(app, raw) {
    assert.object(app, 'app');
    assert.object(raw, 'raw');
    assert.string(raw.uuid, 'raw.uuid');

    this.uuid = raw.uuid;
    this.dn = Image.dn(this.uuid);
    if (raw.dn) {
        assert.equal(raw.dn, this.dn,
            format('invalid Image data: given "dn" (%s) does not '
                + 'match built dn (%s)', raw.dn, this.dn));
    }

    var rawCopy = objCopy(raw);
    delete rawCopy.dn;
    delete rawCopy.controls;

    this.raw = Image.validate(app, rawCopy);

    this.name = this.raw.name;
    this.description = this.raw.description;
    this.type = this.raw.type;
    this.os = this.raw.os;
    this.published_at = this.raw.published_at &&
        new Date(this.raw.published_at);
    this.tags = this.raw.tag;
    this.datacenters = this.raw.datacenter;
    this.disabled = boolFromString(this.raw.disabled, false, 'raw.disabled');
    this.activated = boolFromString(this.raw.activated, false, 'raw.activated');

    var self = this;
    this.__defineGetter__('state', function getState() {
        if (!self.activated) {
            return 'unactivated';
        } else if (self.disabled) {
            return 'disabled';
        } else {
            return 'active';
        }
    });
    this.__defineGetter__('files', function () {
        if (self._filesCache === undefined) {
            if (! self.raw.files) {
                self._filesCache = [];
            } else {
                self._filesCache = JSON.parse(self.raw.files)
            }
        }
        return self._filesCache;
    });
}




Image.objectclass = 'sdcimage';

Image.dn = function (uuid) {
    return format('uuid=%s, ou=images, o=smartdc', uuid);
};

Image.dnFromRequest = function (req) {
    var uuid = req.params.uuid;
    if (! UUID_RE.test(uuid)) {
        throw new errors.InvalidParameterError(
            format('invalid image uuid: "%s"', uuid),
            [{field: 'uuid', code: 'Invalid'}]);
    }
    return Image.dn(uuid);
};

Image.parentDnFromRequest = function (req) {
    return 'ou=images, o=smartdc';
};


/**
 * Return the API view of this Image's data.
 */
Image.prototype.serialize = function serialize() {
    var data = {
        uuid: this.uuid,
        state: this.state,
        disabled: this.disabled,
        name: this.name,
        type: this.type,
        os: this.os,
        published_at: this.raw.published_at,
        files: this.files,
        tags: this.tags
    };
    if (this.description) data.description = this.description;
    if (this.urn) data.urn = this.urn;
    return data;
};


/**
 * Add an uploaded file to this Image instance. The file will have already
 * be written out (to disk or to manta, depending).
 *
 * @param app {App} The IMGAPI app.
 * @param file {Object} Describes the uploaded file, with keys:
 *      - `sha1` {String}
 *      - `size` {Integer}
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)` where `err` is some internal
 *      detail (i.e. it should be wrapped for the user).
 */
Image.prototype.addFile = function addFile(app, file, log, callback) {
    //TODO: perhaps cleaner to pass in the req stream here and have the
    // "where to save it" logic be in here.

    files = this.files;
    files[0] = file;
    this.raw.files = JSON.stringify(files);
    delete this._filesCache;
    var change = {
        operation: 'replace',
        modification: {
            files: this.raw.files
        }
    }
    ufdsmodel.modelUpdate(app, this, change, log, callback);
}


/**
 * Activate this Image.
 *
 * @param app {App} The IMGAPI app.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)` where `err` is okay to
 *      use for an API reponse (i.e. doesn't expose internal details).
 */
Image.prototype.activate = function activate(app, log, callback) {
    // Ensure it isn't already activated
    if (this.activated) {
        return callback(new errors.ImageAlreadyActivatedError(this.uuid));
    }

    // Ensure it has a file.
    if (this.files.length === 0) {
        return callback(new errors.NoActivationNoFileError(this.uuid));
    }

    this.published_at = new Date();
    this.raw.published_at = this.published_at.toISOString();
    this.activated = true;
    this.raw.activated = 'true';
    var change = {
        operation: 'replace',
        modification: {
            activated: this.raw.activated
        }
    }
    ufdsmodel.modelUpdate(app, this, change, log, callback);
}


/**
 * Authorize that this Image can be added/updated.
 *
 * @param app {App} The IMGAPI app.
 * @param callback {Function} `function (err)`. `err` may be:
 *      undefined: write is authorized
 *      InternalError: some other error in authorizing
 */
Image.prototype.authorizeWrite = function (app, callback) {
    //TODO
    callback();
};

Image.prototype.authorizeDelete = function (app, callback) {
    //TODO
    callback();
};



/**
 * Get a probe.
 *
 * @param app {App} The IMGAPI App.
 * @param uuid {String} The image UUID.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err, image)`
 */
Image.get = function get(app, uuid, log, callback) {
    var dn = Image.dn(uuid);
    ufdsmodel.modelGet(app, Image, dn, log, callback);
};


/**
 * Validate the raw data and optionally massage some fields.
 *
 * @param app {App} The IMGAPI app.
 * @param raw {Object} The raw data for this object.
 * @returns {Object} The raw data for this object, possibly massaged to
 *      normalize field values.
 * @throws {errors.ValidationFailedError} if the raw data is invalid.
 * @throws {errors.InternalError} for other errors.
 */
Image.validate = function validate(app, raw) {
    var errs = []; // validation errors

    //---- internal ufds fields
    // objectclass
    if (!raw.objectclass) {
        throw new errors.InternalError('no "objectclass" field on raw image data');
    } else if (raw.objectclass !== Image.objectclass) {
        throw new errors.InternalError(
            'invalid "objectclass" field on raw image data: "%s"',
            raw.objectclass);
    }

    //---- external spec fields
    // uuid
    if (!raw.uuid) {
        errs.push({field: 'uuid', code: 'MissingParameter'});
    } else if (! UUID_RE.test(raw.uuid)) {
        errs.push({field: 'uuid', code: 'Invalid'});
    }

    // name
    if (!raw.name) {
        errs.push({field: 'name', code: 'MissingParameter'});
    } else if (raw.name.length > 512) {
        errs.push({
            field: 'name',
            code: 'Invalid',
            message: 'image name is too long (max 512 characters)'
        });
    }

    // disabled
    if (raw.disabled === undefined) {
        errs.push({field: 'disabled', code: 'MissingParameter'});
    } else {
        var disabled = boolFromString(raw.disabled);
        if (typeof (disabled) !== 'boolean') {
            errs.push({
                field: 'disabled',
                code: 'Invalid'
            });
        }
    }

    // activated
    var activated = false;
    if (raw.activated === undefined) {
        errs.push({field: 'activated', code: 'MissingParameter'});
    } else {
        activated = boolFromString(raw.activated);
        if (typeof (activated) !== 'boolean') {
            errs.push({
                field: 'activated',
                code: 'Invalid'
            });
        }
    }

    // published_at (ISO 8601 date string, e.g. "2012-12-25T12:00:00.123Z")
    // Required if activated.
    var PUBLISHED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/
    if (activated && raw.published_at === undefined) {
        errs.push({field: 'published_at', code: 'MissingParameter'});
    } else if (raw.published_at && !PUBLISHED_AT_RE.test(raw.published_at)) {
        errs.push({
            field: 'published_at',
            code: 'Invalid',
            message: 'published_at date not in "YYYY-MM-DDTHH:MM:SS(.SSS)Z" format'
        });
    }

    // type
    var VALID_TYPES = {
        'zone-dataset': true,
        'zvol': true
    };
    if (raw.type === undefined) {
        errs.push({field: 'type', code: 'MissingParameter'});
    } else if (VALID_TYPES[raw.type] === undefined) {
        errs.push({
            field: 'type',
            code: 'Invalid',
            message: format('invalid image type: "%s" (must be one of: %s)',
                raw.type, Object.keys(VALID_TYPES).join(', '))
        });
    }

    // os
    var VALID_OSES = {
        'smartos': true,
        'linux': true,
        'windows': true,
        'other': true
    };
    if (raw.os === undefined) {
        errs.push({field: 'os', code: 'MissingParameter'});
    } else if (VALID_OSES[raw.os] === undefined) {
        errs.push({
            field: 'os',
            code: 'Invalid',
            message: format('invalid image os: "%s" (must be one of: %s)',
                raw.os, Object.keys(VALID_OSES).join(', '))
        });
    }

    // files
    var files;
    try {
        if (raw.files) {
            files = JSON.parse(raw.files);
        }
    } catch (e) {
        errs.push({
            field: 'files',
            code: 'Invalid',
            message: format('invalid image "files": %s', e)
        });
    }
    if (!files) {
        /* pass through */
    } else if (files.length > 1) {
        errs.push({
            field: 'files',
            code: 'Invalid',
            message: format('invalid image "files": too many files')
        });
    } else if (files.length === 1) {
        var file = files[0];
        if (!file.sha1) {
            errs.push({
                field: 'files',
                code: 'Invalid',
                message: format(
                    'invalid image "files": file missing "sha1" field')
            });
        } else if (!file.size) {
            errs.push({
                field: 'files',
                code: 'Invalid',
                message: format(
                    'invalid image "files": file missing "sha1" field')
            });
        }
    }

    // datacenter/datacenters
    if (raw.datacenter === undefined) {
        raw.datacenter = []
    } else if (typeof (raw.datacenter) === 'string') {
        raw.datacenter = [raw.datacenter];
    } else if (!Array.isArray(raw.datacenter)) {
        errs.push({
            field: 'datacenters',
            code: 'Invalid',
            message: format('invalid image datacenters (not an array): %s',
                raw.datacenter)
        });
    }

    // tags
    // TODO: tags

    if (errs.length) {
        var fields = errs.map(function (e) { return e.field });
        throw new errors.ValidationFailedError(
            "invalid image data: " + fields.join(', '), errs);
    }
    return raw;
};



/**
 * Create a new Image from request data.
 *
 * @param app {App}
 * @param data {Object} The probe data in "external" form (as opposed to
 *      the "raw" form stored in the db).
 * @param callback {Function} `function (err, probe)`.
 */
Image.create = function createImage(app, data, callback) {
    assert.object(app, 'app');
    assert.object(data, 'data');
    assert.func(callback, 'callback');

    // Put together the raw data (where "raw" means in the form stored
    // in the database and used by the "Image" object).
    var newUuid = genUuid();
    var raw = {
        uuid: newUuid,
        name: data.name,
        type: data.type,
        os: data.os,
        disabled: data.disabled || false,
        activated: false,
        objectclass: Image.objectclass
    };
    if (data.tags && data.tags.length > 0) {
        raw.tags = data.tags;
    }

    var image = null;
    try {
        image = new Image(app, raw);
    } catch (cErr) {
        return callback(cErr);
    }

    callback(null, image);
};




//---- API controllers

function apiListImages(req, res, next) {
    return ufdsmodel.requestList(req, res, next, Image);
}


function apiGetImage(req, res, next) {
    return ufdsmodel.requestGet(req, res, next, Image);
}


function apiCreateImage(req, res, next) {
    ufdsmodel.requestCreate(req, res, next, Image);
}


function apiAddImageFile(req, res, next) {
    req.log.debug({image: req._image}, "AddImageFile: start")

    // Can't change files on an activated image.
    if (req._image.activated) {
        return next(new errors.ImageFilesImmutableError(req._image.uuid));
    }

    var finished = false;
    function finish(err) {
        if (finished) {
            return;
        }
        finished = true;
        if (err) {
            req.log.error(err, 'error receiving image file');
            return next(new errors.InternalError(
                'error receiving image file: %s', err));
        }
        var file = {
            sha1: shasum.digest('hex'),
            size: Number(req.headers['content-length'])
        };
        if (isNaN(file.size)) {
            return next(errors.InvalidHeaderError(
                'missing or invalid "Content-Length" header: %j',
                req.headers['content-length']));
        }
        req._image.addFile(req._app, file, req.log, function (err) {
            if (err) {
                // TODO: remove the saved file!
                req.log.error(err, 'error adding file info to Image');
                return next(new errors.InternalError(err,
                    'could not save image'));
            }
            res.send(req._image.serialize());
            next();
        });
    }

    var shasum = crypto.createHash('sha1');
    req.on('data', function (chunk) {
        shasum.update(chunk);
    });
    req.on('end', function () {
        req.log.trace('req "end" event');
        finish();
    });
    req.on('close', function () {
        req.log.trace('req "close" event');
        finish();
    });
    req.on('error', function (err) {
        finish(err);
    });

    var dbPath = "/var/tmp/imgapi/outfile"; //XXX
    req.pipe(fs.createWriteStream(dbPath));
    req.resume(); // Was paused in `server.pre`.
}


function apiGetImageFile(req, res, next) {
    req.log.debug({image: req._image}, "GetImageFile: start")
    if (req._image.files.length === 0) {
        return next(new errors.ResourceNotFoundError(
            "image '%s' has no file", req._image.uuid));
    }
    var dbPath = "/var/tmp/imgapi/outfile"; //XXX
    fs.createReadStream(dbPath).pipe(res);
}


function apiActivateImage(req, res, next) {
    if (req.query.action !== 'activate')
        return next();

    req.log.debug({image: req._image}, "ActivateImage: start")
    req._image.activate(req._app, req.log, function (err) {
        if (err) {
            return next(err);
        }
        res.send(req._image.serialize());
        next(false);
    });
}


function apiDeleteImage(req, res, next) {
    return ufdsmodel.requestDelete(req, res, next, Image);
}


/**
 * Restify handler to add `req._image` or respond with an appropriate
 * error.
 *
 * This is for endpoints at or under '/images/:uuid'.
 */
function reqGetImage(req, res, next) {
    var log = req.log;
    var uuid = req.params.uuid;
    log.debug({uuid: uuid}, 'get image');
    Image.get(req._app, uuid, log, function (getErr, image) {
        if (getErr) {
            next(getErr);
        } else if (image) {
            req._image = image;
            next();
        }
    });
}


/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 */
function mountApi(server) {
    server.get(
        {path: '/images', name: 'ListImages'},
        apiListImages);
    server.get(
        {path: '/images/:uuid', name: 'GetImage'},
        apiGetImage);
    server.post(
        {path: '/images', name: 'CreateImage'},
        function resume(req, res, next) {
            // `req` was paused by a `server.pre` in app.js. We need to
            // resume the stream, but do so *after* we've setup the req
            // event handlers in `restify.bodyParser`. Hence the `nextTick`
            // hack here.
            next();
            process.nextTick(function () {
                req.resume();
            })
        },
        restify.bodyParser({mapParams: false}),
        apiCreateImage);
    server.put(
        {path: '/images/:uuid/file', name: 'AddImageFile'},
        reqGetImage,    // add `req._image`
        apiAddImageFile);
    server.get(
        {path: '/images/:uuid/file', name: 'GetImageFile'},
        reqGetImage,    // add `req._image`
        apiGetImageFile);
    server.post(
        {path: '/images/:uuid', name: 'UpdateImage'},
        reqGetImage,    // add `req._image`
        apiActivateImage,
        function invalidAction(req, res, next) {
            if (req.query.action) {
                next(new errors.InvalidParameterError(
                    format('"%s" is not a valid action', req.query.action),
                    [{field: 'action', code: 'Invalid'}]));
            } else {
                next(new errors.InvalidParameterError(
                    'no image "action" was specified',
                    [{field: 'action', code: 'MissingParameter'}]));
            }
        });
    server.del(
        {path: '/images/:uuid', name: 'DeleteImage'},
        apiDeleteImage);
}



//---- exports

module.exports = {
    Image: Image,
    mountApi: mountApi
};
