/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * IMGAPI model and endpoints for '/images/...'.
 */

var debug = console.warn;
var format = require('util').format;

var assert = require('assert-plus');
var genUuid = require('node-uuid');

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
    assert.optionalString(raw.name, 'raw.name');
    assert.string(raw.objectclass, 'raw.objectclass');
    if (raw.objectclass !== Image.objectclass) {
        assert.equal(raw.objectclass, Image.objectclass,
            format('invalid Image data: objectclass "%s" !== "%s"',
            raw.objectclass, Image.objectclass));
    }

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
    if (rawCopy.datacenter && typeof (rawCopy.datacenter) === 'string') {
        rawCopy.datacenter = [rawCopy.datacenter];
    }
    this.raw = Image.validate(app, rawCopy);

    var self = this;
    this.__defineGetter__('name', function () {
        return self.raw.name;
    });
    this.__defineGetter__('description', function () {
        return self.raw.description;
    });
    this.__defineGetter__('type', function () {
        return self.raw.type;
    });
    this.__defineGetter__('os', function () {
        return self.raw.os;
    });
    this.__defineGetter__('published_at', function () {
        return new Date(self.raw.published_at);
    });
    this.__defineGetter__('tags', function () {
        return self.raw.tag;
    });
    this.__defineGetter__('datacenters', function () {
        return self.raw.datacenter;
    });
    this.disabled = boolFromString(this.raw.disabled, false, 'raw.disabled');
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
        name: this.name,
        os: this.os,
        type: this.type,
        // TODO could just this.raw.published_at to avoid double conversion.
        published_at: this.published_at,
        disabled: this.disabled,
        datacenters: this.datacenters,
        tags: this.tags
    };
    if (this.description) data.description = this.description;
    if (this.urn) data.urn = this.urn;
    return data;
};


/**
 * Authorize that this Image can be added/updated.
 *
 * @param app {App} The amon-master app.
 * @param callback {Function} `function (err)`. `err` may be:
 *      undefined: write is authorized
 *      InternalError: some other error in authorizing
 */
Image.prototype.authorizeWrite = function (app, callback) {
    callback();
};

Image.prototype.authorizeDelete = function (app, callback) {
    callback();
};



/**
 * Get a probe.
 *
 * @param app {App} The IMGAPI App.
 * @param uuid {String} The image UUID.
 * @param callback {Function} `function (err, image)`
 */
Image.get = function get(app, uuid, callback) {
    var dn = Image.dn(uuid);
    ufdsmodel.modelGet(app, Image, dn, app.log, callback);
};


/**
 * Validate the raw data and optionally massage some fields.
 *
 * @param app {App} The amon-master app.
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

    // published_at (ISO 8601 date string, e.g. "2012-12-25T12:00:00.123Z")
    var PUBLISHED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/
    if (raw.published_at === undefined) {
        errs.push({field: 'published_at', code: 'MissingParameter'});
    } else if (!PUBLISHED_AT_RE.test(raw.published_at)) {
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
 * @param data {Object} The probe data.
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
        published_at: (new Date()).toISOString(),
        os: data.os,
        disabled: data.disabled || false,
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
    return ufdsmodel.requestCreate(req, res, next, Image);
}

//function apiPutImage(req, res, next) {
//  return ufdsmodel.requestPut(req, res, next, Image);
//}

//function apiDeleteImage(req, res, next) {
//  return ufdsmodel.requestDelete(req, res, next, Image);
//}


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
        apiCreateImage);
    //server.put(
    //  {path: '/images/:uuid', name: 'PutImage'},
    //  apiPutImage);
    //server.del(
    //  {path: '/images/:uuid', name: 'DeleteImage'},
    //  apiDeleteImage);
}



//---- exports

module.exports = {
    Image: Image,
    mountApi: mountApi
};
