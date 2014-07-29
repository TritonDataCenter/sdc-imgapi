/*
 * Copyright 2013 Joyent, Inc.  All rights reserved.
 *
 * IMGAPI model and endpoints for '/images/...'.
 */

var p = console.log;
var util = require('util'),
    format = util.format;
var fs = require('fs');
var crypto = require('crypto');
var url = require('url');
var path = require('path');

var once = require('once');
var assert = require('assert-plus');
var genUuid = require('libuuid');
var restify = require('restify');
var async = require('async');
var imgmanifest = require('imgmanifest');
var sdc = require('sdc-clients');
var vasync = require('vasync');

var channels = require('./channels');
var errors = require('./errors');
var utils = require('./utils'),
    objCopy = utils.objCopy,
    boolFromString = utils.boolFromString,
    isPositiveInteger = utils.isPositiveInteger,
    validPlatformVersion = utils.validPlatformVersion,
    imgadmVersionFromReq = utils.imgadmVersionFromReq;

// Used for importing remote images
var TMPDIR = '/var/tmp';


//---- globals

var TOP = path.resolve(__dirname, '..');
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var MAX_ICON_SIZE = 128*1024; // 128KiB
var MAX_ICON_SIZE_STR = '128 KiB';
var MAX_IMAGE_SIZE = 20*1024*1024*1024; // 128GiB
var MAX_IMAGE_SIZE_STR = '20 GiB';
var ICON_CONTENT_TYPES = ['image/jpeg', 'image/gif', 'image/png'];
var VALID_FILE_COMPRESSIONS = ['gzip', 'bzip2', 'none'];
var VALID_STORAGES = ['local', 'manta'];
// These are the brands that we currently support
// var VALID_BRANDS = ['joyent', 'joyent-minimal', 'sngl'];
var MAX_QUERY_LIMIT = 1000;

var UNSET_OWNER_UUID = '00000000-0000-0000-0000-000000000000';


/*
 * IMGAPI-251: If we're creating an incremental image, then we want to
 * make sure it is only used to provision on a server with an imgadm
 * that supports incremental images... or on any 6.5 platform (presuming
 * it has the latest provisioner agent which handles the origin image
 * installation).
 */
var IMGAPI_251_MIN_PLATFORM = {
    '7.0': '20130729T063445Z',
    // The oldest 6.5 platform in the JPC fleet at time of writing.
    // See IMGAPI-286.
    '6.5': '20120614T001014Z'
};



//---- Image model

/**
 * Create a Image object from raw DB (i.e. Moray) data.
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

    var rawCopy = objCopy(raw);

    this.raw = Image.validate(app, rawCopy);

    this.v = Number(this.raw.v);
    this.name = this.raw.name;
    this.version = this.raw.version;
    this.description = this.raw.description;
    this.homepage = this.raw.homepage;
    this.eula = this.raw.eula;
    this.owner = this.raw.owner;
    this.type = this.raw.type;
    this.os = this.raw.os;
    this.origin = this.raw.origin;
    this.published_at = this.raw.published_at &&
        new Date(this.raw.published_at);
    this.expires_at = this.raw.expires_at &&
        new Date(this.raw.expires_at);
    this.acl = this.raw.acl;
    this.disabled = boolFromString(this.raw.disabled, false, 'raw.disabled');
    this.activated = boolFromString(this.raw.activated, false, 'raw.activated');
    this.public = boolFromString(this.raw.public, false, 'raw.public');
    this.icon = this.raw.icon;
    this.error = this.raw.error;
    this.requirements = this.raw.requirements;
    this.generate_passwords = boolFromString(this.raw.generate_passwords,
        true, 'raw.generate_passwords');
    this.users = this.raw.users;
    this.billing_tags = this.raw.billing_tags;
    this.tags = (this.raw.tags ? utils.keyValueToObject(this.raw.tags) :
        undefined);
    this.traits = this.raw.traits;
    this.inherited_directories = this.raw.inherited_directories;
    this.urn = this.raw.urn;
    this.nic_driver = this.raw.nic_driver;
    this.disk_driver = this.raw.disk_driver;
    this.cpu_type = this.raw.cpu_type;
    if (this.raw.image_size) {
        this.image_size = this.raw.image_size;
    }
    // TODO consider moving to NOT storing the state in the db: _calcState.
    this.state = this.raw.state;
    this.channels = this.raw.channels;

    var self = this;
    this.__defineGetter__('files', function () {
        if (self._filesCache === undefined) {
            if (! self.raw.files) {
                self._filesCache = [];
            } else {
                self._filesCache = self.raw.files;
            }
        }
        return self._filesCache;
    });
}


/**
 * Calculate the appropriate `state` string from the given image attributes.
 */
Image._calcState = function (activated, disabled) {
    assert.bool(activated, 'activated');
    assert.bool(disabled, 'disabled');
    if (!activated) {
        return 'unactivated';
    } else if (disabled) {
        return 'disabled';
    } else {
        return 'active';
    }
};


/**
 * Return the API view of this Image's data.
 *
 * @param mode {string} Some fields are not shown for some modes. E.g.,
 *      the "billing_tags" are not shown in "public" mode.
 */
Image.prototype.serialize = function serialize(mode) {
    assert.string(mode, 'mode');
    var data = {
        v: this.v,
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
            return {
                sha1: f.sha1,
                size: f.size,
                compression: f.compression,
                dataset_guid: f.dataset_guid
            };
        })
    };
    if (this.acl && this.acl.length !== 0) data.acl = this.acl;
    if (this.description) data.description = this.description;
    if (this.homepage) data.homepage = this.homepage;
    if (this.eula) data.eula = this.eula;
    if (this.icon) data.icon = true;
    if (this.urn) data.urn = this.urn;
    if (this.requirements) data.requirements = this.requirements;
    if (this.users) data.users = this.users;
    if (this.raw.generate_passwords)
        data.generate_passwords = this.generate_passwords;
    if (this.inherited_directories)
        data.inherited_directories = this.inherited_directories;
    if (this.origin) data.origin = this.origin;
    if (this.nic_driver) data.nic_driver = this.nic_driver;
    if (this.disk_driver) data.disk_driver = this.disk_driver;
    if (this.cpu_type) data.cpu_type = this.cpu_type;
    if (this.image_size !== undefined) data.image_size = this.image_size;
    if (this.tags) data.tags = this.tags;
    if (this.channels) data.channels = this.channels;
    if (mode !== 'public') {
        // TODO: do we really care to hide these?
        if (this.billing_tags && this.billing_tags.length !== 0)
            data.billing_tags = this.billing_tags;
        if (this.traits && Object.keys(this.traits).length !== 0)
            data.traits = this.traits;
    }
    if (this.state === 'failed' && this.error) {
        data.error = this.error;
        // And, decide which fields not to return additionally i.e.
        // delete data.users; delete data.state, etc
    }
    if (this.type === 'null') delete data.type;
    if (this.os === 'null') delete data.os;
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

    var files = this.files;
    files[0] = file;
    this.raw.files = files;
    delete this._filesCache;
    Image.modify(app, this, log, callback);
};


/**
 * Add an uploaded icon to this Image instance. The file will have already
 * be written out (to disk or to manta, depending).
 *
 * @param app {App} The IMGAPI app.
 * @param icon {Object} Describes the uploaded icon, with keys:
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
    this.icon = this.raw.icon = icon;

    Image.modify(app, this, log, callback);
};


/**
 * Removes the icon attribute from an Image. Keep in mind that icon is an object
 * when stored on UFDS but at the API level it is a boolean that indicates
 * wether the Image has an icon or not
 *
 * @param app {App} The IMGAPI app.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)` where `err` is some internal
 *      detail (i.e. it should be wrapped for the user).
 */
Image.prototype.deleteIcon = function deleteIcon(app, log, callback) {
    delete this.icon;
    delete this.raw.icon;

    Image.modify(app, this, log, callback);
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

    // If `published_at` is already set, then this was added via
    // 'AdminImportImage' or 'MigrateImage'.
    if (!this.raw.published_at) {
        this.published_at = new Date();
        this.raw.published_at = this.published_at.toISOString();
    }
    this.activated = this.raw.activated = true;
    this.state = this.raw.state = Image._calcState(true, this.disabled);

    // If `expires_at` is set, then this is a placeholder image that is being
    // activated. We need to clear the expires_at flag.
    if (this.raw.expires_at) {
        this.expires_at = undefined;
        this.raw.expires_at = undefined;
    }
    Image.modify(app, this, log, callback);
};


/**
 * Disable this image.
 *
 * @param app {App} The IMGAPI app.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)` where `err` is okay to
 *      use for an API reponse (i.e. doesn't expose internal details).
 */
Image.prototype.disable = function disable(app, log, callback) {
    this.disabled = this.raw.disabled = true;
    this.state = this.raw.state = Image._calcState(this.activated, true);

    Image.modify(app, this, log, callback);
};


/**
 * Enable this image.
 *
 * @param app {App} The IMGAPI app.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)` where `err` is okay to
 *      use for an API reponse (i.e. doesn't expose internal details).
 */
Image.prototype.enable = function enable(app, log, callback) {
    this.disabled = this.raw.disabled = false;
    this.state = this.raw.state = Image._calcState(this.activated, false);

    Image.modify(app, this, log, callback);
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
    this.acl = acl;
    this.raw.acl = acl;

    Image.modify(app, this, log, callback);
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
    this.acl = newAcl;
    this.raw.acl = newAcl;

    Image.modify(app, this, log, callback);
};


/**
 * Add this image to a channel.
 *
 * @param app {App} The IMGAPI app.
 * @param channelName {String} Channel to which to add this image.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)`
 */
Image.prototype.channelAdd = function channelAdd(
        app, channelName, log, callback) {
    assert.object(app, 'app');
    assert.string(channelName, 'channelName');
    assert.object(log, 'log');
    assert.func(callback, 'callback');
    log.trace({uuid: this.uuid, channelName: channelName}, 'channelAdd');

    // No-op if already in that channel.
    for (var i = 0; i < this.channels.length; i++) {
        if (this.channels[i] === channelName) {
            return callback();
        }
    }

    // `this.channels` should be a ref to the same array.
    this.raw.channels.push(channelName);

    Image.modify(app, this, log, callback);
};


/**
 * Remove this image from a channel.
 *
 * @param app {App} The IMGAPI app.
 * @param channelName {String} Channel to which to add this image.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)`
 */
Image.prototype.channelRemove = function channelRemove(
        app, channelName, log, callback) {
    assert.object(app, 'app');
    assert.string(channelName, 'channelName');
    assert.object(log, 'log');
    assert.func(callback, 'callback');
    assert.ok(this.channels.indexOf(channelName) !== -1);
    log.trace({uuid: this.uuid, channelName: channelName}, 'channelRemove');

    var idx = this.channels.indexOf(channelName);
    assert.ok(idx !== -1);

    // `this.channels` should be a ref to the same array.
    this.raw.channels = this.raw.channels.slice(0, idx)
        .concat(this.raw.channels.slice(idx + 1));

    Image.modify(app, this, log, callback);
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
            return callback(null, cached.data);
        }
    }

    function cacheAndCallback(err, item) {
        app.cacheSet(cacheScope, uuid, { err: err, data: item });
        callback(err, item);
    }

    app.db.get(uuid, function (err, entry) {
        if (err) {
            if (err.statusCode === 503) {
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
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)`
 */
Image.modify = function modifyImage(app, image, log, callback) {
    assert.object(app, 'app');
    assert.object(image, 'image');
    assert.object(log, 'log');
    assert.func(callback, 'callback');

    var uuid = image.uuid;
    var local = app.storage.local;
    var manifest = image.serialize(app.mode);
    log.trace({ uuid: uuid, image: image }, 'Image.modify');

    local.archiveImageManifest(manifest, function (archErr) {
        if (archErr) {
            log.error({uuid: image.uuid},
                'error archiving image manifest:', manifest);
            return callback(archErr);
        }

        app.db.modify(uuid, image.raw, function (err) {
            if (err) {
                log.error({ err: err, uuid: uuid }, 'error updating model');
                callback(err);
            } else {
                log.trace({ uuid: uuid }, 'Image.modify complete');
                app.cacheInvalidateWrite('Image', image);
                callback();
            }
        });
    });
};


/**
 * Imports an image from a remote IMGAPI repository.
 *
 * @param req {Object} Request object
 * @param uuid {UUID}
 * @param source {URL} Location of the remote repository
 * @param skipOwnerCheck {Boolean} If true, the check that the owner UUID
 *      exists in UFDS will be skipped.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)`
 */
Image.createImportImageJob =
function createImportImageJob(req, uuid, source, skipOwnerCheck, log, cb) {
    assert.object(req, 'req');
    assert.string(uuid, 'uuid');
    assert.string(source, 'source');
    assert.bool(skipOwnerCheck, 'skipOwnerCheck');
    assert.object(log, 'log');
    assert.func(cb, 'callback');

    var app = req._app;
    var wfapi = app.wfapi;
    if (wfapi.connected !== true) {
        return cb(new errors.ServiceUnavailableError('Workflow API is down.'));
    }

    var client = new sdc.IMGAPI({ url: source, log: log });
    var manifest;
    // For every origin that doesn't exist locally we add its UUID to
    // this array and pass it to the WFAPI job so they get imported in
    // order
    var origins = [];

    async.waterfall([
        function getTheManifest(next) {
            client.getImage(uuid, function (err, manifest_) {
                if (err) {
                    log.error({err: err, uuid: uuid, source: source},
                        'failed to download manifest for image %s', uuid);
                    return next(new errors.RemoteSourceError(err,
                        format('Unable to get manifest for image %s. ' +
                            'Error from remote: %s', uuid,
                            err.message || err.code)));
                }
                manifest = manifest_;
                next();
            });
        },
        // Validate that each of the origins exist either locally or remotely.
        // If one of them doesn't exist then we need to cancel the import. The
        // reason we do this is because one IMGAPI instance can have A->B and
        // another one can have A->B->C->D->E. If we wanted to import E into the
        // first IMGAPI instance then we also need to import C and D because
        // it is asumed that A and B are already there.
        function ensureOriginsExist(next) {
            // Continue if manifest doesn't have an origin
            if (!manifest.origin) {
                return next();
            }

            var currentOrigin = manifest.origin;
            var originExists = false;

            function checkRemoteOrigin(subnext) {
                client.getImage(currentOrigin, function (err, mnfst) {
                    if (err) {
                        log.error({
                            err: err,
                            uuid: currentOrigin,
                            source: source
                        }, 'failed to download manifest for origin image %s',
                            currentOrigin);
                        return next(new errors.RemoteSourceError(err,
                            format('Unable to get manifest for origin ' +
                                'image %s. Error from remote: %s',
                                currentOrigin, err.message || err.code)));
                    }
                    // If the image exists in the remote then we add its UUID
                    // to 'origins' and check if it has an origin itself
                    origins.push(mnfst.uuid);
                    if (!mnfst.origin) {
                        originExists = true;
                    }
                    currentOrigin = mnfst.origin;
                    subnext();
                });
            }

            // Recursively call getImage an origin exists locally.
            async.whilst(
                function () {
                    return !originExists;
                },
                function (subnext) {
                    Image.get(app, currentOrigin, log, function (err, mnfst) {
                        if (err) {
                            if (err.restCode === 'ResourceNotFound') {
                                checkRemoteOrigin(subnext);
                            } else {
                                subnext(err);
                            }
                        } else {
                            originExists = true;
                            subnext();
                        }
                    });
                },
                function (err) {
                    if (err) {
                        next(err);
                    } else {
                        next();
                    }
                }
            );
        },
        function startTheJob(next) {
            var opts = {
                req: req,
                uuid: uuid,
                source: source,
                manifest: manifest,
                skipOwnerCheck: skipOwnerCheck
            };
            if (manifest.origin && origins.length) {
                // If the image has origins, and we don't have them locally,
                // tell the job to import them first.
                opts.origins = origins;
            }
            wfapi.createImportRemoteImageJob(opts, function (err2, juuid) {
                if (err2) {
                    return next(err2);
                }
                return next(null, juuid);
            });
        }
    ], cb);
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

    var manifest = {};
    var names = ['v', 'uuid', 'name', 'version', 'description', 'homepage',
        'eula', 'disabled', 'activated', 'state', 'published_at', 'public',
        'type', 'os', 'origin', 'icon', 'generate_passwords', 'nic_driver',
        'disk_driver', 'cpu_type', 'image_size', 'error', 'files',
        'requirements', 'users', 'traits', 'inherited_directories',
        'owner', 'channels'];
    for (var i = 0; i < names.length; i++) {
        if (raw.hasOwnProperty(names[i])) {
            manifest[names[i]] = raw[names[i]];
        }
    }

    // tags -- key=value format
    if (raw.tags && Array.isArray(raw.tags)) {
        manifest.tags = utils.keyValueToObject(raw.tags);
    }

    // icon -- special case
    if (!raw.icon) {
        /*jsl:pass*/
    } else {
        if (!raw.icon.contentMD5) {
            errs.push({
                field: 'icon',
                code: 'Invalid',
                message: 'invalid image "icon": icon missing "contentMD5" field'
            });
        } else if (!raw.icon.size) {
            errs.push({
                field: 'icon',
                code: 'Invalid',
                message: format(
                    'invalid image "icon": icon missing "size" field')
            });
        } else if (!raw.icon.contentType) {
            errs.push({
                field: 'icon',
                code: 'Invalid',
                message: format('invalid image "icon": icon missing ' +
                    '"contentType" field')
            });
        } else {
            manifest.icon = true;
        }
    }

    // acl
    if (raw.acl === undefined) {
        raw.acl = [];
    } else {
        if (typeof (raw.acl) === 'string') {
            raw.acl = [raw.acl];
        }
        manifest.acl = raw.acl;
    }

    // billing_tags
    if (raw.billing_tags) {
        if (typeof (raw.billing_tags) === 'string') {
            raw.billing_tags = [ raw.billing_tags ];
        }
        manifest.billing_tags = raw.billing_tags;
    }

    var fn;
    if (app.mode === 'public') {
        fn = imgmanifest.validatePublicManifest;
    } else if (app.mode === 'private') {
        fn = imgmanifest.validatePrivateManifest;
    } else if (manifest.state === 'creating') {
        fn = imgmanifest.validateMinimalManifest;
    } else {
        fn = imgmanifest.validateDcManifest;
    }

    var manifestErrs = fn.call(null, manifest, {
        channelFromName: app.channelFromName
    });
    if (manifestErrs && manifestErrs.length) {
        manifestErrs.forEach(function (err) {
            errs.push(err);
        });
    }

    if (errs.length) {
        var fields = errs.map(function (e) { return e.field; });
        throw new errors.ValidationFailedError(
            'invalid image data: ' + fields.join(', '), errs);
    }
    return raw;
};


/**
 * Create a new Image from request data.
 *
 * @param app {App}
 * @param data {Object} The probe data in "external" form (as opposed to
 *      the "raw" form stored in the db).
 * @param isImport {Boolean} Indicates if this is an import. An import
 *      allows (and expects) the 'uuid' and 'published_at' fields.
 * @param isPlaceholder {Boolean} A placeholder image is one with state
 *      'creating' or 'failed', i.e. not a real image. If true, the image data
 *      is treated and validated as a minimal image and most of its fields can
 *      be omitted. All the image attributes will be present only after the
 *      image has been physically created (i.e. create-from-vm).
 * @param cb {Function} `function (err, image)`.
 */
Image.create = function createImage(app, data, isImport, isPlaceholder, cb) {
    assert.object(app, 'app');
    assert.object(data, 'data');
    assert.bool(isImport, 'isImport');
    assert.bool(isPlaceholder, 'isPlaceholder');
    assert.func(cb, 'cb');

    // Upgrade manifest, i.e. allow importing of older manifest versions.
    try {
        data = imgmanifest.upgradeManifest(data);
    } catch (err) {
        app.log.debug(err, 'could not upgrade manifest for Image.create');
        /* Pass through, because we expect validation to handle it. */
    }

    // Put together the raw data (where "raw" means in the form stored
    // in the database and used by the "Image" object).
    var raw = {
        v: data.v,
        owner: data.owner,
        name: data.name,
        version: data.version,
        type: data.type,
        os: data.os,
        public: data.public || false,
        disabled: data.disabled || false,
        activated: false,
        state: 'unactivated',
        acl: data.acl
    };
    if (data.description)
        raw.description = data.description;
    if (data.homepage)
        raw.homepage = data.homepage;
    if (data.eula)
        raw.eula = data.eula;
    if (data.icon)
        raw.icon = data.icon;
    if (data.error !== undefined)
        raw.error = data.error;
    if (data.requirements !== undefined)
        raw.requirements = data.requirements;
    if (data.users !== undefined)
        raw.users = data.users;
    if (data.traits !== undefined)
        raw.traits = data.traits;
    if (data.tags !== undefined) {
        raw.tags = utils.objectToKeyValue(data.tags);
    }
    if (data.billing_tags !== undefined)
        raw.billing_tags = data.billing_tags;
    if (data.generate_passwords !== undefined)
        raw.generate_passwords = data.generate_passwords;
    if (data.inherited_directories !== undefined)
        raw.inherited_directories = data.inherited_directories;
    if (data.origin !== undefined)
        raw.origin = data.origin;
    if (data.channels !== undefined)
        raw.channels = data.channels;
    delete data.v;
    delete data.owner;
    delete data.name;
    delete data.version;
    delete data.description;
    delete data.homepage;
    delete data.eula;
    delete data.icon;
    delete data.type;
    delete data.os;
    delete data.origin;
    delete data.public;
    delete data.disabled;
    delete data.acl;
    delete data.icon;
    delete data.error;
    delete data.requirements;
    delete data.users;
    delete data.billing_tags;
    delete data.traits;
    delete data.tags;
    delete data.generate_passwords;
    delete data.inherited_directories;
    delete data.channels;
    if (raw.type === 'zvol') {
        raw.nic_driver = data.nic_driver;
        raw.disk_driver = data.disk_driver;
        raw.cpu_type = data.cpu_type;
        raw.image_size = Number(data.image_size);
        delete data.nic_driver;
        delete data.disk_driver;
        delete data.cpu_type;
        delete data.image_size;
    }
    if (isImport) {
        if (!data.uuid) {
            return cb(new errors.InvalidParameterError('missing "uuid"',
                [ {field: 'uuid', code: 'MissingParameter'} ]));
        }
        raw.uuid = data.uuid;
        delete data.uuid;
        if (data.published_at && typeof (data.published_at) !== 'string') {
            return cb(
                new errors.InvalidParameterError('invalid "published_at"',
                [ {field: 'published_at', code: 'Invalid'} ]));
        }
        if (data.published_at) {
            raw.published_at = data.published_at;
            delete data.published_at;
        }
        if (data.urn) {
            raw.urn = data.urn;
            delete data.urn;
        }
    } else if (isPlaceholder) {
        // When creating a placeholder image set an expiration date if its
        // creation fails
        var expires = new Date();
        expires.setDate(expires.getDate() +
            app.config.placeholderImageLifespanDays);
        raw.expires_at = expires.toISOString();
        raw.v = 2;
        raw.uuid = data.uuid;
        raw.type = 'null';
        raw.os = 'null';
        raw.state = 'creating';
        delete data.uuid;
    } else {
        raw.uuid = genUuid.create();
    }

    // Error on extra spurious fields.
    delete data.files;
    delete data.state; // allow create from IMGAPI output
    var extraFields = Object.keys(data);
    if (extraFields.length > 0) {
        return cb(new errors.InvalidParameterError(
            format('invalid extra parameters: "%s"', extraFields.join('", "')),
            extraFields.map(function (f) {
                return { field: f, code: 'Invalid' };
            })));
    }

    var image = null;
    try {
        image = new Image(app, raw);
    } catch (cErr) {
        return cb(cErr);
    }

    cb(null, image);
};


/**
 * Lookup (and cache) all images matching the given filter options.
 *
 * @param app {App}
 * @param options {Object} Optional filter fields and limit/marker options.
 *      See `supportedFields` in the code below.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err, images)`
 */
Image.filter = function filterImages(app, options, log, callback) {
    // Validate.
    // Note: These types should be kept in sync with
    // `database.SEARCH_TYPE_FROM_FIELD`.
    var filter = options.filter;
    var supportedFields = {
        owner: 'str',
        state: 'str',
        activated: 'bool',
        disabled: 'bool',
        public: 'bool',
        name: '~str',
        version: '~str',
        origin: 'str',
        os: 'str',
        type: 'str',
        acl: 'str',
        tags: 'array',
        billing_tags: 'array',
        channels: 'array'
    };
    Object.keys(filter).forEach(function (k) {
        if (!supportedFields[k]) {
            throw new TypeError(format(
                'unsupported Image.filter option: "%s"', k));
        }
    });

    // Build a stable cacheKey.
    var fields = Object.keys(filter);
    fields.sort();
    var cacheKey = JSON.stringify(fields
        .filter(function (f) { return filter[f] !== undefined; })
        .map(function (f) { return [f, filter[f]]; }));

    // Check cache. "cached" is `{err: <error>, data: <data>}`.
    var cacheScope = 'ImageList';
    var cached = app.cacheGet(cacheScope, cacheKey);
    if (cached) {
        log.trace({cacheKey: cacheKey, hit: cached}, 'Image.filter: cache hit');
        if (cached.err) {
            return callback(cached.err);
        } else {
            return callback(null, cached.data);
        }
    }

    function cacheAndCallback(cErr, cItems) {
        app.cacheSet(cacheScope, cacheKey, {err: cErr, data: cItems});
        callback(cErr, cItems);
    }

    // Do the search.
    app.db.search(options, function (err, rawItems) {
        if (err) {
            if (err.statusCode === 503) {
                return callback(err);  // don't cache 503
            } else {
                return cacheAndCallback(err);
            }
        }
        var images = [];
        for (var i = 0; i < rawItems.length; i++) {
            try {
                images.push({
                    value: new Image(app, rawItems[i].value),
                    _id: rawItems[i]._id
                });
            } catch (err2) {
                if (err2 instanceof restify.RestError) {
                    log.warn('Ignoring invalid raw image data (uuid=\'%s\'):' +
                        ' %s', rawItems[i].value.uuid, err2);
                } else {
                    log.error(err2,
                        'Unknown error creating Image with raw image data:',
                        rawItems[i].value);
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
 * 1. Without 'account=$uuid'. Simple filtering based on the given values is
 *    done. This is expected to only be called by operators (e.g. via adminui).
 * 2. With 'account=$uuid'. Cloudapi calls to IMGAPI are expected to provide
 *    'account=<uuid-of-authenticated-account>'. The intention is to limit
 *    results to images that should be available to that account. That means:
 *    (a) images that they own ('owner=<uuid-of-account>'); and
 *    (b) other images to which they have access (active public images,
 *        activated private images for which ACLs give them access)
 */
function apiListImages(req, res, next) {
    req.log.trace({params: req.params}, 'ListImages entered');

    // For modes other than "dc", the ListImages endpoint only shows
    // "active" images to unauthenticated requests.
    var limitToActive = (req._app.mode !== 'dc' &&
                         req.remoteUser === undefined);

    var limit = req.query.limit;
    var marker = req.query.marker;

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
    } else if (req.query.state === 'creating' || req.query.state === 'failed') {
        if (limitToActive) {
            res.send([]);
            return next();
        }
        query.state = req.query.state;
    } else {
        return next(new errors.InvalidParameterError(
            format('invalid state: "%s"', req.query.state),
            [ { field: 'state', code: 'Invalid' } ]));
    }
    if (req.query.public !== undefined) {
        query.public = boolFromString(req.query.public, true, 'public');
    }
    ['name',
     'version',
     'owner',
     'os',
     'type',
     'account',
     'billing_tag'].forEach(function (f) {
        query[f] = req.query[f];
    });
    if (req.channel) {
        query.channels = [req.channel.name];
    }
    req.log.debug({
        query: query,
        limitToActive: limitToActive,
        limit: limit,
        marker: marker
    }, 'ListImages query');

    /*
     * Parses tag.xxx=yyy from the request params
     *   a="tag.role"
     *   m=a.match(/tag\.(.*)/)
     *   [ 'tag.role',
     *     'role',
     *     index: 0,
     *     input: 'tag.role' ]
     */
    var tags;
    Object.keys(req.query).forEach(function (key) {
        var matches = key.match(/tag\.(.*)/);
        if (matches) {
            if (!tags) tags = [];
            tags.push(matches[1] + '=' + req.query[key]);
        }
    });

    // if array  -> ?billing_tag=one&billing_tag=two -> ['one', 'two']
    // if string -> ?billing_tag=one -> ['one']
    var billingTags;
    if (query.billing_tag !== undefined) {
        if (typeof (query.billing_tag) === 'string') {
            billingTags = [ query.billing_tag ];
        } else {
            billingTags = query.billing_tag;
        }
    }

    // Determine the appropriate queries to make. Usage of 'account=UUID'
    // complicates this.
    var filterOpts = [];
    if (!query.account) {
        // No 'account' specified: just a vanilla search.
        filterOpts.push({
            owner: query.owner,
            public: query.public,
            state: query.state,
            activated: query.activated,
            disabled: query.disabled,
            name: query.name,
            version: query.version,
            os: query.os,
            type: query.type,
            channels: query.channels,
            tags: tags,
            billing_tags: billingTags
        });
    } else if (!query.owner) {
        // 'account' specified:
        // 1. Matching images owned by the given account.
        filterOpts.push({
            owner: query.account,
            public: query.public,
            state: query.state,
            activated: query.activated,
            disabled: query.disabled,
            name: query.name,
            version: query.version,
            os: query.os,
            type: query.type,
            channels: query.channels,
            tags: tags,
            billing_tags: billingTags
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
                    type: query.type,
                    channels: query.channels,
                    tags: tags,
                    billing_tags: billingTags
                });
            }
            if (!query.public) {
                // 3. Private & active images for which ACCOUNT is listed
                //    in 'acl'.
                filterOpts.push({
                    public: false,
                    activated: true,
                    disabled: false,
                    name: query.name,
                    version: query.version,
                    os: query.os,
                    type: query.type,
                    acl: [ query.account ],
                    channels: query.channels,
                    tags: tags,
                    billing_tags: billingTags
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
                state: query.state,
                activated: query.activated,
                disabled: query.disabled,
                name: query.name,
                version: query.version,
                os: query.os,
                type: query.type,
                channels: query.channels,
                tags: tags,
                billing_tags: billingTags
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
                    type: query.type,
                    channels: query.channels,
                    tags: tags,
                    billing_tags: billingTags
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
                    acl: [ query.account ],
                    channels: query.channels,
                    tags: tags,
                    billing_tags: billingTags
                });
            }
        }
    }
    req.log.trace({filterOpts: filterOpts}, 'ListImages filterOpts');

    var app = req._app;
    var imageByUuid = {}; // *set* of images to remove dups.

    // _id will be passed when a valid query marker parameter was provided
    function innerFilterImages(_id) {
        var log = req.log;

        async.forEach(filterOpts,
            function filterOne(filterOpt, nextAsync) {
                var opts = { filter: filterOpt };
                if (limit) {
                    opts.limit = limit;
                }
                if (_id) {
                    opts.marker = _id;
                }

                Image.filter(app, opts, log, function (cErr, images) {
                    if (cErr) {
                        return nextAsync(cErr);
                    }
                    log.trace({opts: opts, numImages: images.length},
                        'filterOne result');
                    for (var i = 0; i < images.length; i++) {
                        imageByUuid[images[i].value.uuid] = images[i];
                    }
                    nextAsync();
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

                // Object to array then sort by _id
                for (var i = 0; i < uuids.length; i++) {
                    data.push(imageByUuid[uuids[i]]);
                }
                data = data.sort(function (a, b) {
                    return a._id - b._id;
                }).map(function (entry) {
                    return entry.value.serialize(req._app.mode);
                });
                if (limit) {
                    data = data.slice(0, limit);
                }
                res.header('x-query-limit', MAX_QUERY_LIMIT);
                res.send(data);
                next();
            }
        );
    }

    // Without the need to create an Image instance get the raw database entry
    // in order to get its _id with the provided marker (Image UUID)
    if (marker) {
        app.db.get(marker, function (err, entry, _id) {
            if (err) {
                return next(err);
            }
            return innerFilterImages(_id);
        });
    } else {
        return innerFilterImages();
    }
}


function apiGetImage(req, res, next) {
    var serialized = req._image.serialize(req._app.mode);
    resSetEtag(req, res, serialized);
    res.send(serialized);
    next();
}


function apiCreateImage(req, res, callback) {
    if (req.query.action === 'create-from-vm')
        return callback();

    var log = req.log;
    var app = req._app;
    var data = req.body;

    var account;
    if (req.query.account) {
        account = req.query.account;
        if (!UUID_RE.test(account)) {
            return callback(new errors.InvalidParameterError(
                format('invalid "account": not a UUID: "%s"', account),
                [ { field: 'account', code: 'Invalid' } ]));
        }

        if (!data.owner) {
            data.owner = account;
        } else if (data.owner !== account) {
            return callback(new errors.InvalidParameterError(
                format('invalid owner: given owner, "%s", does not ' +
                    'match account, "%s"', data.owner, account),
                [ { field: 'owner', code: 'Invalid' } ]));
        }
    }
    if (data.state !== undefined) {
        var naerr = [ {
            field: 'state',
            code: 'NotAllowed',
            message: 'Parameter cannot be set'
        } ];
        return callback(new errors.ValidationFailedError(
            'invalid image data: "state"', naerr));
    }
    if (data.v === undefined) {
        data.v = imgmanifest.V;
    }
    if (req.channel) {
        data.channels = [req.channel.name];
    }

    async.waterfall([
        function checkOwner(next) {
            utils.checkOwnerExists({
                app: app,
                owner: data.owner
            }, next);
        },

        function ensureOriginExists(next) {
            if (!data.origin) {
                return next();
            }
            log.debug({origin: data.origin}, 'ensure origin exists');
            Image.get(app, data.origin, log, function (err, origin) {
                if (err && err.restCode === 'ResourceNotFound') {
                    next(new errors.OriginDoesNotExistError(err, data.origin));
                } else {
                    next(err);
                }
            });
        },
        function createIt(next) {
            log.info({data: data}, 'CreateImage: create it');
            Image.create(app, data, false, false, next);
        },
        function addItToArchive(image, next) {
            var local = app.storage.local;
            var manifest = image.serialize(app.mode);
            local.archiveImageManifest(manifest, function (archErr) {
                if (archErr) {
                    log.error({uuid: image.uuid},
                        'error archiving image manifest:', manifest);
                    return next(archErr);
                }
                next(null, image);
            });
        },
        function addItToDb(image, next) {
            app.db.add(image.uuid, image.raw, function (addErr) {
                if (addErr) {
                    log.error({uuid: image.uuid},
                        'error saving to database: raw data:', image.raw);
                    return next(addErr);
                }
                app.cacheInvalidateWrite('Image', image);
                req._image = image;
                next();
            });
        }
    ], callback);
}


function apiCreateImageFromVm(req, res, callback) {
    if (req.query.action !== 'create-from-vm')
        return callback();
    var app = req._app;
    var log = req.log;

    if (!app.getStor('manta') && !app.config.allowLocalCreateImageFromVm) {
        return callback(new errors.NotAvailableError(
            'custom image creation is not currently available'));
    }

    var vmUuid = req.query.vm_uuid;
    if (vmUuid === undefined) {
        return callback(new errors.ValidationFailedError(
            'missing \'vm_uuid\' parameter',
            [ { field: 'vm_uuid', code: 'MissingParameter' } ]));
    } else if (!UUID_RE.test(vmUuid)) {
        return callback(new errors.InvalidParameterError(
            format('invalid \'vm_uuid\': not a UUID: \'%s\'', vmUuid),
            [ { field: 'vm_uuid', code: 'Invalid' } ]));
    }

    var incremental = false;
    if (req.query.incremental !== undefined) {
        try {
            incremental = utils.boolFromString(req.query.incremental,
                false, 'incremental');
        } catch (e) {
            return callback(e);
        }
    }

    var maxOriginDepth;
    if (req.query.max_origin_depth !== undefined) {
        maxOriginDepth = Number(req.query.max_origin_depth);
        if (isNaN(maxOriginDepth)) {
            return callback(new errors.InvalidParameterError(
                format('max_origin_depth query param, "%s", is not a number',
                    req.query.max_origin_depth),
                [ { field: 'max_origin_depth', code: 'Invalid' } ]));
        } else if (maxOriginDepth < 2) {
            return callback(new errors.InvalidParameterError(
                format(
                'max_origin_depth query param, %s, must be greater than 1',
                req.query.max_origin_depth),
                [ { field: 'max_origin_depth', code: 'Invalid' } ]));
        }
    }

    var manifest = req.body;
    if (typeof (manifest) !== 'object') {
        return callback(new errors.ValidationFailedError(
            'missing request body (image manifest)',
            [ { field: 'body', code: 'MissingParameter' } ]));
    }

    var account;
    if (req.query.account) {
        account = req.query.account;
        if (!UUID_RE.test(account)) {
            return callback(new errors.InvalidParameterError(
                format('invalid "account": not a UUID: "%s"', account),
                [ { field: 'account', code: 'Invalid' } ]));
        }

        if (!manifest.owner) {
            manifest.owner = account;
        } else if (manifest.owner !== account) {
            return callback(new errors.InvalidParameterError(
                format('invalid owner: given owner, "%s", does not ' +
                    'match account, "%s"', manifest.owner, account),
                [ { field: 'owner', code: 'Invalid' } ]));
        }
    }

    if (req.channel) {
        manifest.channels = [req.channel.name];
    }

    var wfapi = app.wfapi;
    if (wfapi.connected !== true) {
        return callback(
            new errors.ServiceUnavailableError('Workflow API is down.'));
    }

    if (manifest.uuid === undefined) {
        manifest.uuid = genUuid.create();
    }
    // Workaround IMGAPI-251: see note above.
    if (incremental && !(manifest.requirements &&
                         manifest.requirements.min_platform)) {
        if (!manifest.requirements)
            manifest.requirements = {};
        manifest.requirements.min_platform = IMGAPI_251_MIN_PLATFORM;
    }

    var vm;
    var vmServer;
    var prepareImageScript;
    async.waterfall([
        // Ensure the vm is on a CN with sufficient platform (IMGAPI-298).
        function getVmServer(next) {
            var vmapi = new sdc.VMAPI({url: app.config.vmapi.url, log: log});
            var params = {uuid: vmUuid, owner_uuid: account};
            var opts = {headers: {'x-request-id': req.getId()}};
            vmapi.getVm(params, opts, function (err, vm_) {
                if (err) {
                    return next(new errors.InvalidParameterError(
                        err,
                        format('could not get VM "%s" details', vmUuid),
                        [ {field: 'vm_uuid', code: 'Invalid'} ]));
                }
                vm = vm_;
                next(null, vm.server_uuid);
            });
        },
        function ensureSufficientPlatform(serverUuid, next) {
            var minVer = app.config.minImageCreationPlatform;
            var minVerObj = minVer[0].split('.').map(
                function (s) { return Number(s); });
            minVerObj.push(minVer[1]);

            var cnapi = new sdc.CNAPI({url: app.config.cnapi.url, log: log});
            var opts = {headers: {'x-request-id': req.getId()}};
            cnapi.getServer(serverUuid, opts, function (err, server) {
                if (err) {
                    return next(new errors.InternalError(err, format(
                        'could not get server "%s" details', serverUuid)));
                }
                vmServer = server;

                var serverVersion;
                var sdcVersion = server.sysinfo['SDC Version'];
                if (sdcVersion) {
                    serverVersion = sdcVersion.split('.').map(
                        function (s) { return Number(s); });
                } else {
                    serverVersion = [6, 5];
                }
                serverVersion.push(server.current_platform);

                if (serverVersion < minVerObj) {
                    next(new errors.InsufficientServerVersionError(
                        format('cannot create an image from VM %s because it '
                            + 'resides on a server of insufficient version, '
                            + 'min version is %s/%s', vmUuid,
                            minVer[0], minVer[1])));
                } else {
                    next();
                }
            });
        },

        /*
         * Workaround IMGAPI-312: 'imgadm create' for *smartos* images
         * needs to set min_platform to the current platform version
         * to avoid bw binary incompat. imgadm v2.6.2 does this. We
         * need it for imgadm <2.6.2 in the wild.
         *
         * This intentionally overrides a possible 'min_platform' setting
         * above.
         */
        function workaroundImgapi312(next) {
            if (vm.brand !== 'kvm' /* i.e. this is smartos */) {
                if (!manifest.requirements)
                    manifest.requirements = {};
                manifest.requirements.min_platform = {};
                manifest.requirements.min_platform[
                    vmServer.sysinfo['SDC Version']]
                        = vmServer.current_platform;
                log.info({min_platform: manifest.requirements.min_platform},
                    'set smartos image creation min_platform ' +
                    '(workaround IMGAPI-312)');
            }
            next();
        },

        function getPrepareImageScript(next) {
            var protoImageUuid;
            if (vm.brand === 'kvm') {
                if (vm.disks) {
                    for (var i = 0; i < vm.disks.length; i++) {
                        if (vm.disks[i].image_uuid) {
                            protoImageUuid = vm.disks[i].image_uuid;
                            break;
                        }
                    }
                }
            } else {
                protoImageUuid = vm.image_uuid;
            }
            if (!protoImageUuid) {
                return next(new errors.InternalError('could not determine ' +
                    'image_uuid for VM ' + vm.uuid));
            }
            Image.get(app, protoImageUuid, log, function (getErr, protoImage) {
                if (getErr) {
                    return next(getErr);
                }
                var os = protoImage.os;
                var prepareImagePath = path.join(TOP, 'tools', 'prepare-image',
                    os + '-prepare-image');
                fs.exists(prepareImagePath, function (exists) {
                    if (!exists) {
                        log.debug({prepareImagePath: prepareImagePath},
                            'prepare-image script does not exist');
                        return next(new errors.NotAvailableError(format(
                            'image creation for OS "%s" is not currently ' +
                            'supported (VM %s, origin image %s)', os,
                            vm.uuid, protoImageUuid)));
                    }
                    fs.readFile(prepareImagePath, 'utf8', function (rErr, s) {
                        if (rErr) {
                            return next(new errors.InternalError(rErr,
                                'error loading prepare-image script for OS ' +
                                os));
                        }
                        prepareImageScript = s;
                        next();
                    });
                });
            });
        },

        function checkOwner(next) {
            utils.checkOwnerExists({
                app: app,
                owner: manifest.owner
            }, next);
        },
        function createPlaceholder(next) {
            var data = objCopy(manifest);
            log.info({data: data},
                'CreateImageFromVm: create placeholder image');
            Image.create(app, data, false, true, next);
        },
        function addItToArchive(image, next) {
            var local = app.storage.local;
            var mnfst = image.serialize(app.mode);
            local.archiveImageManifest(mnfst, function (archErr) {
                if (archErr) {
                    log.error({uuid: image.uuid},
                        'error archiving image manifest:', mnfst);
                    return next(archErr);
                }
                next(null, image);
            });
        },
        function addPlaceholderToDb(image, next) {
            app.db.add(image.uuid, image.raw, function (addErr) {
                if (addErr) {
                    log.error({uuid: image.uuid},
                        'error saving to database: raw data:', image.raw);
                    return next(addErr);
                }
                app.cacheInvalidateWrite('Image', image);
                req._image = image;
                next();
            });
        },
        function createJob(next) {
            var jobOpts = {
                req: req,
                vmUuid: vmUuid,
                manifest: manifest,
                incremental: incremental,
                prepareImageScript: prepareImageScript,
                maxOriginDepth: maxOriginDepth
            };
            wfapi.createImageFromVmJob(jobOpts, function (err, jobUuid) {
                if (err) {
                    return next(err);
                }
                // Allow clients to know where is wfapi located
                res.header('workflow-api', app.config.wfapi.url);
                res.send({ image_uuid: manifest.uuid, job_uuid: jobUuid });
                return next(false);
            });
        }
    ], callback);
}


function apiAdminImportImage(req, res, callback) {
    if (req.query.action !== 'import')
        return callback();
    if (req.query.source !== undefined)
        return callback();

    var log = req.log;
    var app = req._app;
    var data = req.body;

    if (req.query.account) {
        return callback(new errors.OperatorOnlyError());
    }
    if (req.params.uuid !== data.uuid) {
        return callback(new errors.InvalidParameterError(
            format('URL UUID, "%s" and body UUID, "%s" do not match',
                req.params.uuid, data.uuid),
            [ { field: 'uuid', code: 'Invalid' } ]));
    }

    var skipOwnerCheck = false;
    if (req.query.skip_owner_check) {
        try {
            skipOwnerCheck = utils.boolFromString(req.query.skip_owner_check,
                false, 'skip_owner_check');
        } catch (e) {
            return callback(e);
        }
    }

    var uuid = data.uuid;
    var placeholder;  // The placeholder image, if any.
    async.waterfall([
        function checkIfAlreadyExists(next) {
            Image.get(app, uuid, log, function (gErr, image) {
                if (!gErr) {
                    assert.object(image, 'image');
                    if (image.state === 'creating') {
                        placeholder = image;
                        next();
                    } else {
                        next(new errors.ImageUuidAlreadyExistsError(uuid));
                    }
                } else if (gErr.restCode !== 'ResourceNotFound') {
                    next(gErr);
                } else {
                    next();
                }
            });
        },
        function ensureOriginExists(next) {
            if (!data.origin) {
                return next();
            }
            log.debug({origin: data.origin}, 'ensure origin exists');
            Image.get(app, data.origin, log, function (err, origin) {
                if (err && err.restCode === 'ResourceNotFound') {
                    next(new errors.OriginDoesNotExistError(err, data.origin));
                } else {
                    next(err);
                }
            });
        },
        function handleOwner(next) {
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
                if (data.owner === UNSET_OWNER_UUID) {
                    data.owner = app.config.adminUuid;
                    return next();
                }
            } else {
                data.owner = UNSET_OWNER_UUID;
            }

            if (skipOwnerCheck) {
                return next();
            }
            utils.checkOwnerExists({
                app: app,
                owner: data.owner
            }, next);
        },
        function createIt(next) {
            log.info({data: data}, 'AdminImportImage: create it');
            Image.create(app, data, true, false, next);
        },
        function addItToArchive(image, next) {
            var local = app.storage.local;
            var manifest = image.serialize(app.mode);
            local.archiveImageManifest(manifest, function (archErr) {
                if (archErr) {
                    log.error({uuid: image.uuid},
                        'error archiving image manifest:', manifest);
                    return next(archErr);
                }
                next(null, image);
            });
        },
        function addItToDb(image, next) {
            if (placeholder) {
                /*
                 * Because of OS-2651 we need to workaround IMGAPI-312 *again*!
                 * SmartOS custom images need a min_platform of the current
                 * platform of the source VM.
                 *
                 * The appropriate min_platform was set on the placeholder.
                 * Use that.
                 */
                if (image.os === 'smartos' &&
                    !imgadmVersionFromReq(req))
                {
                    image.requirements.min_platform =
                        placeholder.requirements.min_platform;
                    image.raw.requirements = image.requirements;
                    log.info({min_platform: image.requirements.min_platform,
                        image: image.uuid}, 'restoring smartos image ' +
                        'min_platform (workaround IMGAPI-312 again)');
                }

                /*
                 * Workaround OS-2651: This was a bug where imgadm create would
                 * wipe out a given `manifest.requirements`. The fix was added
                 * in imgadm 2.6.1. In that version imgadm was changed to
                 * identify itself in the user-agent header. Use that to scope
                 * down the workaround.
                 */
                if (Object.keys(image.requirements).length === 0 &&
                    placeholder.requirements.min_platform['6.5'] ===
                        IMGAPI_251_MIN_PLATFORM['6.5'] &&
                    placeholder.requirements.min_platform['7.0'] ===
                        IMGAPI_251_MIN_PLATFORM['7.0'] &&
                    !imgadmVersionFromReq(req))
                {
                    log.info({requirements: placeholder.raw.requirements,
                        image: image.uuid},
                        'restoring placeholder image requirements ' +
                        '(workaround OS-2651)');
                    image.raw.requirements = placeholder.raw.requirements;
                    image.requirements = placeholder.requirements;
                }

                Image.modify(app, image, req.log, function (err) {
                    if (err) {
                        log.error({uuid: image.uuid},
                            'error saving to database: raw data:', image.raw);
                        return next(err);
                    }
                    res.send(image.serialize(req._app.mode));
                    next(false);
                });
            } else {
                app.db.add(image.uuid, image.raw, function (addErr) {
                    if (addErr) {
                        log.error({uuid: image.uuid},
                            'error saving to database: raw data:', image.raw);
                        return next(addErr);
                    }
                    app.cacheInvalidateWrite('Image', image);
                    var serialized = image.serialize(req._app.mode);
                    resSetEtag(req, res, serialized);
                    res.send(serialized);
                    next(false);
                });
            }
        }
    ], callback);
}


/**
 * This is the form of the `AdminImportImage` endpoint with `?source=...`. It
 * isn't documented as a *separate* endpoint.
 */
function apiAdminImportImageFromSource(req, res, cb) {
    if (req.query.action !== 'import')
        return cb();
    if (req.query.source === undefined)
        return cb();

    if (req.query.account) {
        return cb(new errors.OperatorOnlyError());
    }
    var skipOwnerCheck = false;
    if (req.query.skip_owner_check) {
        try {
            skipOwnerCheck = utils.boolFromString(req.query.skip_owner_check,
                false, 'skip_owner_check');
        } catch (e) {
            return cb(e);
        }
    }

    var uuid = req.params.uuid;
    var source = req.query.source;
    var app = req._app;
    var log = req.log;

    var manifest;
    var newImage;
    var serialized;
    vasync.pipeline({funcs: [
        function getImageFromSource(_, next) {
            var client = new sdc.IMGAPI({ url: source, log: log });
            client.getImage(uuid, function (err, manifest_) {
                if (err) {
                    log.error(err, 'failed to get manifest for image %s',
                        uuid);
                    return next(new errors.RemoteSourceError(format('Unable ' +
                        'to get manifest for image %s. Error from remote: %s',
                        uuid, err.message || err.code)));
                }
                manifest = manifest_;
                next();
            });
        },

        function checkImageDoesNotExist(_, next) {
            log.debug({ uuid: uuid },
                'AdminImportImageFromSource: check if image already exists');
            Image.get(app, uuid, log, function (err, image) {
                if (!err) {
                    assert.object(image, 'image');
                    next(new errors.ImageUuidAlreadyExistsError(uuid));
                } else if (err.restCode !== 'ResourceNotFound') {
                    next(err);
                } else {
                    next();
                }
            });
        },

        function handleOwner(_, next) {
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
                if (manifest.owner === UNSET_OWNER_UUID) {
                    manifest.owner = app.config.adminUuid;
                    return next();
                }
            } else {
                manifest.owner = UNSET_OWNER_UUID;
            }

            if (skipOwnerCheck) {
                return next();
            }
            utils.checkOwnerExists({
                app: app,
                owner: manifest.owner
            }, next);
        },

        function createImageFromManifest(_, next) {
            log.debug({ data: manifest },
                'AdminImportImageFromSource: create it');
            Image.create(app, manifest, true, false, function (cErr, img) {
                if (cErr) {
                    return next(cErr);
                }
                newImage = img;
                next();
            });
        },

        function archiveManifest(_, next) {
            var local = app.storage.local;
            serialized = newImage.serialize(app.mode);
            local.archiveImageManifest(serialized, function (archErr) {
                if (archErr) {
                    log.error({uuid: newImage.uuid},
                        'error archiving image manifest:', serialized);
                    return next(archErr);
                }
                next();
            });
        },

        function addManifestToDb(_, next) {
            app.db.add(newImage.uuid, newImage.raw, function (addErr) {
                if (addErr) {
                    log.error({uuid: newImage.uuid},
                        'error saving to database: raw data:',
                        newImage.raw);
                    return next(new errors.InternalError(addErr,
                        'could create local image'));
                }
                app.cacheInvalidateWrite('Image', newImage);
                next();
            });
        }
    ]}, function (err) {
        if (err) {
            return cb(err);
        }

        // Respond.
        resSetEtag(req, res, serialized);
        res.send(serialized);
        cb(false);
    });
}


function apiAdminImportRemoteImage(req, res, callback) {
    if (req.query.action !== 'import-remote')
        return callback();

    var source = req.query.source;
    if (source === undefined) {
        var errs = [ { field: 'source', code: 'MissingParameter' } ];
        return callback(new errors.ValidationFailedError(
            'missing source parameter', errs));
    }

    var log = req.log;
    var app = req._app;

    if (req.query.account) {
        return callback(new errors.OperatorOnlyError());
    }

    var skipOwnerCheck = false;
    if (req.query.skip_owner_check) {
        try {
            skipOwnerCheck = utils.boolFromString(req.query.skip_owner_check,
                false, 'skip_owner_check');
        } catch (e) {
            return callback(e);
        }
    }

    var uuid = req.params.uuid;
    log.debug({uuid: uuid},
        'AdminImportRemoteImage: check if image already exists');
    Image.get(app, uuid, log, function (gErr, image) {
        if (!gErr) {
            assert.object(image, 'image');
            return callback(new errors.ImageUuidAlreadyExistsError(uuid));
        } else if (gErr.restCode !== 'ResourceNotFound') {
            return callback(gErr);
        }

        log.debug({uuid: uuid, source: source},
            'AdminImportRemoteImage: start import');

        Image.createImportImageJob(req, uuid, source, skipOwnerCheck, log,
            function (err, juuid) {
            if (err) {
                return callback(err);
            }

            // Allow clients to know where is wfapi located
            res.header('workflow-api', app.config.wfapi.url);
            res.send({ image_uuid: uuid, job_uuid: juuid });
            return callback(false);
        });
    });
}


function apiAddImageFile(req, res, next) {
    if (req.query.source !== undefined)
        return next();

    req.log.debug({image: req._image}, 'AddImageFile: start');

    // Can't change files on an activated image.
    if (req._image.activated) {
        return next(new errors.ImageFilesImmutableError(req._image.uuid));
    }

    // Validate compression.
    var compression = req.query.compression;
    if (!compression) {
        return next(new errors.InvalidParameterError('missing "compression"',
            [ { field: 'compression', code: 'Missing' } ]));
    } else if (VALID_FILE_COMPRESSIONS.indexOf(compression) === -1) {
        return next(new errors.InvalidParameterError(
            format('invalid compression "%s" (must be one of %s)',
                compression, VALID_FILE_COMPRESSIONS.join(', ')),
            [ { field: 'compression', code: 'Invalid' } ]));
    }

    // Validate requested storage. Only admin requests are allowed to specify.
    var preferredStorage = req.query.storage;
    if (preferredStorage && req.query.account) {
        var error = {
            field: 'storage',
            code: 'NotAllowed',
            message: 'Parameter cannot be specified by non-operators'
        };
        return next(new errors.InvalidParameterError(
            format('invalid storage "%s"', preferredStorage), [error]));
    } else if (preferredStorage) {
        if (VALID_STORAGES.indexOf(preferredStorage) === -1) {
            return next(new errors.InvalidParameterError(
                format('invalid storage "%s" (must be one of %s)',
                    preferredStorage, VALID_STORAGES.join(', ')),
                [ { field: 'storage', code: 'Invalid' } ]));
        }
    }

    var contentLength;
    if (req.headers['content-length']) {
        contentLength = Number(req.headers['content-length']);
        if (isNaN(contentLength)) {
            // TODO: error on bogus header
            contentLength = undefined;
        }
    }

    var sha1, sha1Param;
    if (req.query.sha1) {
        sha1Param = req.query.sha1;
    }

    var size = 0;
    var stor;  // the storage class
    function finish_(err, tmpFilename, filename) {
        if (err) {
            return next(err);
        }
        if (size > MAX_IMAGE_SIZE) {
            return next(new errors.UploadError(format(
                'image file size, %s, exceeds the maximum allowed file ' +
                'size, %s', size, MAX_IMAGE_SIZE_STR)));
        }
        if (contentLength && size !== contentLength) {
            return next(new errors.UploadError(format(
                '"Content-Length" header, %s, does not match uploaded ' +
                'size, %d', contentLength, size)));
        }

        sha1 = shasum.digest('hex');
        if (sha1Param && sha1Param !== sha1) {
            return next(new errors.UploadError(format(
                '"sha1" hash, %s, does not match the uploaded ' +
                'file sha1 hash, %s', sha1Param, sha1)));
        }

        var file = {
            sha1: sha1,
            size: size,
            contentMD5: md5sum.digest('base64'),
            mtime: (new Date()).toISOString(),
            stor: stor.type,
            compression: compression
        };
        if (req.query.dataset_guid) {
            file.dataset_guid = req.query.dataset_guid;
        }

        // Passing some vars onto `finishMoveImageFile`.
        req.file = file;
        req.storage = stor.type;
        req.tmpFilename = tmpFilename;
        req.filename = filename;

        return next();
    }
    var finish = once(finish_);

    if (contentLength !== undefined && contentLength > MAX_IMAGE_SIZE) {
        finish(new errors.UploadError(format(
            'image file size %s (from Content-Length) exceeds the maximum ' +
            'allowed size, %s', contentLength, MAX_IMAGE_SIZE_STR)));
    }

    size = 0;
    var shasum = crypto.createHash('sha1');
    var md5sum = crypto.createHash('md5');
    req.on('data', function (chunk) {
        size += chunk.length;
        if (size > MAX_IMAGE_SIZE) {
            finish(new errors.UploadError(format(
                'image file size exceeds the maximum allowed size, %s',
                MAX_IMAGE_SIZE_STR)));
        }
        shasum.update(chunk, 'binary');
        md5sum.update(chunk, 'binary');
    });
    req.on('end', function () {
        req.log.trace('req "end" event');
    });
    req.on('close', function () {
        req.log.trace('req "close" event');
    });

    stor = req._app.chooseStor(req._image, preferredStorage);
    stor.storeFileFromStream(req._image, req, 'file0',
      function (sErr, tmpFilename, filename) {
        if (sErr) {
            req.log.error(sErr, 'error storing image file');
            finish(errors.parseErrorFromStorage(
                sErr, 'error receiving image file'));
        } else {
            finish(null, tmpFilename, filename);
        }
    });
}


function apiAddImageFileFromSource(req, res, next) {
    if (req.query.source === undefined)
        return next();

    req.log.debug({image: req._image}, 'AddImageFileFromSource: start');

    // Can't change files on an activated image.
    if (req._image.activated) {
        return next(new errors.ImageFilesImmutableError(req._image.uuid));
    }

    /*
     * Node's default HTTP timeout is two minutes, and this getImageFileStream()
     * request can take longer than that to complete.  Set this connection's
     * timeout to an hour to avoid an abrupt close after two minutes.
     */
    req.connection.setTimeout(60 * 60 * 1000);

    // Validate requested storage. Only admin requests are allowed to specify.
    var preferredStorage = req.query.storage;
    if (preferredStorage && req.query.account) {
        var error = {
            field: 'storage',
            code: 'NotAllowed',
            message: 'Parameter cannot be specified by non-operators'
        };
        return next(new errors.InvalidParameterError(
            format('invalid storage "%s"', preferredStorage), [error]));
    } else if (preferredStorage) {
        if (VALID_STORAGES.indexOf(preferredStorage) === -1) {
            return next(new errors.InvalidParameterError(
                format('invalid storage "%s" (must be one of %s)',
                    preferredStorage, VALID_STORAGES.join(', ')),
                [ { field: 'storage', code: 'Invalid' } ]));
        }
    }

    var uuid = req.params.uuid;
    var source = req.query.source;
    var log = req.log;
    var client = new sdc.IMGAPI({ url: source, log: log });
    // Get the image so we can get the manifest files details
    client.getImage(uuid, addImageFileFromSource);

    function addImageFileFromSource(err, manifest) {
        if (err) {
            log.error(err, 'failed to get manifest for image %s',
                uuid);
            return next(new errors.RemoteSourceError(format('Unable ' +
                'to get manifest for image %s. Error from remote: %s',
                uuid, err.message || err.code)));
        }

        var compression = manifest.files[0].compression;
        var sha1Param = manifest.files[0].sha1;
        var contentLength = manifest.files[0].size;
        var size = 0;
        var sha1, stor;

        client.getImageFileStream(uuid, pipeStream);
        function pipeStream(fileErr, stream) {
            if (fileErr) {
                log.error(fileErr, 'failed to get stream for image file %s',
                    uuid);
                return next(new errors.RemoteSourceError(format('Unable ' +
                    'to get stream for image file %s. Error from remote: %s',
                    uuid, fileErr.message || fileErr.code)));
            }
            // Same thing we did with the req object from the API request
            stream.connection.setTimeout(60 * 60 * 1000);

            function finish_(err2, tmpFilename, filename) {
                if (err2) {
                    return next(err2);
                }
                if (size > MAX_IMAGE_SIZE) {
                    return next(new errors.UploadError(format(
                        'image file size, %s, exceeds the maximum allowed ' +
                        'file size, %s', size, MAX_IMAGE_SIZE_STR)));
                }
                if (contentLength && size !== contentLength) {
                    return next(new errors.UploadError(format(
                        '"Content-Length" header, %s, does not match ' +
                        'uploaded size, %d', contentLength, size)));
                }

                sha1 = shasum.digest('hex');
                if (sha1Param && sha1Param !== sha1) {
                    return next(new errors.UploadError(format(
                        '"sha1" hash, %s, does not match the uploaded ' +
                        'file sha1 hash, %s', sha1Param, sha1)));
                }

                var file = {
                    sha1: sha1,
                    size: size,
                    contentMD5: md5sum.digest('base64'),
                    mtime: (new Date()).toISOString(),
                    stor: stor.type,
                    compression: compression
                };

                if (manifest.files[0].dataset_guid) {
                    file.dataset_guid = manifest.files[0].dataset_guid;
                }

                // Passing some vars on to `finishMoveImageFile`.
                req.file = file;
                req.storage = stor.type;
                req.tmpFilename = tmpFilename;
                req.filename = filename;

                return next();
            }
            var finish = once(finish_);
            var shasum = crypto.createHash('sha1');
            var md5sum = crypto.createHash('md5');

            stream.on('data', function (chunk) {
                size += chunk.length;
                if (size > MAX_IMAGE_SIZE) {
                    finish(new errors.UploadError(format(
                        'image file size exceeds the maximum allowed size, %s',
                        MAX_IMAGE_SIZE_STR)));
                }
                shasum.update(chunk, 'binary');
                md5sum.update(chunk, 'binary');
            });
            stream.on('end', function () {
                req.log.trace('req "end" event');
            });
            stream.on('close', function () {
                req.log.trace('req "close" event');
            });

            stor = req._app.chooseStor(req._image, preferredStorage);
            stor.storeFileFromStream(req._image, stream, 'file0',
              function (sErr, tmpFilename, filename) {
                if (sErr) {
                    req.log.error(sErr, 'error storing image file');
                    finish(errors.parseErrorFromStorage(
                        sErr, 'error receiving image file'));
                } else {
                    finish(null, tmpFilename, filename);
                }
            });
        }
    }
}


/**
 * Complete the AddImageFile[FromSource] endpoint by moving the image file
 * into its final (non-tmp) place.
 */
function finishMoveImageFile(req, res, next) {
    req.log.debug({image: req._image}, 'MoveImageFile: start');

    if (req._image.activated) {
        return next(new errors.ImageAlreadyActivatedError(req._image.uuid));
    }

    var stor = req._app.getStor(req.storage);
    stor.moveImageFile(req._image, req.tmpFilename, req.filename,
      function (mErr) {
        if (mErr) {
            return next(mErr);
        }

        req._image.addFile(req._app, req.file, req.log, function (err2) {
            if (err2) {
                req.log.error(err2, 'error adding file info to Image');
                return next(new errors.InternalError(err2,
                    'could not save image'));
            }

            var serialized = req._image.serialize(req._app.mode);
            resSetEtag(req, res, serialized);
            res.send(serialized);
            next();
        });
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
            format('image "%s" has no file', image.uuid)));
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
    req.log.debug({image: image}, 'GetImageFile: start');

    var nbytes = 0;
    function finish_(err) {
        if (err) {
            res.statusCode = 500;
            req.log.error(err, 'error getting image file');
            res.end();
        }
        next();
    }
    var finish = once(finish_);

    var file = req._image.files[0];
    assert.object(file, 'image.files[0]');
    var stor = req._app.getStor(file.stor);
    stor.createImageFileReadStream(req._image, function (sErr, stream) {
        // TODO: handle 404?
        if (sErr) {
            return finish(sErr);
        }
        stream.on('end', function () {
            req.log.debug({nbytes: nbytes},
                'SAPI-66: GetImageFile stream "end" event');
            finish();
        });
        stream.on('close', function () {
            req.log.debug({nbytes: nbytes},
                'SAPI-66: GetImageFile stream "close" event');
        });
        stream.on('error', function (err) {
            finish(err);
        });
        stream.on('data', function (chunk) {
            nbytes += chunk.length;
        });
        stream.pipe(res);
    });
}


function apiAddImageIcon(req, res, next) {
    req.log.debug({image: req._image}, 'AddImageIcon: start');

    if (ICON_CONTENT_TYPES.indexOf(req.headers['content-type']) === -1) {
        return next(new errors.UploadError(format(
            'invalid content-type, %s, must be one of %s',
            req.headers['content-type'], ICON_CONTENT_TYPES.join(', '))));
    }

    // Validate requested storage. Only admin requests are allowed to specify.
    var preferredStorage = req.query.storage;
    if (preferredStorage && req.query.account) {
        var error = {
            field: 'storage',
            code: 'NotAllowed',
            message: 'Parameter cannot be specified by non-operators'
        };
        return next(new errors.InvalidParameterError(
            format('invalid storage "%s"', preferredStorage), [error]));
    } else if (preferredStorage) {
        if (VALID_STORAGES.indexOf(preferredStorage) === -1) {
            return next(new errors.InvalidParameterError(
                format('invalid storage "%s" (must be one of %s)',
                    preferredStorage, VALID_STORAGES.join(', ')),
                [ { field: 'storage', code: 'Invalid' } ]));
        }
    }

    var contentLength;
    if (req.headers['content-length']) {
        contentLength = Number(req.headers['content-length']);
        if (isNaN(contentLength)) {
            // TODO: error on bogus header
            contentLength = undefined;
        }
    }

    var sha1, sha1Param;
    if (req.query.sha1) {
        sha1Param = req.query.sha1;
    }

    var size = 0;
    var stor;  // the storage class
    function finish_(err, tmpFilename, filename) {
        if (err) {
            return next(err);
        }
        if (size > MAX_ICON_SIZE) {
            return next(new errors.UploadError(format(
                'icon size, %s, exceeds the maximum allowed file ' +
                'size, %s', size, MAX_ICON_SIZE_STR)));
        }
        if (contentLength && size !== contentLength) {
            return next(new errors.UploadError(format(
                '"Content-Length" header, %s, does not match uploaded ' +
                'size, %d', contentLength, size)));
        }

        sha1 = shasum.digest('hex');
        if (sha1Param && sha1Param !== sha1) {
            return next(new errors.UploadError(format(
                '"sha1" hash, %s, does not match the uploaded ' +
                'icon file sha1 hash, %s', sha1Param, sha1)));
        }

        var icon = {
            sha1: sha1,
            size: size,
            contentType: req.headers['content-type'],
            contentMD5: md5sum.digest('base64'),
            mtime: (new Date()).toISOString(),
            stor: stor.type
        };
        // Passing some vars on to `finishMoveImageIcon`.
        req.icon = icon;
        req.storage = stor.type;
        req.tmpFilename = tmpFilename;
        req.filename = filename;

        return next();
    }
    var finish = once(finish_);

    if (contentLength !== undefined && contentLength > MAX_ICON_SIZE) {
        finish(new errors.UploadError(format(
            'icon size %s (from Content-Length) exceeds the maximum allowed ' +
            'size, %s', contentLength, MAX_ICON_SIZE_STR)));
    }

    size = 0;
    var shasum = crypto.createHash('sha1');
    var md5sum = crypto.createHash('md5');
    req.on('data', function (chunk) {
        size += chunk.length;
        if (size > MAX_ICON_SIZE) {
            finish(new errors.UploadError(format(
                'icon size exceeds the maximum allowed size, %s',
                MAX_ICON_SIZE_STR)));
        }
        shasum.update(chunk, 'binary');
        md5sum.update(chunk, 'binary');
    });
    req.on('end', function () {
        req.log.trace('req "end" event');
    });
    req.on('close', function () {
        req.log.trace('req "close" event');
    });

    stor = req._app.chooseStor(req._image, preferredStorage);
    stor.storeFileFromStream(req._image, req, 'icon',
      function (sErr, tmpFilename, filename) {
        if (sErr) {
            req.log.error(sErr, 'error storing image icon');
            finish(errors.parseErrorFromStorage(
                sErr, 'error receiving image icon'));
        } else {
            finish(null, tmpFilename, filename);
        }
    });
}


/**
 * Complete the AddImageIcon endpoint by moving the image file
 * into its final (non-tmp) place.
 */
function finishMoveImageIcon(req, res, next) {
    req.log.debug({image: req._image}, 'MoveImageIcon: start');

    var stor = req._app.getStor(req.storage);
    stor.moveImageFile(req._image, req.tmpFilename, req.filename,
      function (mErr) {
        if (mErr) {
            return next(mErr);
        }

        req._image.addIcon(req._app, req.icon, req.log, function (err2) {
            if (err2) {
                req.log.error(err2, 'error setting icon=true to Image');
                return next(new errors.InternalError(err2,
                    'could not save icon data'));
            }

            var serialized = req._image.serialize(req._app.mode);
            resSetEtag(req, res, serialized);
            res.send(serialized);
            next();
        });
    });
}


function apiDeleteImageIcon(req, res, next) {
    var image = req._image;
    req.log.debug({image: image}, 'DeleteImageIcon: start');

    var icon = image.icon;
    assert.object(icon, 'image.icon');
    var stor = req._app.getStor(icon.stor);
    stor.deleteImageFile(image, 'icon', function (fileErr) {
        if (fileErr) {
            req.log.error({err: fileErr, image: image},
                'error deleting model icon, this image may have a' +
                'zombie icon file which must be remove manually ' +
                'by an operator');
            return next(errors.parseErrorFromStorage(fileErr,
                'error deleting image icon'));
        }

        req._image.deleteIcon(req._app, req.log, function (err) {
            if (err) {
                req.log.error(err, 'error removing icon from Image');
                return next(new errors.InternalError(err,
                    'could not delete icon'));
            }

            var serialized = req._image.serialize(req._app.mode);
            resSetEtag(req, res, serialized);
            res.send(serialized);
            next();
        });
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
            format('image "%s" has no icon', image.uuid)));
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
    req.log.debug({image: image}, 'GetImageIcon: start');

    function finish_(err) {
        if (err) {
            res.statusCode = 500;
            req.log.error(err, 'error getting icon file');
            res.end();
        }
        next();
    }
    var finish = once(finish_);

    var icon = req._image.icon;
    assert.object(icon, 'image.icon');
    var stor = req._app.getStor(icon.stor);
    stor.createImageFileReadStream(req._image, 'icon', function (sErr, stream) {
        // TODO: handle 404?
        if (sErr) {
            return finish(sErr);
        }
        stream.on('end', function () {
            req.log.trace('GetImageIcon stream "end" event');
            finish();
        });
        stream.on('error', function (err) {
            finish(err);
        });
        stream.pipe(res);
    });
}


function apiExportImage(req, res, callback) {
    if (req.query.action !== 'export')
        return callback();

    var app = req._app;
    var log = req.log;
    var mpath = req.query.manta_path;
    if (mpath === undefined) {
        return callback(new errors.ValidationFailedError(
            'missing \'manta_path\' prefix parameter',
            [ { field: 'manta_path', code: 'MissingParameter' } ]));
    }

    mpath = path.normalize(mpath);
    var muser = mpath.split('/')[1];
    if (muser === undefined || muser === '') {
        return callback(new errors.InvalidParameterError(
            'invalid manta_path prefix, not a valid manta path',
            [ { field: 'manta_path', code: 'Invalid' } ]));
    }

    var image = req._image;
    // Check that we can store to manta and the the image file lives on manta
    var stor = app.getStor('manta');
    if (stor ===  undefined || stor.type !== 'manta') {
        return callback(new errors.StorageUnsupportedError());
    }
    var file = image.files[0];
    assert.object(file, 'image.files[0]');
    var fstor = app.getStor(file.stor);
    if (fstor.type !== 'manta') {
        return callback(new errors.StorageUnsupportedError());
    }
    var ext = {
        'bzip2': '.bz2',
        'gzip': '.gz',
        'none': ''
    }[file.compression || 'none'];

    var account = req.query.account;
    // account is given:
    //      Call from CloudAPI, account must be the same as the manta user
    if (account) {
        app.ufdsClient.getUser(account, function (err, user) {
            if (err) {
                return callback(new errors.AccountDoesNotExistError(
                    err, account));
            } else if (user.login !== muser) {
                return callback(
                    new errors.NotMantaPathOwnerError(account, mpath));
            }
            exportImage();
        });
    // account is not given:
    //      Call from admin user, can only export to storage.manta.user
    } else {
        if (muser !== stor.user) {
            return callback(
                new errors.NotMantaPathOwnerError(stor.user, mpath));
        }
        exportImage();
    }

    /*
     * Node's default HTTP timeout is two minutes, and this request can take
     * longer than that to complete.  Set this connection's timeout to an hour
     * to avoid an abrupt close after two minutes.
     */
    req.connection.setTimeout(60 * 60 * 1000);

    var manifestStorPath, fileStorPath;
    function exportImage() {
        async.waterfall([
            function validatePaths(next) {
                stor.client.ls(mpath, function (err, resp) {
                    if (err) {
                        return next(err);
                    }

                    resp.once('error', function (rerr) {
                        // If path is not a directory then it is an output
                        // template
                        if (rerr.code && rerr.code === 'ResourceNotFound') {
                            manifestStorPath = format('%s.%s', mpath,
                                'imgmanifest');
                            fileStorPath = format('%s.zfs%s', mpath, ext);
                            next();
                        } else {
                            next(rerr);
                        }
                    });

                    resp.once('end', function () {
                        // Path is a directory, use it as a prefix path
                        var manifest = format('%s-%s.%s',
                            image.name, image.version, 'imgmanifest');
                        var filename = format('%s-%s.zfs%s',
                            image.name, image.version, ext);

                        manifestStorPath = path.resolve(mpath, manifest);
                        fileStorPath = path.resolve(mpath, filename);
                        next();
                    });
                });
            },
            function exportManifest(next) {
                var string = JSON.stringify(image.serialize(app.mode), null, 4);

                stor.exportImageManifest(
                string, manifestStorPath, function (sErr) {
                    if (sErr) {
                        log.error(sErr, 'error exporting image manifest');
                        next(errors.parseErrorFromStorage(
                            sErr, 'error exporting image manifest'));
                    } else {
                        next();
                    }
                });
            },
            function exportImageFile(next) {
                stor.snapLinkImageFile(image, fileStorPath, function (sErr) {
                    if (sErr) {
                        log.error(sErr, 'error creating image file snaplink');
                        next(errors.parseErrorFromStorage(
                            sErr, 'error creating image file snaplink'));
                    } else {
                        next();
                    }
                });
            }
        ], function (err) {
            if (err) {
                return callback(err);
            }
            res.send({
                'manta_url': app.config.storage.manta.url,
                'image_path': fileStorPath,
                'manifest_path': manifestStorPath
            });
            return callback(false);
        });
    }
}


function apiActivateImage(req, res, next) {
    if (req.query.action !== 'activate')
        return next();

    req.log.debug({image: req._image}, 'ActivateImage: start');
    req._image.activate(req._app, req.log, function (err) {
        if (err) {
            return next(err);
        }
        var serialized = req._image.serialize(req._app.mode);
        resSetEtag(req, res, serialized);
        res.send(serialized);
        next(false);
    });
}


/**
 * Handle EnableImage and DisableImage endpoints.
 */
function apiEnableDisableImage(req, res, next) {
    if (req.query.action !== 'enable' && req.query.action !== 'disable')
        return next();

    var name, method;
    if (req.query.action === 'enable') {
        name = 'EnableImage';
        method = 'enable';
    } else {
        name = 'DisableImage';
        method = 'disable';
    }

    req.log.debug({image: req._image}, '%s: start', name);
    req._image[method](req._app, req.log, function (err) {
        if (err) {
            return next(err);
        }
        var serialized = req._image.serialize(req._app.mode);
        resSetEtag(req, res, serialized);
        res.send(serialized);
        next(false);
    });
}


/**
 * ChannelAddImage endpoint.
 */
function apiChannelAddImage(req, res, next) {
    if (req.query.action !== 'channel-add')
        return next();

    // Pretend this endpoint doesn't exist if not configured for channels.
    var channelFromName = req._app.channelFromName;
    if (!req._app.channelFromName)
        return next();

    var name = req.body.channel;
    if (!channelFromName[name]) {
        return next(new errors.ValidationFailedError(
            'unknown channel: ' + name,
            [ { field: 'channel', code: 'Invalid' } ]));
    }

    req._image.channelAdd(req._app, name, req.log, function (err) {
        if (err) {
            return next(err);
        }
        var serialized = req._image.serialize(req._app.mode);
        resSetEtag(req, res, serialized);
        res.send(serialized);
        next(false);
    });
}


function apiUpdateImage(req, res, cb) {
    if (req.query.action !== 'update') {
        return cb();
    }

    req.log.debug({image: req._image}, 'UpdateImage: start');

    var image;
    vasync.pipeline({funcs: [
        function validateFields(_, next) {
            var ADMIN_ONLY_ATTRS = [
                'state',
                'error',
                'billing_tags',
                'traits'
            ];

            var UPDATEABLE_ATTRS = imgmanifest.fields.filter(function (field) {
                return field.mutable;
            }).map(function (field) {
                return field.name;
            });

            var data = req.body;
            if (typeof (data) !== 'object') {
                return next(new errors.ValidationFailedError(
                    'missing request body',
                    [ { field: 'body', code: 'MissingParameter' } ]));
            }

            var dataKeys = Object.keys(data);
            if (dataKeys.length === 0) {
                return next(new errors.ValidationFailedError(
                    'invalid image update data: no parameters provided', []));
            }

            var i, key;
            var errs = [];
            for (i = 0; i < dataKeys.length; i++) {
                key = dataKeys[i];
                if (UPDATEABLE_ATTRS.indexOf(key) === -1 &&
                    ADMIN_ONLY_ATTRS.indexOf(key) === -1) {
                    errs.push({
                        field: key,
                        code: 'NotAllowed',
                        message: 'Parameter cannot be updated'
                    });
                }
            }

            for (i = 0; i < ADMIN_ONLY_ATTRS.length; i++) {
                key = ADMIN_ONLY_ATTRS[i];
                if (data[key] !== undefined &&
                    req.query.account !== undefined)
                {
                    errs.push({
                        field: key,
                        code: 'NotAllowed',
                        message: 'Can only be updated by operators'
                    });
                }
            }

            if (errs.length) {
                var fields = errs.map(function (e) { return e.field; });
                return next(new errors.ValidationFailedError(
                    'invalid image update data: ' + fields.join(', '), errs));
            }

            // Raw format of tags
            if (data.tags) {
                data.tags = utils.objectToKeyValue(data.tags);
            }

            // Merge new values into existing raw data.
            var raw = objCopy(req._image.raw);
            for (i = 0; i < dataKeys.length; i++) {
                key = dataKeys[i];
                if (data[key] === null) {
                    delete raw[key];
                } else {
                    raw[key] = data[key];
                }
            }

            // Revalidate.
            try {
                image = new Image(req._app, raw);
            } catch (cErr) {
                return next(cErr);
            }

            next();
        },

        function checkOwner(_, next) {
            utils.checkOwnerExists({
                app: req._app,
                owner: image.owner
            }, next);
        },

        function doModify(_, next) {
            Image.modify(req._app, image, req.log, next);
        }

    ]}, function (err) {
        if (err) {
            return cb(err);
        }

        // Respond.
        var serialized = image.serialize(req._app.mode);
        resSetEtag(req, res, serialized);
        res.send(serialized);
        cb(false);
    });
}


/**
 * Delete the given image.
 *
 * If this imgapi supports channels, then the image is just removed from that
 * channel. Only when removing from the last channel are the image, file and
 * icon actually deleted.
 */
function apiDeleteImage(req, res, callback) {
    var log = req.log;
    var image = req._image;
    var app = req._app;
    req.log.debug({image: image}, 'DeleteImage: start');

    var forceAllChannels;
    try {
        forceAllChannels = boolFromString(req.query.force_all_channels,
            false, 'force_all_channels');
    } catch (err) {
        return callback(err);
    }

    var actuallyDelete;
    async.series([
        function guardDependentImages(next) {
            // If there are images that use this one as an origin, then we
            // can't delete.
            var filterOpts = { filter: { origin: image.uuid } };
            if (req.channel) {
                filterOpts.filter.channels = [req.channel.name];
            }
            Image.filter(app, filterOpts, log, function (err, depImages) {
                if (err) {
                    return next(err);
                } else if (depImages.length > 0) {
                    var depUuids = depImages.map(
                        function (d) { return d.uuid; });
                    return next(new errors.ImageHasDependentImagesError(
                        image.uuid, depUuids));
                }
                next();
            });
        },
        function decideActuallyDelete(next) {
            /*
             * Decide if we need to actually delete, or just remove from
             * a channel.
             */
            if (req.channel && image.channels.length > 1 && !forceAllChannels) {
                actuallyDelete = false;
            } else {
                actuallyDelete = true;
            }
            next();
        },
        function channelRemove(next) {
            if (actuallyDelete) {
                return next();
            }
            image.channelRemove(req._app, req.channel.name, req.log, next);
        },
        function deleteModel(next) {
            if (!actuallyDelete) {
                return next();
            }
            // Delete the model.
            // Note: We delete the manifest entry first to make sure the entry
            // goes away, if subsequent deletion of files from storage fails,
            // then that is just internally logged for operators to cleanup.
            app.db.del(image.uuid, function (delErr) {
                if (delErr) {
                    return next(delErr);
                }
                app.cacheInvalidateDelete('Image', image);
                next();
            });
        },
        function deleteFiles(next) {
            if (!actuallyDelete) {
                return next();
            }
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
                            'error deleting image file(s), this image may ' +
                            'have zombie files which must be remove ' +
                            'manually by an operator');
                        return next(errors.parseErrorFromStorage(fileErr,
                            'error deleting image file'));
                    }
                    next();
                }
            );
        },
        function deleteIconFile(next) {
            if (!actuallyDelete) {
                return next();
            }
            var icon = image.icon;
            if (icon) {
                var stor = req._app.getStor(icon.stor);
                stor.deleteImageFile(image, 'icon', function (fileErr) {
                    if (fileErr) {
                        log.error({err: fileErr, image: image},
                            'error deleting model icon, this image may ' +
                            'have a zombie icon file which must be ' +
                            'remove manually by an operator');
                    }
                    next();
                });
            } else {
                next();
            }
        },
        function respond(next) {
            res.send(204);
            next();
        }
    ], callback);
}


function apiAddImageAcl(req, res, next) {
    if (req.query.action && req.query.action !== 'add')
        return next();

    req.log.debug({image: req._image}, 'AddImageAcl: start');

    if (req.body === undefined || !Array.isArray(req.body)) {
        return next(new errors.InvalidParameterError(
            format('invalid image "acl" (not an array)'),
            [ { field: 'acl', code: 'Invalid' } ]));
    }

    var uuid;
    for (var i = 0; i < req.body.length; i++) {
        uuid = req.body[i];
        if (!UUID_RE.test(uuid)) {
            return next(new errors.InvalidParameterError(
                format('invalid image "acl" (item %d is not a UUID): %s',
                i, uuid), [ { field: 'acl', code: 'Invalid' } ]));
        }
    }

    req._image.addAcl(req._app, req.body, req.log, function (err) {
        if (err) {
            return next(err);
        }
        var serialized = req._image.serialize(req._app.mode);
        resSetEtag(req, res, serialized);
        res.send(serialized);
        next(false);
    });
}


function apiRemoveImageAcl(req, res, next) {
    if (req.query.action !== 'remove')
        return next();

    req.log.debug({image: req._image}, 'RemoveImageAcl: start');

    if (req.body === undefined || !Array.isArray(req.body)) {
        return next(new errors.InvalidParameterError(
            format('invalid image "acl" (not an array)'),
            [ { field: 'acl', code: 'Invalid' } ]));
    }

    var uuid;
    for (var i = 0; i < req.body.length; i++) {
        uuid = req.body[i];
        if (!UUID_RE.test(uuid)) {
            return next(new errors.InvalidParameterError(
                format('invalid image "acl" (item %d is not a UUID): %s',
                i, uuid), [ { field: 'acl', code: 'Invalid' } ]));
        }
    }

    req._image.removeAcl(req._app, req.body, req.log, function (err) {
        if (err) {
            return next(err);
        }
        var serialized = req._image.serialize(req._app.mode);
        resSetEtag(req, res, serialized);
        res.send(serialized);
        next(false);
    });
}


function apiListImageJobs(req, res, next) {
    req.log.debug({image: req._image}, 'GetImageJobs: start');

    var wfapi = req._app.wfapi;
    if (wfapi.connected !== true) {
        return next(
            new errors.ServiceUnavailableError('Workflow API is down.'));
    }

    wfapi.listImageJobs(req._image.uuid, req.query, function (err, jobs) {
        if (err) {
            return next(err);
        }

        res.send(jobs);
        return next();
    });
}


/**
 * Ensure the 'uuid' request param is valid, else this is a 404.
 */
function reqValidUuid(req, res, next) {
    var uuid = req.params.uuid;
    if (!UUID_RE.test(uuid)) {
        var message = req.url + ' does not exist';
        return next(new errors.ResourceNotFoundError(format('%s', message)));
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
                [ { field: 'account', code: 'Invalid' } ]));
        }
    }

    var uuid = req.params.uuid;
    log.trace({uuid: uuid, account: account}, 'get image');
    Image.get(req._app, uuid, log, function (getErr, image) {
        if (getErr) {
            return next(getErr);
        }
        assert.ok(image);

        if (req.channel && image.channels.indexOf(req.channel.name) === -1) {
            return next(new errors.ResourceNotFoundError(
                'image not found'));
        }
        if (account) {
            // When `?account=$uuid` is used we restrict to images accessible
            // to this account -> 404 if no access.
            var access;
            if (image.owner === account) {
                // User's own image.
                access = true;
            } else if (!image.activated || image.disabled) {
                // Inactive image: can only see others' *active* images.
                log.info({image: image, account: account},
                    'access denied: inactive image owned by someone else');
                access = false;
            } else if (image.public) {
                // Public active image.
                access = true;
            } else if (image.acl && image.acl.indexOf(account) !== -1) {
                // Private active image of which `account` is on the ACL.
                access = true;
            } else {
                log.info({image: image, account: account},
                    'access denied: private image, account not on the ACL');
                access = false;
            }
            if (!access) {
                return next(new errors.ResourceNotFoundError(
                    'image not found'));
            }
        }

        // Don't set it as a header because we don't know which handler is
        // making use of reqGetImage. With res.etag, restify.conditionalRequest
        // will also see the etag.
        var shasum = crypto.createHash('sha1');
        shasum.update(JSON.stringify(image.serialize(req._app.mode)), 'utf8');
        res.etag = shasum.digest('hex');
        req._image = image;
        next();
    });
}



/**
 * If this endpoint was called with '?account=<user-uuid>' (as are all calls
 * from CloudAPI, then ensure that the `account` is the owner of this image
 * (on `req._image`).
 */
function reqEnsureAccountIsImageOwner(req, res, next) {
    assert.object(req._image, 'req._image');
    var account = req.query.account;
    if (!account) {
        next();
    } else if (!UUID_RE.test(account)) {
        return next(new errors.InvalidParameterError(
            format('invalid "account": not a UUID: "%s"', account),
            [ { field: 'account', code: 'Invalid' } ]));
    } else if (account !== req._image.owner) {
        return next(new errors.NotImageOwnerError(account, req._image.uuid));
    } else {
        next();
    }
}


/**
 * Sets the Etag header on the response by calculating the SHA-1 of the image
 */
function resSetEtag(req, res, image) {
    var shasum = crypto.createHash('sha1');
    shasum.update(JSON.stringify(image), 'utf8');
    res.header('Etag', shasum.digest('hex'));
}


/**
 * `req` was paused by a `server.pre` in app.js. We need to
 * resume the stream, but do so *after* we've setup the req
 * event handlers in `restify.bodyParser`. Hence the `nextTick`
 * hack here.
 */
function resume(req, res, next) {
    next();
    process.nextTick(function () {
        req.resume();
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
        channels.reqChannelAllowStar,
        apiListImages);
    server.get(
        {path: '/images/:uuid', name: 'GetImage'},
        reqValidUuid,
        channels.reqChannel,
        reqGetImage,    // add `req._image`, ensure access
        restify.conditionalRequest(),
        apiGetImage);
    server.post(
        {path: '/images', name: 'CreateImage'},
        reqAuth,
        channels.reqChannel,
        resume,
        restify.bodyParser({mapParams: false}),
        apiCreateImage,
        apiCreateImageFromVm,
        apiGetImage);
    server.put(
        {path: '/images/:uuid/file', name: 'AddImageFile'},
        reqAuth,
        reqValidUuid,
        channels.reqChannel,
        reqGetImage,    // add `req._image`, ensure access
        reqEnsureAccountIsImageOwner,
        apiAddImageFile,
        apiAddImageFileFromSource,
        reqGetImage,    // reload the image after a long running function
        finishMoveImageFile);
    server.get(
        {path: '/images/:uuid/file', name: 'GetImageFile'},
        reqValidUuid,
        channels.reqChannel,
        reqGetImage,    // add `req._image`, ensure access
        resGetImageFileCacheHeaders,
        restify.conditionalRequest(),
        apiGetImageFile);
    server.put(
        {path: '/images/:uuid/icon', name: 'AddImageIcon'},
        reqAuth,
        reqValidUuid,
        channels.reqChannel,
        reqGetImage,    // add `req._image`, ensure access
        reqEnsureAccountIsImageOwner,
        apiAddImageIcon,
        reqGetImage,    // reload the image after a long running function
        finishMoveImageIcon);
    server.get(
        {path: '/images/:uuid/icon', name: 'GetImageIcon'},
        reqValidUuid,
        channels.reqChannel,
        reqGetImage,    // add `req._image`, ensure access
        resGetImageIconCacheHeaders,
        restify.conditionalRequest(),
        apiGetImageIcon);
    server.del(
        {path: '/images/:uuid/icon', name: 'DeleteImageIcon'},
        reqAuth,
        reqValidUuid,
        channels.reqChannel,
        reqGetImage,    // add `req._image`, ensure access
        reqEnsureAccountIsImageOwner,
        apiDeleteImageIcon);
    server.post(
        {path: '/images/:uuid', name: 'UpdateImage'},
        reqAuth,
        reqValidUuid,
        channels.reqChannel,
        resume,
        restify.bodyParser({mapParams: false}),
        apiAdminImportRemoteImage, // before `reqGetImage` b/c shouldn't be one
        apiAdminImportImage,       // before `reqGetImage` b/c shouldn't be one
        apiAdminImportImageFromSource,
        reqGetImage,               // add `req._image`, ensure access
        reqEnsureAccountIsImageOwner,
        apiExportImage,
        apiActivateImage,
        apiEnableDisableImage,
        apiChannelAddImage,
        restify.conditionalRequest(),
        apiUpdateImage,
        function invalidUpdateAction(req, res, next) {
            if (req.query.action) {
                next(new errors.InvalidParameterError(
                    format('"%s" is not a valid action', req.query.action),
                    [ { field: 'action', code: 'Invalid' } ]));
            } else {
                next(new errors.InvalidParameterError(
                    'no image "action" was specified',
                    [ { field: 'action', code: 'MissingParameter' } ]));
            }
        });
    server.del(
        {path: '/images/:uuid', name: 'DeleteImage'},
        reqAuth,
        reqValidUuid,
        channels.reqChannel,
        reqGetImage,  // ensure have access to image before deleting
        reqEnsureAccountIsImageOwner,
        apiDeleteImage);
    server.post(
        {path: '/images/:uuid/acl', name: 'AddImageAcl'},
        reqAuth,
        reqValidUuid,
        channels.reqChannel,
        resume,
        restify.bodyParser({mapParams: false}),
        reqGetImage,
        reqEnsureAccountIsImageOwner,
        apiAddImageAcl,
        apiRemoveImageAcl,
        function invalidAclAction(req, res, next) {
            if (req.query.action) {
                next(new errors.InvalidParameterError(
                    format('"%s" is not a valid action', req.query.action),
                    [ { field: 'action', code: 'Invalid' } ]));
            }
        });
    server.get(
        {path: '/images/:uuid/jobs', name: 'GetImageJobs'},
        reqValidUuid,
        channels.reqChannel,
        reqGetImage,    // add `req._image`, ensure access
        apiListImageJobs);
}



//---- exports

module.exports = {
    Image: Image,
    mountApi: mountApi
};
