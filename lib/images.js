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
var url = require('url');

var assert = require('assert-plus');
var genUuid = require('node-uuid');
var restify = require('restify');
var async = require('async');


var utils = require('./utils'),
    objCopy = utils.objCopy,
    boolFromString = utils.boolFromString,
    isPositiveInteger = utils.isPositiveInteger;
var errors = require('./errors');



//---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var MAX_BILLING_TAG_LENGTH = 128;
var MAX_URL_LENGTH = 128;
var MAX_ICON_FILE_SIZE = 128*1024; // 128Kb
var ICON_CONTENT_TYPES = ['image/jpeg', 'image/gif', 'image/png'];
var VALID_FILE_COMPRESSIONS = ['gzip', 'bzip2', 'none'];



//---- Image model

/**
 * Create a Image object from raw DB (i.e. UFDS) data.
 * External usage should use `Image.create(...)`.
 *
 * @param app {App}
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
            format('invalid Image data: given "dn" (%s) does not ' +
                'match built dn (%s)', raw.dn, this.dn));
    }

    var rawCopy = objCopy(raw);
    delete rawCopy.dn;
    delete rawCopy.controls;

    this.raw = Image.validate(app, rawCopy);

    this.name = this.raw.name;
    this.version = this.raw.version;
    this.description = this.raw.description;
    this.homepage = this.raw.homepage;
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
    this.icon = (this.raw.icon ? JSON.parse(this.raw.icon) : undefined);
    this.requirements = (this.raw.requirements ?
        JSON.parse(this.raw.requirements) : undefined);
    this.generate_passwords = boolFromString(this.raw.generate_passwords,
        true, 'raw.generate_passwords');
    this.users = (this.raw.users ? JSON.parse(this.raw.users) : undefined);
    this.billing_tags = this.raw.billing_tags;
    this.traits = (this.raw.traits ? JSON.parse(this.raw.traits) : undefined);
    this.inherited_directories = (this.raw.inherited_directories ?
        JSON.parse(this.raw.inherited_directories) : undefined);
    this.urn = this.raw.urn;
    this.nic_driver = this.raw.nic_driver;
    this.disk_driver = this.raw.disk_driver;
    this.cpu_type = this.raw.cpu_type;
    this.image_size = this.raw.image_size;

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
                self._filesCache = JSON.parse(self.raw.files);
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
 *
 * @param mode {string} If API mode is `public` some fields are not displayed
 */
Image.prototype.serialize = function serialize(mode) {
    assert.string(mode, 'mode');
    var data = {
        uuid: this.uuid,
        owner: this.owner,
        name: this.name,
        version: this.version,
        state: this.state,
        disabled: this.disabled,
        public: this.public,
        published_at: this.raw.published_at,
        type: this.type,
        os: this.os,
        files: this.files.map(function (f) {
            return {sha1: f.sha1, size: f.size, compression: f.compression};
        })
    };
    if (!this.public) data.acl = this.acl;
    if (this.description) data.description = this.description;
    if (this.homepage) data.homepage = this.homepage;
    if (this.icon) data.icon = true;
    if (this.urn) data.urn = this.urn;
    if (this.requirements) data.requirements = this.requirements;
    if (this.users) data.users = this.users;
    if (this.acl) data.acl = this.acl;
    if (this.raw.generate_passwords)
        data.generate_passwords = this.generate_passwords;
    if (this.inherited_directories)
        data.inherited_directories = this.inherited_directories;
    if (this.nic_driver) data.nic_driver = this.nic_driver;
    if (this.disk_driver) data.disk_driver = this.disk_driver;
    if (this.cpu_type) data.cpu_type = this.cpu_type;
    if (this.image_size) data.image_size = this.image_size;
    if (mode !== 'public') {
        if (this.billing_tags) data.billing_tags = this.billing_tags;
        if (this.traits) data.traits = this.traits;
    }
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
    };
    Image.modify(app, this, change, log, callback);
};


/**
 * Add an uploaded icon to this Image instance. The file will have already
 * be written out (to disk or to manta, depending).
 *
 * @param app {App} The IMGAPI app.
 * @param file {Object} Describes the uploaded icon, with keys:
 *      - `sha1` {String}
 *      - `size` {Integer}
 *      - `contentMD5` {String}
 *      - `contentType` {String}
 *      - `mtime` {String} ISO date string
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)` where `err` is some internal
 *      detail (i.e. it should be wrapped for the user).
 */
Image.prototype.addIcon = function addIcon(app, icon, log, callback) {
    this.raw.icon = JSON.stringify(icon);
    this.icon = icon;
    var change = {
        operation: 'replace',
        modification: {
            icon: this.raw.icon
        }
    };
    Image.modify(app, this, change, log, callback);
};


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
};


/**
 * Enable or Disable this Image. The second argument to this function defines
 * which action is performed
 *
 * @param app {App} The IMGAPI app.
 * @param disabled {Boolean} Value to write for the disabled attribute.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)` where `err` is okay to
 *      use for an API reponse (i.e. doesn't expose internal details).
 */
Image.prototype.disable = function enable(app, disabled, log, callback) {
    var modification = {};
    this.disabled = disabled;
    this.raw.disabled = disabled;
    modification.disabled = this.raw.disabled;
    var change = {
        operation: 'replace',
        modification: modification
    };
    Image.modify(app, this, change, log, callback);
};


/**
 * Adds more UUIDs to the Image ACL. If any of the UUIDs is already in the ACL
 * it gets ignored.
 *
 * @param app {App} The IMGAPI app.
 * @param uuids {Array} List of UUIDs to add to the ACL
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)` where `err` is okay to
 *      use for an API reponse (i.e. doesn't expose internal details).
 */
Image.prototype.addAcl = function addAcl(app, uuids, log, callback) {
    var acl = this.acl;
    if (acl === undefined) {
        acl = [];
    }

    for (var i = 0; i < uuids.length; i++) {
        var uuid = uuids[i];
        if (acl.indexOf(uuid) === -1) {
            acl.push(uuid);
        }
    }

    var modification = {};
    this.acl = acl;
    this.raw.acl = acl;
    modification.acl = this.raw.acl;
    var change = {
        operation: 'replace',
        modification: modification
    };
    Image.modify(app, this, change, log, callback);
};


/**
 * Removes UUIDs from the Image ACL. If any of the UUIDs is not in the ACL
 * it gets ignored.
 *
 * @param app {App} The IMGAPI app.
 * @param uuids {Array} List of UUIDs to remove from the ACL
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)` where `err` is okay to
 *      use for an API reponse (i.e. doesn't expose internal details).
 */
Image.prototype.removeAcl = function removeAcl(app, uuids, log, callback) {
    var acl = this.acl;
    if (acl === undefined) {
        return callback(null);
    }

    var newAcl = [];
    for (var i = 0; i < acl.length; i++) {
        var uuid = acl[i];
        if (uuids.indexOf(uuid) === -1) {
            newAcl.push(uuid);
        }
    }

    var operation, modification;
    if (newAcl.length) {
        operation = 'replace';
        modification = { acl: newAcl };
    } else {
        newAcl = undefined;
        operation = 'delete';
        modification =  { acl: acl };
    }

    this.acl = newAcl;
    this.raw.acl = newAcl;
    var change = {
        operation: operation,
        modification: modification
    };
    Image.modify(app, this, change, log, callback);
};


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
                return callback(null, new Image(app, cached.data));
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
        var item;
        try {
            item = new Image(app, entry);
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
 * @param app {App}
 * @param raw {Object} The raw data for this object.
 * @returns {Object} The raw data for this object, possibly massaged to
 *      normalize field values.
 * @throws {errors.ValidationFailedError} if the raw data is invalid.
 * @throws {errors.InternalError} for other errors.
 */
Image.validate = function validateImage(app, raw) {
    assert.object(app, 'app');
    assert.object(raw, 'raw');

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

    // version
    if (!raw.version) {
        errs.push({field: 'version', code: 'MissingParameter'});
    } else if (raw.version.length > 128) {
        errs.push({
            field: 'version',
            code: 'Invalid',
            message: 'image version is too long (max 128 characters)'
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

    // homepage
    if (raw.homepage) {
        var homepage = url.parse(raw.homepage);
        if (homepage.protocol === undefined || (homepage.protocol !== 'http:' &&
            homepage.protocol !== 'https:')) {
            errs.push({
                field: 'homepage',
                code: 'Invalid',
                message: 'invalid image homepage URL protocol'
            });
        } else if (raw.homepage.length > MAX_URL_LENGTH) {
            errs.push({
                field: 'homepage',
                code: 'Invalid',
                message: format('image homepage URL is too long ' +
                    '(max %d characters)', MAX_URL_LENGTH)
            });
        }
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
        } else if (app.mode === 'public' && !public) {
            errs.push({
                field: 'public',
                code: 'Invalid',
                message: 'private images are not allowed on a public Images API'
            })
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
            message: 'invalid image "files": too many files'
        });
    } else if (files.length === 1) {
        var file = files[0];
        if (!file.sha1) {
            errs.push({
                field: 'files',
                code: 'Invalid',
                message: 'invalid image "files": file missing "sha1" field'
            });
        }
        if (!file.size) {
            errs.push({
                field: 'files',
                code: 'Invalid',
                message: format(
                    'invalid image "files": file missing "size" field')
            });
        }
        if (!file.compression) {
            errs.push({
                field: 'files',
                code: 'Invalid',
                message: 'invalid image "files": file missing "compression" field'
            });
        } else if (VALID_FILE_COMPRESSIONS.indexOf(file.compression) === -1) {
            errs.push({
                field: 'files',
                code: 'Invalid',
                message: format(
                    'invalid image "files": invalid compression "%s" ' +
                    '(must be one of %s)', file.compression,
                    VALID_FILE_COMPRESSIONS.join(', '))
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
            if (! UUID_RE.test(raw.acl[i])) {
                errs.push({
                    field: 'acl',
                    code: 'Invalid',
                    message: format(
                        'invalid image "acl" (item %d is not a UUID): %s',
                        i, raw.acl[i])
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
            if (!isPositiveInteger(reqs.min_ram)) {
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
            if (!isPositiveInteger(reqs.max_ram)) {
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

        // requirements.min_platform & requirements.max_platform
        // tuples of semver, date -> [ ["7.0", "2012-12-10"], ["6.5", "2013-01-01"] ]
        if (reqs.min_platform) {
            if (!Array.isArray(reqs.min_platform)
                || reqs.min_platform.length == 0) {
                errs.push({
                    field: 'requirements.min_platform',
                    code: 'Invalid',
                    message: format('invalid image "requirements.min_platform" '
                        + '(not an array): %j', reqs.min_platform)
                });
            } else {
                reqs.min_platform.forEach(function (p) {
                    if (!Array.isArray(p) || p.length !== 2) {
                        errs.push({
                            field: 'requirements.min_platform',
                            code: 'Invalid',
                            message: format('invalid image '
                                + '"requirements.min_platform" entry: %j '
                                + 'must be a [semver, date] pair', p)
                        });
                    }
                });
            }
        }
        delete reqs.min_platform;
        if (reqs.max_platform) {
            if (!Array.isArray(reqs.max_platform)
                || reqs.min_platform.length == 0) {
                errs.push({
                    field: 'requirements.max_platform',
                    code: 'Invalid',
                    message: format('invalid image "requirements.max_platform" '
                        + '(not an array): %j', reqs.min_platform)
                });
            } else {
                reqs.max_platform.forEach(function (p) {
                    if (!Array.isArray(p) || p.length !== 2) {
                        errs.push({
                            field: 'requirements.max_platform',
                            code: 'Invalid',
                            message: format('invalid image '
                                + '"requirements.max_platform" entry: %j '
                                + 'must be a [semver, date] pair', p)
                        });
                    }
                });
            }
        }
        delete reqs.max_platform;

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

    // billing_tags
    if (raw.billing_tags === undefined) {
        raw.billing_tags = [];
    } else if (typeof (raw.billing_tags) === 'string') {
        if (raw.billing_tags.length > MAX_BILLING_TAG_LENGTH) {
            errs.push({
                field: 'billing_tags',
                code: 'Invalid',
                message: format('invalid image "billing_tags" entry: %s',
                    raw.billing_tags)
            });
        } else {
            raw.billing_tags = [raw.billing_tags];
        }
    } else if (!Array.isArray(raw.billing_tags)) {
        errs.push({
            field: 'billing_tags',
            code: 'Invalid',
            message: format('invalid image "billing_tags" (not an array): %s',
                raw.billing_tags)
        });
    } else {
        raw.billing_tags.forEach(function (t) {
            if (typeof (t) !== 'string' || t.length > MAX_BILLING_TAG_LENGTH) {
                errs.push({
                    field: 'billing_tags',
                    code: 'Invalid',
                    message: format('invalid image "billing_tags" entry: %s', t)
                });
            }
        });
    }

    // traits
    var traits;
    try {
        traits = raw.traits && JSON.parse(raw.traits);
    } catch (e) {
        errs.push({
            field: 'traits',
            code: 'Invalid',
            message: format(
                'invalid image "traits" (not parseable JSON): %s',
                raw.traitValue)
        });
    }
    if (traits === undefined) {
        // pass through, 'traits' is optional
    } else if (typeof(traits) !== 'object') {
        errs.push({
            field: 'traits',
            code: 'Invalid',
            message: format('invalid image "traits" (not an object): %j',
                raw.traits)
        });
    } else {
        var traitKeys = Object.keys(traits);
        for (var i = 0; i < traitKeys.length; i++) {
            var traitValue = traits[traitKeys[i]];
            // Only allow strings, arrays or booleans
            if (typeof (traitValue) !== 'string' &&
                typeof (traitValue) !== 'boolean' &&
                !Array.isArray(traitValue)) {
                errs.push({
                    field: 'traits',
                    code: 'Invalid',
                    message: format('invalid image "traits" entry: (%s, %j)',
                        traitKeys, traitValue)
                });
            }
        }
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

    // inherited_directories
    var inherited_directories;
    try {
        inherited_directories = (raw.inherited_directories &&
            JSON.parse(raw.inherited_directories));
    } catch (e) {
        errs.push({
            field: 'inherited_directories',
            code: 'Invalid',
            message: format(
                'invalid image "inherited_directories" (not parseable JSON): %s',
                raw.inherited_directories)
        });
    }
    if (inherited_directories === undefined) {
        // pass through
    } else if (raw.type !== 'zone-dataset') {
        errs.push({
            field: 'inherited_directories',
            code: 'Invalid',
            message: format('invalid image "inherited_directories" ' +
                '(only valid for a type:zone-dataset image): %j',
                inherited_directories)
        });
    } else if (!Array.isArray(inherited_directories)) {
        errs.push({
            field: 'inherited_directories',
            code: 'Invalid',
            message: format(
                'invalid image "inherited_directories" (not an array): %j',
                inherited_directories)
        });
    } else {
        inherited_directories.forEach(function (i) {
            if (typeof(i) !== 'string') {
                errs.push({
                    field: 'inherited_directories',
                    code: 'Invalid',
                    message: format(
                        'invalid image "inherited_directories" entry: %j', i)
                });
            }
        });
    }

    // zvol extra params
    if (raw.type === "zvol") {
        if (raw.nic_driver === undefined) {
            errs.push({field: 'nic_driver', code: 'MissingParameter'});
        } else if (typeof(raw.nic_driver) !== 'string') {
            errs.push({
                field: 'nic_driver',
                code: 'Invalid',
                message: format(
                    'invalid image nic_driver: "%s" (must be a string)',
                    raw.nic_driver)
            });
        }

        if (raw.disk_driver === undefined) {
            errs.push({field: 'disk_driver', code: 'MissingParameter'});
        } else if (typeof(raw.disk_driver) !== 'string') {
            errs.push({
                field: 'disk_driver',
                code: 'Invalid',
                message: format(
                    'invalid image disk_driver: "%s" (must be a string)',
                    raw.disk_driver)
            });
        }

        if (raw.cpu_type === undefined) {
            errs.push({field: 'cpu_type', code: 'MissingParameter'});
        } else if (typeof(raw.cpu_type) !== 'string') {
            errs.push({
                field: 'cpu_type',
                code: 'Invalid',
                message: format(
                    'invalid image cpu_type: "%s" (must be a string)',
                    raw.cpu_type)
            });
        }

        if (raw.image_size === undefined) {
            errs.push({field: 'image_size', code: 'MissingParameter'});
        } else {
            var image_size = Number(raw.image_size);
            if (!isPositiveInteger(image_size)) {
                errs.push({
                    field: 'image_size',
                    code: 'Invalid',
                    message: format(
                        'invalid image image_size: "%s" (must be a positive integer)',
                        raw.image_size)
                });
            }
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
 * This about converting old dsmanifest fields to the current modern form.
 */
Image.normalizeManifest = function normalizeImageManifest(data) {
    assert.object(data, 'data');

    var is65LegacyManifest = (data.creator_uuid !== undefined);
    if (!is65LegacyManifest) {
        return data;
    }

    if (data.creator_uuid) {
        assert.ok(data.owner === undefined, 'data.owner && data.creator_uuid');
        data.owner = data.creator_uuid;
    }
    delete data.creator_uuid;
    delete data.vendor_uuid;
    delete data.creator_name;
    delete data.cloud_name;

    // Bogus field in some datasets.joyent.com/datasets (DATASET-629).
    delete data.creator_admin;

    if (data.restricted_to_uuid) {
        assert.ok(data.public === undefined,
            'data.restricted_to_uuid && data.public');
        data.public = false;
        data.acl = [data.restricted_to_uuid];
    } else {
        data.public = true;
    }
    delete data.restricted_to_uuid;
    delete data.owner_uuid;

    if (!data.published_at && data.created_at) {
        data.published_at = data.created_at;
    }
    // published_at: YYYY-MM-DDTHH:MMZ -> YYYY-MM-DDTHH:MM:SSZ
    // (IMGAPI is being more picky about the date format.)
    no_secs = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z/;
    if (data.published_at && no_secs.test(data.published_at)) {
        data.published_at = data.published_at.slice(0, -1) + ':00Z'
    }

    // Deprecated long ago, now dropped.
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
Image.create = function createImage(app, data, isImport, callback) {
    assert.object(app, 'app');
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
        version: data.version,
        type: data.type,
        os: data.os,
        public: data.public || false,
        disabled: data.disabled || false,
        activated: false,
        acl: data.acl,
        objectclass: Image.objectclass
    };
    if (data.description)
        raw.description = data.description;
    if (data.homepage)
        raw.homepage = data.homepage;
    if (data.icon)
        raw.icon = data.icon;
    if (data.requirements !== undefined)
        raw.requirements = JSON.stringify(data.requirements);
    if (data.users !== undefined)
        raw.users = JSON.stringify(data.users);
    if (data.traits !== undefined)
        raw.traits = JSON.stringify(data.traits);
    if (data.generate_passwords !== undefined)
        raw.generate_passwords = data.generate_passwords;
    if (data.inherited_directories !== undefined)
        raw.inherited_directories = JSON.stringify(data.inherited_directories);
    delete data.owner;
    delete data.name;
    delete data.version;
    delete data.description;
    delete data.homepage;
    delete data.icon;
    delete data.type;
    delete data.os;
    delete data.public;
    delete data.disabled;
    delete data.acl;
    delete data.requirements;
    delete data.users;
    delete data.billing_tags;
    delete data.traits;
    delete data.generate_passwords;
    delete data.inherited_directories;
    if (raw.type === 'zvol') {
        raw.nic_driver = data.nic_driver;
        raw.disk_driver = data.disk_driver;
        raw.cpu_type = data.cpu_type;
        raw.image_size = data.image_size;
        delete data.nic_driver;
        delete data.disk_driver;
        delete data.cpu_type;
        delete data.image_size;
    }
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
        image = new Image(app, raw);
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
        name: '~str',
        version: 'str',
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
                function (d) { return new Image(app, d); });
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
                images.push(new Image(app, rawItems[i]));
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

    // For a "public" mode IMGAPI, the ListImages endpoint only shows
    // "active" images to unauthenticated requests.
    var limitToActive = (req._app.mode === 'public' &&
                         req.remoteUser === undefined);

    // Normalize the query fields.
    var query = {};
    if (!req.query.state || req.query.state === 'active') {
        query.activated = true;
        query.disabled = false;
    } else if (req.query.state === 'disabled') {
        if (limitToActive) {
            res.send([]);
            return next();
        }
        query.activated = true;
        query.disabled = true;
    } else if (req.query.state === 'unactivated') {
        if (limitToActive) {
            res.send([]);
            return next();
        }
        query.activated = false;
    } else if (req.query.state === 'all') {
        if (limitToActive) {
            query.activated = true;
            query.disabled = false;
        }
    } else {
        return next(new errors.InvalidParameterError(
            format('invalid state: "%s"', req.query.state),
            [{field: 'state', code: 'Invalid'}]));
    }
    if (req.query.public !== undefined) {
        query.public = boolFromString(req.query.public, true, 'public');
    }
    ['name',
     'version',
     'owner',
     'os',
     'type',
     'account'].forEach(function (f) {
        query[f] = req.query[f];
    });
    req.log.debug({query: query, limitToActive: limitToActive},
        'ListImages query')

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
            version: query.version,
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
            version: query.version,
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
                    version: query.version,
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
                    version: query.version,
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
                version: query.version,
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
                    version: query.version,
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
                    version: query.version,
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
                data.push(imageByUuid[uuids[i]].serialize(req._app.mode));
            }
            res.send(data);
            next();
        }
    );
}


function apiGetImage(req, res, next) {
    res.send(req._image.serialize(req._app.mode));
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
    Image.create(app, data, false, function (cErr, image) {
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
            res.send(image.serialize(req._app.mode));
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
        Image.create(app, data, true, function (cErr, image) {
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
                res.send(image.serialize(req._app.mode));
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

    // Validate compression.
    var compression = req.query.compression;
    if (!compression) {
        return next(new errors.InvalidParameterError('missing "compression"',
            [{field: 'compression', code: 'Missing'}]));
    } else if (VALID_FILE_COMPRESSIONS.indexOf(compression) === -1) {
        return next(new errors.InvalidParameterError(
            format('invalid compression "%s" (must be one of %s)',
                compression, VALID_FILE_COMPRESSIONS.join(', ')),
            [{field: 'compression', code: 'Invalid'}]));
    }

    var finished = false;
    var size;
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
            size: size,
            contentMD5: md5sum.digest('base64'),
            mtime: (new Date()).toISOString(),
            stor: stor.type,
            compression: compression
        };
        if (req.headers['content-length']) {
            var expectedSize = Number(req.headers['content-length']);
            if (size !== expectedSize) {
                return next(new errors.UploadError(format(
                    '"Content-Length" header, %s, does not match uploaded '
                    + 'size, %d', expectedSize, size)));
            }
        }
        req._image.addFile(req._app, file, req.log, function (err) {
            if (err) {
                // TODO: remove the saved file!
                req.log.error(err, 'error adding file info to Image');
                return next(new errors.InternalError(err,
                    'could not save image'));
            }
            res.send(req._image.serialize(req._app.mode));
            next();
        });
    }

    size = 0;
    var shasum = crypto.createHash('sha1');
    var md5sum = crypto.createHash('md5');
    req.on('data', function (chunk) {
        size += chunk.length;
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
            finish(sErr);
            return;
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


function apiAddImageIcon(req, res, next) {
    req.log.debug({image: req._image}, "AddImageIcon: start")

    if (ICON_CONTENT_TYPES.indexOf(req.headers['content-type']) === -1) {
        return next(new errors.UploadError(format(
            'invalid content-type, %s, must be one of %s',
            req.headers['content-type'], ICON_CONTENT_TYPES.join(', '))));
    }

    var finished = false;
    var size;
    var stor;  // the storage class
    function finish(err) {
        if (finished) {
            return;
        }
        finished = true;
        if (err) {
            return next(new errors.InternalError(err,
                'error receiving image icon: %s', err));
        }
        var icon = {
            sha1: shasum.digest('hex'),
            size: size,
            contentType: req.headers['content-type'],
            contentMD5: md5sum.digest('base64'),
            mtime: (new Date()).toISOString(),
            stor: stor.type,
        };
        if (size > MAX_ICON_FILE_SIZE) {
            return next(new errors.UploadError(format(
                'icon file size, %s, exceeds the maximum allowed file '
                + 'size, 128Kb', size)));
        }

        if (req.headers['content-length']) {
            var expectedSize = Number(req.headers['content-length']);
            if (size !== expectedSize) {
                return next(new errors.UploadError(format(
                    '"Content-Length" header, %s, does not match uploaded '
                    + 'size, %d', expectedSize, size)));
            }
        }
        req._image.addIcon(req._app, icon, req.log, function (err) {
            if (err) {
                // TODO: remove the saved icon!
                req.log.error(err, 'error setting icon=true to Image');
                return next(new errors.InternalError(err,
                    'could not save image'));
            }
            res.send(req._image.serialize(req._app.mode));
            next();
        });
    }

    size = 0;
    var shasum = crypto.createHash('sha1');
    var md5sum = crypto.createHash('md5');
    req.on('data', function (chunk) {
        shasum.update(chunk);
        md5sum.update(chunk);
        size += chunk.length;
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
    stor.createImageFileWriteStream(req._image, 'icon',
    function (sErr, stream) {
        if (sErr) {
            finish(sErr);
            return;
        }
        req.pipe(stream);
        req.resume(); // Was paused in `server.pre`.
    });
}


/**
 * Set file cache-related headers for GetImageIcon before the
 * `conditionalRequest` middleware is run.
 */
function resGetImageIconCacheHeaders(req, res, next) {
    var image = req._image;
    if (!image.icon) {
        return next(new errors.ResourceNotFoundError(
            "image '%s' has no icon", image.uuid));
    }

    var icon = image.icon;
    res.header('Etag', icon.sha1);
    res.header('Last-Modified', new Date(icon.mtime));
    res.header('Content-Length', icon.size);
    res.header('Content-Type', icon.contentType);
    res.header('Content-MD5', icon.contentMD5);

    next();
}


function apiGetImageIcon(req, res, next) {
    var image = req._image;
    req.log.debug({image: image}, "GetImageIcon: start")

    var finished = false;
    function finish(err) {
        if (finished) {
            return;
        }
        finished = true;
        if (err) {
            return next(new errors.InternalError(err,
                'error getting image icon: %s', err));
        }
        next();
    }

    var icon = req._image.icon;
    assert.object(icon, 'image.icon');
    var stor = req._app.getStor(icon.stor);
    stor.createImageFileReadStream(req._image, 'icon', function (sErr, stream) {
        // TODO: handle 404?
        if (sErr) {
            return finish(err);
        }
        stream.on('end', function () {
            req.log.trace('GetImageIcon stream "end" event');
            finish();
        });
        stream.on('close', function () {
            req.log.trace('GetImageIcon stream "close" event');
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
        res.send(req._image.serialize(req._app.mode));
        next(false);
    });
}


function apiDisableImage(req, res, next) {
    if (req.query.action !== 'enable' && req.query.action !== 'disable')
        return next();

    var action, disabled;
    if (req.query.action === 'enable') {
        action = 'EnableImage';
        disabled = false;
    } else {
        action = 'DisableImage';
        disabled = true;
    }

    req.log.debug({image: req._image}, action + ": start")
    req._image.disable(req._app, disabled, req.log, function (err) {
        if (err) {
            return next(err);
        }
        res.send(req._image.serialize(req._app.mode));
        next(false);
    });
}


function apiUpdateImage(req, res, next) {
    if (req.query.action !== 'update')
        return next();

    req.log.debug({image: req._image}, 'UpdateImage: start');

    // Check that all they keys to be updated are whitelisted
    var UPDATEABLE_ATTRS = {
        'name': true,
        'version': true,
        'description': true,
        'homepage': true,
        'public': true,
        'acl': true,
        'requirements': true,
        'type': true,
        'os': true,
        'users': true,
        'billing_tags': true,
        'traits': true,
        'generate_passwords': true,
        'inherited_directories': true,
        'nic_driver': true,
        'disk_driver': true,
        'cpu_type': true,
        'image_size': true
    };

    var data = req.body;
    var dataKeys = Object.keys(data);
    if (dataKeys.length === 0) {
        return next(new errors.ValidationFailedError(
            'invalid image update data: no parameters provided', []));
    }

    var i;
    var errs = [];
    for (i = 0; i < dataKeys.length; i++) {
        var key = dataKeys[i];
        if (UPDATEABLE_ATTRS[key] === undefined) {
            errs.push({
                field: key,
                code: 'NotAllowed',
                message: 'Parameter cannot be updated'
            });
        }
    }

    // Special case for updating billing_tags: operator only
    if (data.billing_tags !== undefined && req.query.account !== undefined) {
        errs.push({
            field: 'billing_tags',
            code: 'NotAllowed',
            message: 'Can only be updated by operators'
        });
    }

    // And traits: operator only
    if (data.traits !== undefined && req.query.account !== undefined) {
        errs.push({
            field: 'traits',
            code: 'NotAllowed',
            message: 'Can only be updated by operators'
        });
    }

    if (errs.length) {
        var fields = errs.map(function (e) { return e.field });
        return next(new errors.ValidationFailedError(
            'invalid image update data: ' + fields.join(', '), errs));
    }

    // Merge new values into existing raw data.
    var raw = req._image.raw;
    for (i = 0; i < dataKeys.length; i++) {
        var key = dataKeys[i];
        raw[key] = data[key];
    }

    // Revalidate.
    try {
        var image = new Image(req._app, raw);
    } catch (cErr) {
        return next(cErr);
    }

    var change = {
        operation: 'replace',
        modification: data
    };
    Image.modify(req._app, image, change, req.log, function (err) {
        if (err) {
            return next(err);
        }
        res.send(image.serialize(req._app.mode));
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

                return deleteIconFile();
            }
        );

        function deleteIconFile() {
            var icon = image.icon;
            if (icon) {
                var stor = req._app.getStor(icon.stor);
                stor.deleteImageFile(image, 'icon', function (fileErr) {
                    if (fileErr) {
                        log.error({err: fileErr, image: image},
                            'error deleting model icon, this image may have a'
                            + 'zombie icon file which must be remove manually '
                            + 'by an operator');
                    }
                });
            }
            res.send(204);
            return next();
        }
    });
}


function apiAddImageAcl(req, res, next) {
    if (req.query.action && req.query.action !== 'add')
        return next();

    req.log.debug({image: req._image}, "AddImageAcl: start");

    if (req.body === undefined || !Array.isArray(req.body)) {
        return next(new errors.InvalidParameterError(
            format('invalid image "acl" (not an array)'),
            [{field: 'acl', code: 'Invalid'}]));
    }

    var uuid;
    for (var i = 0; i < req.body.length; i++) {
        uuid = req.body[i];
        if (!UUID_RE.test(uuid)) {
            return next(new errors.InvalidParameterError(
                format('invalid image "acl" (item %d is not a UUID): %s',
                i, uuid), [{field: 'acl', code: 'Invalid'}]));
        }
    }

    req._image.addAcl(req._app, req.body, req.log, function (err) {
        if (err) {
            return next(err);
        }
        res.send(req._image.serialize(req._app.mode));
        next(false);
    });
}


function apiRemoveImageAcl(req, res, next) {
    if (req.query.action !== 'remove')
        return next();

    req.log.debug({image: req._image}, "RemoveImageAcl: start")

    if (req.body === undefined || !Array.isArray(req.body)) {
        return next(new errors.InvalidParameterError(
            format('invalid image "acl" (not an array)'),
            [{field: 'acl', code: 'Invalid'}]));
    }

    var uuid;
    for (var i = 0; i < req.body.length; i++) {
        uuid = req.body[i];
        if (!UUID_RE.test(uuid)) {
            return next(new errors.InvalidParameterError(
                format('invalid image "acl" (item %d is not a UUID): %s',
                i, uuid), [{field: 'acl', code: 'Invalid'}]));
        }
    }

    req._image.removeAcl(req._app, req.body, req.log, function (err) {
        if (err) {
            return next(err);
        }
        res.send(req._image.serialize(req._app.mode));
        next(false);
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
 * @param reqAuth {Function} A request middleware for strict
 *      authentication of some endpoints (typically those that can make
 *      changes) of the IMGAPI.
 * @param reqPassiveAuth {Function} A request middleware for "passive"
 *      authentication. Here "passive" means that a request with the
 *      "authorization" header will be strictly enforced (i.e. 401 on
 *      auth failure), but a request with no "authorization" will be
 *      passed through. Typically the relevant endpoint will behave slightly
 *      differently for authed vs unauthed.
 *
 * Note that there is *separate/independent* authorization for private and
 * non-active images based on the `account` query param to most of the API
 * endpoints.
 *
 */
function mountApi(server, reqAuth, reqPassiveAuth) {
    server.get(
        {path: '/images', name: 'ListImages'},
        reqPassiveAuth,
        apiListImages);
    server.get(
        {path: '/images/:uuid', name: 'GetImage'},
        reqValidUuid,
        reqGetImage,    // add `req._image`, ensure access
        apiGetImage);
    server.post(
        {path: '/images', name: 'CreateImage'},
        reqAuth,
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
        reqAuth,
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
    server.put(
        {path: '/images/:uuid/icon', name: 'AddImageIcon'},
        reqAuth,
        reqValidUuid,
        reqGetImage,    // add `req._image`, ensure access
        apiAddImageIcon);
    server.get(
        {path: '/images/:uuid/icon', name: 'GetImageIcon'},
        reqValidUuid,
        reqGetImage,    // add `req._image`, ensure access
        resGetImageIconCacheHeaders,
        restify.conditionalRequest(),
        apiGetImageIcon);
    server.post(
        {path: '/images/:uuid', name: 'UpdateImage'},
        reqAuth,
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
        apiDisableImage,
        apiUpdateImage,
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
        reqAuth,
        reqValidUuid,
        reqGetImage,  // ensure have access to image before deleting
        apiDeleteImage);
    server.post(
        {path: '/images/:uuid/acl', name: 'AddImageAcl'},
        reqAuth,
        reqValidUuid,
        function resume(req, res, next) {
            next();
            process.nextTick(function () {
                req.resume();
            })
        },
        restify.bodyParser({mapParams: false}),
        reqGetImage,
        apiAddImageAcl,
        apiRemoveImageAcl,
        function invalidAction(req, res, next) {
            if (req.query.action) {
                next(new errors.InvalidParameterError(
                    format('"%s" is not a valid action', req.query.action),
                    [{field: 'action', code: 'Invalid'}]));
            }
        });
}



//---- exports

module.exports = {
    Image: Image,
    mountApi: mountApi
};
