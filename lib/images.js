/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * IMGAPI model and endpoints for '/images/...'.
 */

var debug = console.warn;
var util = require('util'),
    format = util.format;
var fs = require('fs');
var crypto = require('crypto');

var assert = require('assert-plus');
var genUuid = require('node-uuid');
var restify = require('restify');
var async = require('async');


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
 * @param raw {Object} The raw instance data from the DB (or manually in
 *      that form). E.g.:
 *          { dn: 'image=:uuid, ou=images, o=smartdc',
 *            uuid: ':uuid',
 *            ...
 *            objectclass: 'image' }
 * @throws {Error} if the given data is invalid.
 */
function Image(raw) {
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

    this.raw = Image.validate(rawCopy);

    this.name = this.raw.name;
    this.description = this.raw.description;
    this.owner = this.raw.owner;
    this.type = this.raw.type;
    this.os = this.raw.os;
    this.published_at = this.raw.published_at &&
        new Date(this.raw.published_at);
    this.datacenters = this.raw.datacenter;
    this.acl = this.raw.acl;
    this.disabled = boolFromString(this.raw.disabled, false, 'raw.disabled');
    this.activated = boolFromString(this.raw.activated, false, 'raw.activated');
    this.public = boolFromString(this.raw.public, false, 'raw.public');
    this.requirements = (this.raw.requirements
        ? JSON.parse(this.raw.requirements) : undefined);
    this.generate_passwords = boolFromString(this.raw.generate_passwords,
        true, 'raw.generate_passwords');
    this.users = (this.raw.users ? JSON.parse(this.raw.users) : undefined);

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

/**
 * Return the API view of this Image's data.
 */
Image.prototype.serialize = function serialize() {
    var data = {
        uuid: this.uuid,
        owner: this.owner,
        name: this.name,
        state: this.state,
        disabled: this.disabled,
        public: this.public,
        published_at: this.raw.published_at,
        type: this.type,
        os: this.os,
        files: this.files.map(
            function (f) { return {sha1:f.sha1,size:f.size} })
    };
    if (!this.public) data.acl = this.acl;
    if (this.description) data.description = this.description;
    if (this.urn) data.urn = this.urn;
    if (this.requirements) data.requirements = this.requirements;
    if (this.users) data.users = this.users;
    if (this.raw.generate_passwords)
        data.generate_passwords = this.generate_passwords;
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
 *      - `contentMD5` {String}
 *      - `mtime` {String} ISO date string
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
    Image.modify(app, this, change, log, callback);
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

    var modification = {};
    // If `published_at` is already set, then this was added via
    // 'AdminImportImage' or 'MigrateImage'.
    if (!this.raw.published_at) {
        this.published_at = new Date();
        this.raw.published_at = this.published_at.toISOString();
        modification.published_at = this.raw.published_at;
    }
    this.activated = true;
    this.raw.activated = 'true';
    modification.activated = this.raw.activated;
    var change = {
        operation: 'replace',
        modification: modification
    };
    Image.modify(app, this, change, log, callback);
}


/**
 * Get an image from the database.
 *
 * @param app {App} The IMGAPI App.
 * @param uuid {String} The image UUID.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err, image)`
 */
Image.get = function getImage(app, uuid, log, callback) {
    log.trace({uuid: uuid}, 'Image.get');
    assert.object(app, 'app');
    assert.string(uuid, 'uuid');
    assert.object(log, 'log');
    assert.func(callback, 'callback');

    // Check cache. "cached" is `{err: <error>, data: <data>}`.
    var cacheScope = 'ImageGet';
    var cached = app.cacheGet(cacheScope, uuid);
    if (cached) {
        if (cached.err) {
            return callback(cached.err);
        } else {
            try {
                return callback(null, new Image(cached.data));
            } catch (e) {
                // Drop from the cache and carry on.
                log.warn(e,
                    'error in cached data (cacheScope="%s", uuid="%s")',
                    cacheScope, uuid);
                app.cacheDel(cacheScope, uuid);
            }
        }
    }

    function cacheAndCallback(err, item) {
        app.cacheSet(cacheScope, uuid, {err: err, data: item && item.raw});
        callback(err, item);
    }

    app.db.get(uuid, function (err, entry) {
        if (err) {
            if (err.httpCode === 503) {
                return callback(err);  // don't cache 503
            } else {
                return cacheAndCallback(err);
            }
        }
        try {
            var item = new Image(entry);
        } catch (err2) {
            log.warn({err: err2, entry: entry}, 'invalid image entry');
            return callback(new errors.ResourceNotFoundError('not found'));
        }
        cacheAndCallback(null, item);
    });
};


/**
 * Modify an image in the database.
 *
 * @param app {App}
 * @param image {Image}
 * @param changes {Object|Array} An array of or a single LDAP change as per
 *      <http://ldapjs.org/client.html#modify>
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)`
 */
Image.modify = function modifyImage(app, image, changes, log, callback) {
    assert.object(app, 'app');
    assert.object(image, 'image');
    assert.object(changes, 'changes');
    assert.object(log, 'log');
    assert.func(callback, 'callback');

    var uuid = image.uuid;
    log.trace({uuid: uuid, changes: changes}, 'Image.modify');
    app.db.modify(uuid, changes, function (err) {
        if (err) {
            log.error({err: err, uuid: uuid}, 'error updating model');
            callback(err);
        } else {
            log.trace({uuid: uuid}, 'Image.modify complete');
            app.cacheInvalidateWrite('Image', image);
            callback();
        }
    });
};

/**
 * Validate the raw data and optionally massage some fields.
 *
 * @param raw {Object} The raw data for this object.
 * @returns {Object} The raw data for this object, possibly massaged to
 *      normalize field values.
 * @throws {errors.ValidationFailedError} if the raw data is invalid.
 * @throws {errors.InternalError} for other errors.
 */
Image.validate = function validateImage(raw) {
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

    // owner
    if (!raw.owner) {
        errs.push({field: 'owner', code: 'MissingParameter'});
    } else if (! UUID_RE.test(raw.owner)) {
        errs.push({field: 'owner', code: 'Invalid'});
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

    // description
    if (raw.description && raw.description.length > 512) {
        errs.push({
            field: 'description',
            code: 'Invalid',
            message: 'image description is too long (max 512 characters)'
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

    // public
    var public = false;
    if (raw.public === undefined) {
        errs.push({field: 'public', code: 'MissingParameter'});
    } else {
        public = boolFromString(raw.public);
        if (typeof (public) !== 'boolean') {
            errs.push({
                field: 'public',
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
        raw.datacenter = [];
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

    // acl
    if (raw.acl === undefined) {
        raw.acl = [];
    } else if (typeof (raw.acl) === 'string') {
        if (! UUID_RE.test(raw.acl)) {
            errs.push({field: 'acl', code: 'Invalid'});
        } else {
            raw.acl = [raw.acl];
        }
    } else if (!Array.isArray(raw.acl)) {
        errs.push({
            field: 'acl',
            code: 'Invalid',
            message: format('invalid image "acl" (not an array): %s',
                raw.acl)
        });
    } else {
        for (var i = 0; i < raw.acl.length; i++) {
            if (! UUID_RE.test(raw.acl)) {
                errs.push({
                    field: 'acl',
                    code: 'Invalid',
                    message: format(
                        'invalid image "acl" (item %d is not a UUID): %s',
                        i, raw.acl)
                });
                break;
            }
        }
    }

    // requirements
    var reqs;
    try {
        reqs = raw.requirements && JSON.parse(raw.requirements);
    } catch (e) {
        errs.push({
            field: 'requirements',
            code: 'Invalid',
            message: format(
                'invalid image "requirements" (not parseable JSON): %s',
                raw.requirements)
        });
    }
    if (reqs === undefined) {
        // pass through, 'requirements' is optional
    } else if (typeof(reqs) !== 'object') {
        errs.push({
            field: 'requirements',
            code: 'Invalid',
            message: format('invalid image "requirements" (not an object): %j',
                raw.requirements)
        });
    } else {
        // requirements.networks
        if (reqs.networks === undefined) {
            // pass through
        } else if (!Array.isArray(reqs.networks)) {
            errs.push({
                field: 'requirements.networks',
                code: 'Invalid',
                message: format(
                    'invalid image "requirements.networks" (not an array): %j',
                    reqs.networks)
            });
        } else {
            reqs.networks.forEach(function (n) {
                if (typeof(n) !== 'object'
                    || n.name === undefined
                    || n.description === undefined
                    || Object.keys(n).length !== 2) {
                    errs.push({
                        field: 'requirements.networks',
                        code: 'Invalid',
                        message: format(
                            'invalid image "requirements.networks" entry: %j',
                            n)
                    });
                }
            });
        }
        delete reqs.networks;

        // requirements.ssh_key
        if (reqs.ssh_key === undefined) {
            // pass through
        } else if (typeof(reqs.ssh_key) !== 'boolean') {
            errs.push({
                field: 'requirements.ssh_key',
                code: 'Invalid',
                message: format(
                    'invalid image "requirements.ssh_key" (not a boolean): %j',
                    reqs.ssh_key)
            });
        }
        delete reqs.ssh_key;

        // requirements.min_ram & requirements.max_ram
        // - both are positive integers, and the interval must be sane
        var min_ram, max_ram;
        if (reqs.min_ram) {
            if (typeof (reqs.min_ram) != 'number' ||
                !isInteger(reqs.min_ram) ||
                reqs.min_ram < 0) {
                errs.push({
                    field: 'requirements.min_ram',
                    code: 'Invalid',
                    message: format('invalid image "requirements.min_ram" '
                        + '(not a positive integer): %j', reqs.min_ram)
                });
            } else {
                min_ram = reqs.min_ram;
            }
        }
        delete reqs.min_ram;
        if (reqs.max_ram) {
            if (typeof (reqs.max_ram) != 'number' ||
                !isInteger(reqs.max_ram) ||
                reqs.max_ram < 0) {
                errs.push({
                    field: 'requirements.max_ram',
                    code: 'Invalid',
                    message: format('invalid image "requirements.max_ram" '
                        + '(not a positive integer): %j', reqs.max_ram)
                });
            } else {
                max_ram = reqs.max_ram;
            }
        }
        delete reqs.max_ram;
        // max-min can be zero if max == min, which is allowed.
        if (max_ram && min_ram && (max_ram - min_ram < 0)) {
            errs.push({
                field: 'requirements.max_ram',
                code: 'Invalid',
                message: format('min_ram must be <= max_ram, but:'
                    + 'min_ram=%s, max_ram=%s', min_ram, max_ram)
            });
        }

        // unknown requirements
        Object.keys(reqs).forEach(function (field) {
            errs.push({
                field: field,
                code: 'Invalid',
                message: format('unsupported requirement "%s"', field)
            });
        });
    }

    // users
    var users;
    try {
        users = raw.users && JSON.parse(raw.users);
    } catch (e) {
        errs.push({
            field: 'users',
            code: 'Invalid',
            message: format(
                'invalid image "users" (not parseable JSON): %s',
                raw.users)
        });
    }
    if (users === undefined) {
        // pass through
    } else if (!Array.isArray(users)) {
        errs.push({
            field: 'users',
            code: 'Invalid',
            message: format('invalid image "users" (not an array): %j',
                users)
        });
    } else {
        users.forEach(function (u) {
            if (typeof(u) !== 'object'
                || u.name === undefined
                || Object.keys(u).length !== 1) {
                errs.push({
                    field: 'users',
                    code: 'Invalid',
                    message: format('invalid image "users" entry: %j', u)
                });
            }
        });
    }

    // generate_passwords
    if (raw.generate_passwords === undefined) {
        // pass through
    } else {
        var generate_passwords = boolFromString(raw.generate_passwords);
        if (typeof (generate_passwords) !== 'boolean') {
            errs.push({
                field: 'generate_passwords',
                code: 'Invalid',
                message: format('invalid image "generate_passwords" '
                    + '(not an accepted boolean value): %j',
                    raw.generate_passwords)
            });
        }
    }

    if (errs.length) {
        var fields = errs.map(function (e) { return e.field });
        throw new errors.ValidationFailedError(
            "invalid image data: " + fields.join(', '), errs);
    }
    return raw;
};


/**
 * Normalize image manifest data (in-place).
 *
 * Primarily this is about converting old dsmanifest fields to the current
 * modern form.
 */
Image.normalizeManifest = function normalizeImageManifest(data) {
    assert.object(data, 'data');

    if (data.creator_uuid) {
        assert.ok(data.owner === undefined, 'data.owner && data.creator_uuid');
        data.owner = data.creator_uuid;
    }
    delete data.creator_uuid;
    delete data.vendor_uuid;
    delete data.creator_name;
    delete data.cloud_name;

    // TODO: Whether `version` is being dropped is still up in the air.
    if (data.version) {
        data.name = data.name + '-' + data.version;
    }
    delete data.version;

    if (data.restricted_to_uuid) {
        assert.ok(data.public === undefined,
            'data.restricted_to_uuid && data.public');
        data.public = false;
        data.acl = [data.restricted_to_uuid];
        delete data.restricted_to_uuid;
        delete data.owner_uuid;
    } else {
        data.public = true;
    }

    if (!data.published_at && data.created_at) {
        data.published_at = data.created_at;
    }
    // published_at: YYYY-MM-DDTHH:MMZ -> YYYY-MM-DDTHH:MM:SSZ
    // (IMGAPI is being more picky about the date format.)
    no_secs = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z/;
    if (data.published_at && no_secs.test(data.published_at)) {
        data.published_at = data.published_at.slice(0, -1) + ':00Z'
    }

    // Deprecated.
    delete data.platform_type;
    delete data.created_at;
    delete data.updated_at;
};


/**
 * Create a new Image from request data.
 *
 * @param app {App}
 * @param data {Object} The probe data in "external" form (as opposed to
 *      the "raw" form stored in the db).
 * @param isImport {Boolean} Indicates if this is an import. An import
 *      allows (and expects) the 'uuid' and 'published_at' fields.
 * @param callback {Function} `function (err, probe)`.
 */
Image.create = function createImage(data, isImport, callback) {
    assert.object(data, 'data');
    assert.bool(isImport, 'isImport');
    assert.func(callback, 'callback');

    // Normalize from possible dsmanifest (v1) input
    var data = objCopy(data);
    Image.normalizeManifest(data);

    // Put together the raw data (where "raw" means in the form stored
    // in the database and used by the "Image" object).
    var raw = {
        owner: data.owner,
        name: data.name,
        description: data.description,
        type: data.type,
        os: data.os,
        public: data.public || false,
        disabled: data.disabled || false,
        activated: false,
        acl: data.acl,
        objectclass: Image.objectclass
    };
    if (data.requirements !== undefined)
        raw.requirements = JSON.stringify(data.requirements);
    if (data.users !== undefined)
        raw.users = JSON.stringify(data.users);
    if (data.generate_passwords !== undefined)
        raw.generate_passwords = data.generate_passwords
    delete data.owner;
    delete data.name;
    delete data.description;
    delete data.type;
    delete data.os;
    delete data.public;
    delete data.disabled;
    delete data.acl;
    delete data.requirements;
    delete data.users;
    delete data.generate_passwords;
    if (isImport) {
        assert.string(data.uuid, 'data.uuid');
        assert.string(data.published_at, 'data.published_at');
        raw.uuid = data.uuid;
        raw.published_at = data.published_at;
        delete data.uuid;
        delete data.published_at;
        if (data.urn) {
            raw.urn = data.urn;
            delete data.urn;
        }
    } else {
        raw.uuid = genUuid();
    }

    // Error on extra spurious fields.
    delete data.files;
    delete data.state; // allow create from IMGAPI output
    var extraFields = Object.keys(data);
    if (extraFields.length > 0) {
        return callback(new errors.InvalidParameterError(
            format('invalid extra parameters: "%s"', extraFields.join('", "')),
            extraFields.map(function (f) { return {field:f,code:'Invalid'} })));
    }

    var image = null;
    try {
        image = new Image(raw);
    } catch (cErr) {
        return callback(cErr);
    }

    callback(null, image);
};


/**
 * Lookup (and cache) all images matching the given filter options.
 *
 * @param app {App}
 * @param options {Object} Optional filter fields. See `supportedFields`
 *      in the code below.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err, images)`
 */
Image.filter = function filterImages(app, options, log, callback) {
    // Validate.
    var supportedFields = {
        owner: 'str',
        activated: 'bool',
        disabled: 'bool',
        public: 'bool',
        name: '~',
        os: 'str',
        type: 'str',
        acl: 'str'
    };
    Object.keys(options).forEach(function (k) {
        if (!supportedFields[k]) {
            throw new TypeError(format(
                'unsupported Image.filter option: "%s"', k));
        }
    })

    // Build a stable cacheKey.
    var fields = Object.keys(options);
    fields.sort();
    var cacheKey = JSON.stringify(fields
        .filter(function (f) { return options[f] !== undefined })
        .map(function (f) { return [f, options[f]]; }));

    // Check cache. "cached" is `{err: <error>, data: <data>}`.
    var cacheScope = 'ImageList';
    var cached = app.cacheGet(cacheScope, cacheKey);
    if (cached) {
        log.trace({cacheKey: cacheKey, hit: cached}, 'Image.filter: cache hit');
        if (cached.err) {
            return callback(cached.err);
        }
        try {
            var items = cached.data.map(
                function (d) { return new Image(d); });
            return callback(null, items);
        } catch (e) {
            // Drop from the cache and carry on.
            log.warn('error in cached data (cacheScope=\'%s\', '
                + 'cacheKey=\'%s\'): %s', cacheScope, cacheKey, e);
            app.cacheDel(cacheScope, cacheKey);
        }
    }

    function cacheAndCallback(cErr, cItems) {
        var data = cItems && cItems.map(function (i) { return i.raw; });
        app.cacheSet(cacheScope, cacheKey, {err: cErr, data: data});
        callback(cErr, cItems);
    }

    // Do the search.
    app.db.search(options, function (err, rawItems) {
        if (err) {
            if (err.httpCode === 503) {
                return callback(err);  // don't cache 503
            } else {
                return cacheAndCallback(err);
            }
        }
        var images = [];
        for (var i = 0; i < rawItems.length; i++) {
            try {
                images.push(new Image(rawItems[i]));
            } catch (err2) {
                if (err2 instanceof restify.RestError) {
                    log.warn('Ignoring invalid raw image data (dn=\'%s\'): %s',
                        rawItems[i].dn, err2);
                } else {
                    log.error(err2,
                        'Unknown error creating Image with raw image data:',
                        rawItems[i]);
                }
            }
        }
        log.trace('Image.filter found images:', images);
        cacheAndCallback(null, images);
    });
};




//---- API controllers

/**
 * ListImages (GET /images?...)
 *
 * There are two basic use cases:
 * 1. Without 'account=$uuid'. Simple filtering based on the given values is done.
 *    This is expected to only be called by operators (e.g. via adminui).
 * 2. With 'account=$uuid'. Cloudapi calls to IMGAPI are expected to provide
 *    'account=<uuid-of-authenticated-account>'. The intention is to limit results
 *    to images that should be available to that account. That means:
 *    (a) images that they own ('owner=<uuid-of-account>'); and
 *    (b) other images to which they have access (active public images,
 *        activated private images for which ACLs give them access)
 */
function apiListImages(req, res, next) {
    req.log.trace({params: req.params}, 'ListImages entered');

    // Normalize the query fields.
    var query = {};
    if (!req.query.state || req.query.state === 'active') {
        query.activated = true;
        query.disabled = false;
    } else if (req.query.state === 'disabled') {
        query.activated = true;
        query.disabled = true;
    } else if (req.query.state === 'unactivated') {
        query.activated = false;
    } else if (req.query.state === 'all') {
    } else {
        return next(new errors.InvalidParameterError(
            'unknown state: "%s"', req.query.state))
    }
    if (req.query.public) {
        query.public = boolFromString(req.query.public, true, 'public');
    }
    ['name', 'owner', 'os', 'type', 'account'].forEach(function (f) {
        query[f] = req.query[f];
    });
    req.log.debug({query: query}, 'ListImages query')

    // Determine the appropriate queries to make. Usage of 'account=UUID'
    // complicates this.
    var filterOpts = [];
    if (!query.account) {
        // No 'account' specified: just a vanilla search.
        filterOpts.push({
            owner: query.owner,
            public: query.public,
            activated: query.activated,
            disabled: query.disabled,
            name: query.name,
            os: query.os,
            type: query.type,
        });
    } else if (!query.owner) {
        // 'account' specified:
        // 1. Matching images owned by the given account.
        filterOpts.push({
            owner: query.account,
            public: query.public,
            activated: query.activated,
            disabled: query.disabled,
            name: query.name,
            os: query.os,
            type: query.type
        });
        if (query.activated !== false && query.disabled !== true) {
            if (query.public !== false) {
                // 2. Public & active images.
                //    (This is expected to cache well for separate users.)
                filterOpts.push({
                    public: true,
                    activated: true,
                    disabled: false,
                    name: query.name,
                    os: query.os,
                    type: query.type
                });
            }
            if (!query.public) {
                // 3. Private & active images for which ACCOUNT is listing
                //    in 'acl'.
                filterOpts.push({
                    public: false,
                    activated: true,
                    disabled: false,
                    name: query.name,
                    os: query.os,
                    type: query.type,
                    acl: query.account
                });
            }
        }
    } else {
        // Both 'account' and 'owner' specified:
        if (query.account === query.owner) {
            // 1. If 'owner === account', then matching images owner by self.
            filterOpts.push({
                owner: query.owner,
                public: query.public,
                activated: query.activated,
                disabled: query.disabled,
                name: query.name,
                os: query.os,
                type: query.type
            });
        } else if (query.activated !== false && query.disabled !== true) {
            if (query.public !== false) {
                // 2. Public & activated images by the 'owner'.
                filterOpts.push({
                    owner: query.owner,
                    public: true,
                    activated: true,
                    disabled: false,
                    name: query.name,
                    os: query.os,
                    type: query.type
                });
            }
            if (query.public !== true) {
                // 3. Private & activated images by the 'owner', for which
                //    'account' is listing in 'acl'.
                filterOpts.push({
                    owner: query.owner,
                    public: false,
                    activated: true,
                    disabled: false,
                    name: query.name,
                    os: query.os,
                    type: query.type,
                    acl: query.account
                });
            }
        }
    }
    req.log.trace({filterOpts: filterOpts}, 'ListImages filterOpts')

    var app = req._app;
    var imageByUuid = {}; // *set* of images to remove dups.
    async.forEach(filterOpts,
        function filterOne(opts, next) {
            Image.filter(app, opts, req.log, function (cErr, images) {
                if (cErr) {
                    return next(cErr);
                }
                req.log.debug({opts: opts, numImages: images.length},
                    'filterOne result');
                for (var i = 0; i < images.length; i++) {
                    imageByUuid[images[i].uuid] = images[i];
                }
                next();
            });
        },
        function doneFiltering(kErr) {
            if (kErr) {
                return next(new errors.InternalError(kErr,
                    'error searching images'));
            }
            var data = [];
            var uuids = Object.keys(imageByUuid);
            req.log.debug({imageUuids: uuids}, 'doneFiltering');
            for (var i = 0; i < uuids.length; i++) {
                data.push(imageByUuid[uuids[i]].serialize());
            }
            res.send(data);
            next();
        }
    );
}


function apiGetImage(req, res, next) {
    res.send(req._image.serialize());
    next();
}


function apiCreateImage(req, res, next) {
    var log = req.log;
    var app = req._app;
    var data = req.body;

    var account;
    if (req.query.account) {
        account = req.query.account;
        if (!UUID_RE.test(account)) {
            return next(new errors.InvalidParameterError(
                format('invalid "account": not a UUID: "%s"', account),
                [{field: 'account', code: 'Invalid'}]));
        }

        if (!data.owner) {
            data.owner = account;
        } else if (data.owner !== account) {
            return next(new errors.InvalidParameterError(
                format('invalid owner: given owner, "%s", does not '
                    + 'match account, "%s"', data.owner, account),
                [{field: 'owner', code: 'Invalid'}]));
        }
    }

    log.info({data: data}, 'CreateImage: create it');
    Image.create(data, false, function (cErr, image) {
        if (cErr) {
            return next(cErr);
        }
        app.db.add(image.uuid, image.raw, function (addErr) {
            if (addErr) {
                log.error({uuid: image.uuid},
                    'error saving to database: raw data:', image.raw);
                return next(addErr);
            }
            app.cacheInvalidateWrite('Image', image);
            res.send(image.serialize());
            next();
        });
    });
}


function apiAdminImportImage(req, res, next) {
    if (req.query.action !== 'import')
        return next();

    var log = req.log;
    var app = req._app;
    var data = req.body;

    if (req.query.account) {
        return next(new errors.OperatorOnlyError());
    }
    if (req.params.uuid !== data.uuid) {
        return next(new errors.InvalidParameterError(
            format('URL UUID, "%s" and body UUID, "%s" do not match',
                req.params.uuid, data.uuid),
            [{field: 'uuid', code: 'Invalid'}]));
    }

    var uuid = data.uuid;
    log.debug({uuid: uuid}, 'AdminImportImage: check if image already exists');
    Image.get(app, data.uuid, log, function (gErr, image) {
        if (!gErr) {
            assert.object(image, 'image');
            return next(new errors.ImageUuidAlreadyExistsError(uuid));
        } else if (gErr.restCode !== 'ResourceNotFound') {
            return next(gErr);
        }

        log.debug({data: data}, 'AdminImportImage: create it');
        Image.create(data, true, function (cErr, image) {
            if (cErr) {
                return next(cErr);
            }
            app.db.add(image.uuid, image.raw, function (addErr) {
                if (addErr) {
                    log.error({uuid: image.uuid, raw: image.raw},
                        'error saving to database');
                    return next(addErr);
                }
                app.cacheInvalidateWrite('Image', image);
                res.send(image.serialize());
                next(false);
            });
        });
    });

}


function apiAddImageFile(req, res, next) {
    req.log.debug({image: req._image}, "AddImageFile: start")

    // Can't change files on an activated image.
    if (req._image.activated) {
        return next(new errors.ImageFilesImmutableError(req._image.uuid));
    }

    var finished = false;
    var stor;  // the storage class
    function finish(err) {
        if (finished) {
            return;
        }
        finished = true;
        if (err) {
            return next(new errors.InternalError(err,
                'error receiving image file: %s', err));
        }
        var file = {
            sha1: shasum.digest('hex'),
            size: Number(req.headers['content-length']),
            contentMD5: md5sum.digest('base64'),
            mtime: (new Date()).toISOString(),
            stor: stor.type
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
    var md5sum = crypto.createHash('md5');
    req.on('data', function (chunk) {
        shasum.update(chunk);
        md5sum.update(chunk);
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

    stor = req._app.storFromImage(req._image);
    stor.createImageFileWriteStream(req._image, function (sErr, stream) {
        if (sErr) {
            finish(err);
        }
        req.pipe(stream);
        req.resume(); // Was paused in `server.pre`.
    });
}


/**
 * Set file cache-related headers for GetImageFile before the
 * `conditionalRequest` middleware is run.
 */
function resGetImageFileCacheHeaders(req, res, next) {
    var image = req._image;
    if (image.files.length === 0) {
        return next(new errors.ResourceNotFoundError(
            "image '%s' has no file", image.uuid));
    }

    var file = image.files[0];
    res.header('Etag', file.sha1);
    res.header('Last-Modified', new Date(file.mtime));
    res.header('Content-Length', file.size);
    res.header('Content-Type', 'application/octet-stream');
    res.header('Content-MD5', file.contentMD5);

    next();
}

function apiGetImageFile(req, res, next) {
    var image = req._image;
    req.log.debug({image: image}, "GetImageFile: start")

    var finished = false;
    function finish(err) {
        if (finished) {
            return;
        }
        finished = true;
        if (err) {
            return next(new errors.InternalError(err,
                'error getting image file: %s', err));
        }
        next();
    }

    var file = req._image.files[0];
    assert.object(file, 'image.files[0]');
    var stor = req._app.getStor(file.stor);
    stor.createImageFileReadStream(req._image, function (sErr, stream) {
        // TODO: handle 404?
        if (sErr) {
            return finish(err);
        }
        stream.on('end', function () {
            req.log.trace('GetImageFile stream "end" event');
            finish();
        });
        stream.on('close', function () {
            req.log.trace('GetImageFile stream "close" event');
            finish();
        });
        stream.on('error', function (err) {
            finish(err);
        });
        stream.pipe(res);
    });
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
    var log = req.log;
    var image = req._image;
    var app = req._app;
    req.log.debug({image: image}, "DeleteImage: start");

    // Delete the model.
    // Note: We delete the manifest entry first to make sure the entry goes
    // away, if subsequent deletion of files from storage fails, then that is
    // just internally logged for operators to cleanup.
    app.db.del(image.uuid, function (delErr) {
        if (delErr) {
            return next(delErr);
        }
        app.cacheInvalidateDelete('Image', image);

        // Delete any files.
        async.forEach(
            image.files,
            function deleteOneFile(file, nextFile) {
                var stor = req._app.getStor(file.stor);
                stor.deleteImageFile(image, nextFile);
            },
            function doneDeletes(fileErr) {
                if (fileErr) {
                    log.error({err: fileErr, image: image},
                        'error deleting model file(s), this image may have '
                        + 'zombie files which must be remove manually by an '
                        + 'operator');
                }

                res.send(204);
                return next();
            }
        );
    });
}


/**
 * Ensure the 'uuid' request param is valid, else this is a 404.
 */
function reqValidUuid(req, res, next) {
    var uuid = req.params.uuid;
    if (!UUID_RE.test(uuid)) {
        var message = req.url + ' does not exist';
        return next(new errors.ResourceNotFoundError(message));
    }
    next();
}


/**
 * Restify handler to add `req._image` or respond with an appropriate
 * error.
 *
 * This is for endpoints at or under '/images/:uuid'.
 */
function reqGetImage(req, res, next) {
    var log = req.log;

    var account;
    if (req.query.account) {
        account = req.query.account;
        if (!UUID_RE.test(account)) {
            return next(new errors.InvalidParameterError(
                format('invalid "account": not a UUID: "%s"', account),
                [{field: 'account', code: 'Invalid'}]));
        }
    }

    var uuid = req.params.uuid;
    log.debug({uuid: uuid, account: account}, 'get image');
    Image.get(req._app, uuid, log, function (getErr, image) {
        if (getErr) {
            return next(getErr);
        }
        assert.ok(image);

        if (account) {
            // When `?account=$uuid` is used we restrict to images accessible
            // to this account -> 404 if no access.
            var access;
            if (image.owner === account) {
                // User's own image.
                access = true;
            } else if (!image.activated || image.disabled) {
                // Inactive image: can only see others' *active* images.
                log.debug({image: image, account: account},
                    'access denied: inactive image owned by someone else');
                access = false;
            } else if (image.public) {
                // Public active image.
                access = true;
            } else if (image.acl && image.acl.indexOf(account) !== -1) {
                // Private active image of which `account` is on the ACL.
                access = true;
            } else {
                log.debug({image: image, account: account},
                    'access denied: private image, account not on the ACL');
                access = false;
            }
            if (!access) {
                return next(new errors.ResourceNotFoundError(
                    'image not found'));
            }
        }

        req._image = image;
        next();
    });
}


/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 * @param reqPublicAuth {Function} A request middleware that handles auth for
 *      a public IMGAPI. It is attached to "write" endpoints. IMGAPI does
 *      not auth for "read" endpoints. Note that there is *separate*
 *      authorization for private and non-active images.
 */
function mountApi(server, reqPublicAuth) {
    server.get(
        {path: '/images', name: 'ListImages'},
        apiListImages);
    server.get(
        {path: '/images/:uuid', name: 'GetImage'},
        reqValidUuid,
        reqGetImage,    // add `req._image`, ensure access
        apiGetImage);
    server.post(
        {path: '/images', name: 'CreateImage'},
        reqPublicAuth,
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
        reqPublicAuth,
        reqValidUuid,
        reqGetImage,    // add `req._image`, ensure access
        apiAddImageFile);
    server.get(
        {path: '/images/:uuid/file', name: 'GetImageFile'},
        reqValidUuid,
        reqGetImage,    // add `req._image`, ensure access
        resGetImageFileCacheHeaders,
        restify.conditionalRequest(),
        apiGetImageFile);
    server.post(
        {path: '/images/:uuid', name: 'UpdateImage'},
        reqPublicAuth,
        reqValidUuid,
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
        apiAdminImportImage,    // before `reqGetImage` b/c shouldn't be one
        reqGetImage,            // add `req._image`, ensure access
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
        reqPublicAuth,
        reqValidUuid,
        reqGetImage,  // ensure have access to image before deleting
        apiDeleteImage);
}



//---- exports

module.exports = {
    Image: Image,
    mountApi: mountApi,
};
