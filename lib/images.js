/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * IMGAPI model and endpoints for '/images/...'.
 */

var p = console.log;
var util = require('util'),
    format = util.format;
var fs = require('fs');
var crypto = require('crypto');
var url = require('url');
var path = require('path');

var assert = require('assert-plus');
var async = require('async');
var https = require('https');
var imgmanifest = require('imgmanifest');
var lib_uuid = require('uuid');
var once = require('once');
var restify = require('restify');
var sdcClients = require('sdc-clients');
var vasync = require('vasync');

var channels = require('./channels');
var constants = require('./constants');
var docker = require('./docker');
var errors = require('./errors');
var lxd = require('./lxd');
var utils = require('./utils'),
    objCopy = utils.objCopy,
    boolFromString = utils.boolFromString,
    isPositiveInteger = utils.isPositiveInteger,
    validPlatformVersion = utils.validPlatformVersion,
    imgadmVersionFromReq = utils.imgadmVersionFromReq,
    semverGter = utils.semverGter;

// Used for importing remote images
var TMPDIR = '/var/tmp';


//---- globals

var TOP = path.resolve(__dirname, '..');
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var ICON_CONTENT_TYPES = ['image/jpeg', 'image/gif', 'image/png'];

// new images cannot be created from KVM windows origins older than this date
var MIN_AGE_KVM_WIND_IMG = '2018-10-15';

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

    this.raw = Image.validateAndNormalize(app, rawCopy);

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

    /**
     * 'tags' is an object of key/value pairs. However, the 'raw' data
     * stored in the database (Moray or as .raw files) is both of:
     *      raw.tagsObj     The object of key/value pairs.
     *      raw.tags        An array of '$key=$value' strings.
     *                      This field is in the database to
     *                      support searching by tags for the ListImages
     *                      endpoint. If the `value` is a complex object
     *                      (i.e. not a string, number or boolean), then its
     *                      value is not searchable, so the '$value' is dropped.
     * For historical reasons 'tags' has different representation in the
     * database vs. in the API. (Note: If I had it to do over I'd have 'tags'
     * and 'tagsSearchArray' in the database.)
     */
    this.tags = this.raw.tagsObj;

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
 * @param mode {String} Required. Some fields are not shown for some
 *      modes. E.g., the "billing_tags" are not shown in "public" mode.
 * @param acceptVersion {String} The request Accept-Version header. Pass in '*'
 *      to get the serialization for the latest IMGAPI version.
 * @param inclAdminFields {Boolean} If true, then "admin" fields can be
 *      included. E.g. 'files.*.stor'. Optional. Default false.
 */
Image.prototype.serialize = function serialize(mode, acceptVersion,
                                               inclAdminFields) {
    assert.string(mode, 'mode');
    assert.string(acceptVersion, 'acceptVersion');
    assert.optionalBool(inclAdminFields, 'inclAdminFields');

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
            var file = {
                sha1: f.sha1,
                size: f.size,
                compression: f.compression,
                dataset_guid: f.dataset_guid
            };
            if (inclAdminFields) {
                file.stor = f.stor;
            }
            return file;
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

    if (semverGter(acceptVersion, '2.0.0')) {
        if (this.channels) data.channels = this.channels;
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
 * @param pos {Integer} The file position in the files array.
 * @param callback {Function} `function (err)` where `err` is some internal
 *      detail (i.e. it should be wrapped for the user).
 */
Image.prototype.addFile = function addFile(app, file, log, pos, callback) {
    //TODO: perhaps cleaner to pass in the req stream here and have the
    // "where to save it" logic be in here.

    if (typeof (pos) === 'function') {
        callback = pos;
        pos = 0;
    }

    var files = this.files;
    files[pos] = file;
    this.raw.files = files;
    delete this._filesCache;
    Image.modify(app, this, log, callback);
};


/**
 * Move the image file from this, into the given Image instance.
 *
 * @param app {App} The IMGAPI app.
 * @param toImage {Object} The description Image instance.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)` where `err` is some internal
 *      detail (i.e. it should be wrapped for the user).
 */
Image.prototype.moveFileToImage =
function moveFileToImage(app, toImage, log, callback) {
    var files = this.files;
    assert.equal(files.length, 1, 'Expect exactly one image file');
    var file = files[0];
    var self = this;

    var stor = app.getStor(file.stor);
    stor.moveFileBetweenImages(self, toImage, 'file0',
            function _moveFileCb(err) {
        if (err) {
            callback(err);
            return;
        }
        toImage.addFile(app, file, log, function _addFileCb(addErr) {
            if (addErr) {
                callback(addErr);
                return;
            }
            // Null out the file fields.
            self.raw.files = [];
            delete self._filesCache;

            log.debug({fromUuid: self.uuid, toUuid: toImage.uuid},
                'Moving file0 between images');

            Image.modify(app, self, log, callback);
        });
    });
};


/**
 * Copy the image files from this, into the given Image instance.
 *
 * @param app {App} The IMGAPI app.
 * @param toImage {Object} The destination Image instance.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)` where `err` is some internal
 *      detail (i.e. it should be wrapped for the user).
 */
Image.prototype.copyFilesToImage =
function copyFilesToImage(app, toImage, log, callback) {
    assert.object(app, 'app');
    assert.object(toImage, 'toImage');
    assert.object(log, 'log');
    assert.func(callback, 'callback');

    var files = this.files;
    assert.equal(files.length, 1, 'Expect exactly one image file');
    var file = files[0];
    var self = this;

    var stor = app.getStor(file.stor);
    assert.object(stor, 'stor');
    stor.copyFileBetweenImages(self, toImage, 'file0',
            function _copyFileCb(err) {
        if (err) {
            callback(err);
            return;
        }
        // Add the file image metadata.
        toImage.addFile(app, file, log, callback);
    });
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
 * Delete this image.
 *
 * @param app {App} The IMGAPI app.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)` where `err` is okay to
 *      use for an API reponse (i.e. doesn't expose internal details).
 */
Image.prototype.delete = function imageDelete(app, log, callback) {
    assert.object(app, 'app');
    assert.object(log, 'log');
    assert.func(callback, 'callback');

    var self = this;

    vasync.pipeline({funcs: [
        deleteModel,
        deleteFiles,
        deleteIconFile
    ]}, callback);

    // Delete the model.
    // Note: We delete the manifest entry first to make sure the entry
    // goes away, if subsequent deletion of files from storage fails,
    // then that is just internally logged for operators to cleanup.
    function deleteModel(_, next) {
        app.db.del(self.uuid, function (delErr) {
            if (delErr) {
                next(delErr);
                return;
            }
            app.cacheInvalidateDelete('Image', self);
            next();
        });
    }

    function deleteFiles(_, next) {
        // Delete all files.
        async.forEach(
            self.files,
            function deleteOneFile(file, nextFile) {
                var stor = app.getStor(file.stor);
                stor.deleteImageFile(self, nextFile);
            },
            function doneDeletes(fileErr) {
                if (fileErr) {
                    log.error({err: fileErr, image: self},
                        'error deleting image file(s), this image may ' +
                        'have zombie files which must be remove ' +
                        'manually by an operator');
                    next(errors.parseErrorFromStorage(fileErr,
                        'error deleting image file'));
                    return;
                }
                next();
            }
        );
    }

    function deleteIconFile(_, next) {
        if (!self.icon) {
            next();
            return;
        }
        var stor = app.getStor(self.icon.stor);
        stor.deleteImageFile(self, 'icon', function (fileErr) {
            if (fileErr) {
                log.error({err: fileErr, image: self},
                    'error deleting model icon, this image may ' +
                    'have a zombie icon file which must be ' +
                    'removed manually by an operator');
            }
            next();
        });
    }
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
    var manifest = image.serialize(app.mode, '*');
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
    if (!wfapi || wfapi.connected !== true) {
        return cb(new errors.ServiceUnavailableError('Workflow API is down.'));
    }

    var client = new sdcClients.IMGAPI(utils.commonHttpClientOpts({
        url: source,
        log: log
    }, req));
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

                    if (mnfst.state !== 'active') {
                        next(new errors.OriginIsNotActiveError(currentOrigin));
                        return;
                    }

                    // If the image exists in the remote then we add its UUID
                    // to 'origins' and check if it has an origin itself
                    origins.unshift(mnfst.uuid);
                    if (!mnfst.origin) {
                        originExists = true;
                    }
                    currentOrigin = mnfst.origin;
                    subnext();
                });
            }

            // Recursively call getImage until an origin exists locally.
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
                        } else if (mnfst.state !== 'active') {
                            subnext(new errors.OriginIsNotActiveError(
                                currentOrigin));
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

            if (app.config.hasOwnProperty('allowInsecure')) {
                opts.allowInsecure = app.config['allowInsecure'];
            }

            wfapi.createImportRemoteImageJob(opts, function (err2, juuid) {
                if (err2) {
                    return next(err2);
                }
                return next(null, juuid);
            });
        }
    ], function _createImportImageJobWaterfallCb(err, jobUuid) {
        client.close();
        cb(err, jobUuid);
    });
};


/**
 * Validate *raw* image data (i.e. as the data is stored in the database) and
 * normalize some fields (e.g. make a string 'acl' into an array of one
 * element, etc.) *in-place*.
 *
 * @param app {App}
 * @param raw {Object} The raw data for this object.
 * @returns {Object} The raw data for this object, possibly massaged to
 *      normalize field values.
 * @throws {errors.ValidationFailedError} if the raw data is invalid.
 * @throws {errors.InternalError} for other errors.
 */
Image.validateAndNormalize = function validateAndNormalize(app, raw) {
    assert.object(app, 'app');
    assert.object(raw, 'raw');

    /**
     * How this works: We build up a 'manifest' (i.e. the non-raw manifest
     * object) that will be passed to `imgmanifest.validate*()` for validation.
     * We also do some direct checks on the raw data before that. Then
     * throw if we have any `errs`.
     */
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

    // tags (array of 'key=value' tag strings) and tagsObj (the 'tags' object as
    // in the API)
    if (raw.tags) {
        if (!Array.isArray(raw.tags)) {
            errs.push({
                field: 'tags',
                code: 'Invalid',
                message: 'invalid raw image "tags": not an array of strings'
            });
        }
        // TODO: could validate that each is a 'key=[value]'

        /**
         * Before IMGAPI-452 (2015-01-08) there was no `raw.tagsObj`. We
         * do our best to lazily regenerate that from `raw.tags`.
         */
        if (!raw.tagsObj) {
            raw.tagsObj = utils.tagsObjFromSearchArray(raw.tags);
        }
    }
    if (raw.tagsObj) {
        manifest.tags = raw.tagsObj;
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
        raw.tags = utils.tagsSearchArrayFromObj(data.tags);
        raw.tagsObj = data.tags;
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
        raw.uuid = lib_uuid.v4();
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
        type: '!str',
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
    var cacheKey = fields
        .filter(function (f) { return filter[f] !== undefined; })
        .map(function (f) { return [f, filter[f]]; });

    // If limit/marker are passed we append it to our cacheKey
    if (options.limit) {
        cacheKey.push(['limit', options.limit]);
    }
    if (options.marker) {
        cacheKey.push(['marker', options.marker]);
    }
    if (options.sort) {
        cacheKey.push(['sort', options.sort.attribute + '.' +
            options.sort.order]);
    }

    cacheKey = JSON.stringify(cacheKey);

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
                    published_at: rawItems[i].published_at
                });
            } catch (err2) {
                if (err2 instanceof restify.RestError) {
                    log.warn({err2: err2},
                        'Ignoring invalid raw image data (uuid=\'%s\'): %s',
                        rawItems[i].value.uuid, JSON.stringify(err2));
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
 *
 * @param {String} req.query.marker This is an image UUID or a ISO-format
 *      datetime string.
 * ...
 */
function apiListImages(req, res, next) {
    req.log.trace({params: req.params}, 'ListImages entered');

    // For modes other than "dc", the ListImages endpoint only shows
    // "active" images to unauthenticated requests.
    var limitToActive = (req._app.mode !== 'dc' &&
                         req.remoteUser === undefined);

    var limit;
    if (req.query.limit) {
        limit = Number(req.query.limit);
        if (isNaN(limit)) {
            return next(new errors.InvalidParameterError(
                format('invalid limit: "%s"', req.query.limit),
                [ { field: 'state', code: 'Invalid' } ]));
        }
    }
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
        marker: marker,
        inclAdminFields: req.inclAdminFields
    }, 'ListImages query');

    /*
     * Parses `tag.xxx=yyy` from the request params to:
     *      tags = [
     *          ...
     *          'xxx=yyy'
     *      ];
     */
    var tags;
    Object.keys(req.query).forEach(function (key) {
        var matches = key.match(/^tag\.(.*)$/);
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
            // scope:
            owner: query.account,
            // match given filters:
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
                // 2. Public & activated images.
                //    (This is expected to cache well for separate users.)
                filterOpts.push({
                    // scope:
                    public: true,
                    activated: true,  // restrict to activated images
                    // match given filters:
                    state: query.state,
                    disabled: query.disabled,
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
                // 3. Private & activated images for which ACCOUNT is listed
                //    in 'acl'.
                filterOpts.push({
                    // scope:
                    public: false,
                    activated: true,  // restrict to activated images
                    // match given filters:
                    state: query.state,
                    disabled: query.disabled,
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
                // scope:
                owner: query.owner,
                // match given filters:
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
                    // scope:
                    owner: query.owner,
                    public: true,
                    activated: true,
                    // match given filters:
                    disabled: query.disabled,
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
                //    'account' is listed in the 'acl'.
                filterOpts.push({
                    // scope:
                    owner: query.owner,
                    public: false,
                    activated: true,
                    // match given filters:
                    disabled: query.disabled,
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
    var sort = utils.parseSortOptions(req.query);

    // At the moment we only allow sorting by published_at
    if (sort.attribute !== 'published_at') {
        return next(new errors.InvalidParameterError(
            format('invalid \'sort\': not a valid sorting attribute: \'%s\'',
                sort.attribute), [ { field: 'sort', code: 'Invalid' } ]));
    }

    // published_at will be passed when a valid query marker parameter
    // was provided
    function innerFilterImages(published_at) {
        assert.optionalString(published_at, 'published_at');
        var log = req.log;

        async.forEach(filterOpts,
            function filterOne(filterOpt, nextAsync) {
                var opts = { filter: filterOpt };
                if (limit) {
                    opts.limit = limit;
                }
                if (published_at) {
                    opts.marker = published_at;
                }
                opts.sort = sort;

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
                req.log.debug({numHits: uuids.length},
                    'ListImages: doneFiltering');

                // Object to array then sort by whatever sorting was passed.
                // Default sorting is by published_at ASC
                for (var i = 0; i < uuids.length; i++) {
                    data.push(imageByUuid[uuids[i]]);
                }

                function sortImages(a, b) {
                    var prop = sort.attribute;
                    var valueA, valueB;
                    var sortOrder;

                    if (prop === 'published_at') {
                        valueA = (a.published_at === undefined ? 0 :
                            new Date(a.published_at).getTime());
                        valueB = (b.published_at === undefined ? 0 :
                            new Date(b.published_at).getTime());
                    } else {
                        valueA = a.value[prop];
                        valueB = b.value[prop];
                    }

                    if (sort.order === 'ASC' || sort.order === 'asc') {
                        sortOrder = 1;
                    } else {
                        sortOrder = -1;
                    }

                    if (valueA < valueB) {
                        return -1 * sortOrder;
                    } else if (valueA > valueB) {
                        return sortOrder;
                    }
                    return 0;
                }

                data = data.sort(sortImages).map(function (entry) {
                    return entry.value.serialize(req._app.mode,
                        req.getVersion(), req.inclAdminFields);
                });
                if (limit) {
                    data = data.slice(0, limit);
                }
                res.send(data);
                next();
            }
        );
    }

    /*
     * A given `marker` can be a date string for `published_at >= VALUE`
     * comparison, in which case we need to validate and normalize the string.
     * Or it can be an image UUID, in which case we need to lookup the image's
     * published_at. We do the latter without creating an `Image` instance.
     */
    if (marker && UUID_RE.test(marker)) {
        app.db.get(marker, function (err, entry, published_at) {
            if (err) {
                return next(err);
            }
            return innerFilterImages(published_at);
        });
    } else if (marker) {
        var d = new Date(marker);
        if (isNaN(d.getTime())) {
            return next(new errors.InvalidParameterError(
                format('invalid value for "marker" param: %j is not a ' +
                    'UUID or date string', marker),
                [ { field: 'marker', code: 'Invalid' } ]));
        }
        return innerFilterImages(d.toISOString());
    } else {
        return innerFilterImages();
    }
}


function apiGetImage(req, res, next) {
    var serialized = req._image.serialize(req._app.mode, req.getVersion(),
        req.inclAdminFields);
    resSetEtag(req, res, serialized);
    res.send(serialized);
    next();
}


function apiCreateImage(req, res, callback) {
    if (req.query.action !== undefined)
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
    delete data.channels;
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
            var manifest = image.serialize(app.mode, '*');
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

    delete manifest.channels;
    if (req.channel) {
        manifest.channels = [req.channel.name];
    }

    var wfapi = app.wfapi;
    if (wfapi.connected !== true) {
        return callback(
            new errors.ServiceUnavailableError('Workflow API is down.'));
    }

    if (manifest.uuid === undefined) {
        manifest.uuid = lib_uuid.v4();
    }

    var vm;
    var prepareImageScript;
    async.waterfall([
        // Ensure the vm is on a CN with sufficient platform (IMGAPI-298).
        function getVmServer(next) {
            var vmapi = new sdcClients.VMAPI(
                {url: app.config.vmapi.url, log: log});
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

            var cnapi = new sdcClients.CNAPI(
                {url: app.config.cnapi.url, log: log});
            var opts = {headers: {'x-request-id': req.getId()}};
            cnapi.getServer(serverUuid, opts, function (err, server) {
                if (err) {
                    return next(new errors.InternalError(err, format(
                        'could not get server "%s" details', serverUuid)));
                }

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
         * Disallow (at least for now) image creation from docker VMs. Unless
         * verified as sane, I've no idea if docker images will typically be
         * able to cope with lxinit vs dockerinit.
         *
         * Note that *current* cloudapi doesn't expose Docker containers, so
         * there is no way to call cloudapi CreateImageFromMachine with a
         * Docker container.
         */
        function disallowDockerVms(next) {
            if (vm.docker) {
                next(new errors.InvalidParameterError(
                    'cannot create an image from a Docker container',
                    [ { field: 'vm_uuid', code: 'Invalid' } ]));
            } else {
                next();
            }
        },

        /*
         * As a workaround for the not yet implemented
         * `manifest.kernel_version` (IMGAPI-497), we want to inherit
         * `manifest.tags.kernel_version` for LX VMs, otherwise they
         * aren't provisionable.
         */
        function lxInheritTagsKernelVersion(next) {
            if (vm.brand === 'lx' && vm.kernel_version) {
                if (!manifest.tags) {
                    manifest.tags = {};
                }
                manifest.tags.kernel_version = vm.kernel_version;
            }
            next();
        },

        function getPrepareImageScript(next) {
            var protoImageUuid;
            if (['bhyve', 'kvm'].indexOf(vm.brand) !== -1) {
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
                var brand = protoImage.requirements &&
                    protoImage.requirements.brand;
                var published = protoImage.published_at &&
                    protoImage.published_at.toISOString();

                if (brand === 'kvm' && os === 'windows' && published &&
                    published < MIN_AGE_KVM_WIND_IMG) {
                    return next(new errors.NotAvailableError(format(
                        'image creation for OS "windows" is not supported ' +
                        'for KVM images older than %s (VM %s, origin image %s)',
                        MIN_AGE_KVM_WIND_IMG, vm.uuid, protoImageUuid)));
                }

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
            var mnfst = image.serialize(app.mode, '*');
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
    var originImage;

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

    delete data.channels;
    if (req.channel) {
        data.channels = [req.channel.name];
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
                    originImage = origin;
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
                if (data.owner === constants.UNSET_OWNER_UUID) {
                    data.owner = app.config.adminUuid;
                    return next();
                }
            } else {
                data.owner = constants.UNSET_OWNER_UUID;
            }

            if (skipOwnerCheck) {
                return next();
            }
            utils.checkOwnerExists({
                app: app,
                owner: data.owner
            }, next);
        },
        /*
         * IMGAPI-651: 'imgadm publish' for *lx-dataset* images must inherit
         * min_platform setting (or remove the min_platform setting if there
         * is no origin image) when imgadm < v3.7.4.
         */
        function workaroundImgapi651(next) {
            var imgadmVer = imgadmVersionFromReq(req);
            if (data.type === 'lx-dataset' &&
                    data.requirements &&
                    data.requirements.min_platform &&
                    imgadmVer &&
                    !semverGter(imgadmVer, '3.7.4')) {
                if (originImage && originImage.requirements &&
                        originImage.requirements.min_platform) {
                    log.info({
                            origin: originImage.uuid,
                            old_min_platform: data.requirements.min_platform,
                            new_min_platform:
                                originImage.requirements.min_platform
                        },
                        'inherit min_platform from lx origin image ' +
                        '(IMGAPI-651)');
                    data.requirements.min_platform =
                        objCopy(originImage.requirements.min_platform);
                } else {
                    log.info({min_platform: data.requirements.min_platform},
                        'removing min_platform for lx image (IMGAPI-651)');
                    delete data.requirements.min_platform;
                }
            }
            next();
        },
        function createIt(next) {
            log.info({data: data}, 'AdminImportImage: create it');
            Image.create(app, data, true, false, next);
        },
        function addItToArchive(image, next) {
            var local = app.storage.local;
            var manifest = image.serialize(app.mode, '*');
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
                Image.modify(app, image, req.log, function (err) {
                    if (err) {
                        log.error({uuid: image.uuid},
                            'error saving to database: raw data:', image.raw);
                        return next(err);
                    }
                    res.send(image.serialize(req._app.mode, req.getVersion()));
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
                    var serialized = image.serialize(req._app.mode,
                            req.getVersion());
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
            var client = new sdcClients.IMGAPI(utils.commonHttpClientOpts({
                url: source,
                log: log
            }, req));
            client.getImage(uuid, function (err, manifest_) {
                if (err) {
                    log.error(err, 'failed to get manifest for image %s',
                        uuid);
                    client.close();
                    return next(new errors.RemoteSourceError(format('Unable ' +
                        'to get manifest for image %s. Error from remote: %s',
                        uuid, err.message || err.code)));
                }
                manifest = manifest_;
                assert.ok(manifest.uuid, 'no uuid on image manifest: ' +
                    JSON.stringify(manifest));
                client.close();
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
                if (manifest.owner === constants.UNSET_OWNER_UUID) {
                    manifest.owner = app.config.adminUuid;
                    return next();
                }
            } else {
                manifest.owner = constants.UNSET_OWNER_UUID;
            }

            if (skipOwnerCheck) {
                return next();
            }
            utils.checkOwnerExists({
                app: app,
                owner: manifest.owner
            }, next);
        },

        function handleChannels(_, next) {
            delete manifest.channels;
            if (req.channel) {
                manifest.channels = [req.channel.name];
            }
            next();
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
            serialized = newImage.serialize(app.mode, '*');
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


/**
 * Allow a user (or admin) to import an image that resides in another
 * datacenter within the same cloud (e.g. an image that resides in a
 * different JPC region, such as importing from us-west-1 into us-sw-1).
 *
 * This creates and returns a workflow 'import-remote-image' job.
 */
function apiImportImageFromDatacenter(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.log, 'req.log');
    assert.object(req.params, 'req.params');
    assert.object(req.query, 'req.query');
    assert.object(res, 'res');
    assert.func(next, 'next');

    if (req.query.action !== 'import-from-datacenter') {
        return next();
    }

    var account = req.query.account;
    var app = req._app;
    var client;
    var datacenter = req.query.datacenter;
    var errs;
    var log = req.log;
    var otherXdcNames;
    var source;
    var uuid = req.params.uuid;

    if (!UUID_RE.test(uuid)) {
        errs = [ { field: 'uuid', code: 'Invalid' } ];
        next(new errors.ValidationFailedError(
            format('invalid image "uuid" (not a UUID): %s', uuid), errs));
        return;
    }

    if (!account || !UUID_RE.test(account)) {
        errs = [ { field: 'account', code: 'Invalid' } ];
        next(new errors.ValidationFailedError(
            format('invalid image "account" (not a UUID): %s', account), errs));
        return;
    }

    if (datacenter === undefined) {
        errs = [ { field: 'datacenter', code: 'MissingParameter' } ];
        next(new errors.ValidationFailedError('missing datacenter parameter',
            errs));
        return;
    }

    if (!app.config.imgapiUrlFromDatacenter ||
            !app.config.imgapiUrlFromDatacenter.hasOwnProperty(datacenter)) {
        errs = [ { field: 'datacenter', code: 'Invalid' } ];
        otherXdcNames = utils.getOtherXdcNames(app);
        next(new errors.ValidationFailedError(format(
            'datacenter "%s" is not supported, valid datacenters names are: %s',
            datacenter, otherXdcNames.join(', ')), errs));
        return;
    }

    if (datacenter === app.config.datacenterName) {
        errs = [ { field: 'datacenter', code: 'Invalid' } ];
        otherXdcNames = utils.getOtherXdcNames(app);
        next(new errors.ValidationFailedError(format(
            'cannot import into the same datacenter, valid datacenters names ' +
            'are: %s', otherXdcNames.join(', ')), errs));
        return;
    }

    source = app.config.imgapiUrlFromDatacenter[datacenter];
    assert.string(source, 'source');

    vasync.pipeline({ arg: {}, funcs: [
        function checkImageExistsInRemoteDc(ctx, cb) {
            log.debug({uuid: uuid},
                'ImportDcImage: ensure image exists in remote DC');
            client = new sdcClients.IMGAPI(utils.commonHttpClientOpts({
                url: source,
                log: log
            }, req));
            client.getImage(uuid, account, function (err, img) {
                if (err) {
                    cb(err);
                    return;
                }

                // Make sure the image is active.
                if (img.state !== 'active') {
                    cb(new errors.ValidationFailedError(format(
                        'Cannot import image %s - image is not active.',
                        uuid)));
                    return;
                }

                // A user cannot any image that they are not the owner of.
                if (img.owner !== account) {
                    cb(new errors.UnauthorizedError(format(
                        'Cannot import image %s - you are not the owner.',
                        uuid)));
                    return;
                }

                ctx.image = img;
                cb();
            });
        },

        // Note that this function is deliberately after
        // checkImageExistsInRemoteDc, as this function is essentially an admin
        // lookup to see if the image exists, which if used before
        // checkImageExistsInRemoteDc could then be used to
        // determine if an image existed in this DC (even though you may not
        // have the permissions to access it).
        function checkIfImageExistsLocally(_, cb) {
            log.debug({uuid: uuid},
                'ImportDcImage: check if image already exists locally');
            Image.get(app, uuid, log, function (err, img) {
                if (!err) {
                    assert.object(img, 'img');
                    cb(new errors.ImageUuidAlreadyExistsError(uuid));
                    return;
                } else if (err.restCode !== 'ResourceNotFound') {
                    cb(err);
                    return;
                }
                cb();
            });
        },

        // Find and validate each of the origin images:
        // 1. must be activated or disabled (disabled means cannot provision)
        // 2. must be owned by the given account (or admin, see 3)
        // 3. admin owned images must already exist locally - as they cannot
        //    be copied between DCs
        function lookupOriginImages(ctx, cb) {
            // The images to copy, starting from the base.
            if (!ctx.image.origin) {
                cb();
                return;
            }

            var maxOriginCount = 100;
            var originImages = [];

            function validateOneOriginImage(currentOrigin, subnext) {
                client.getImage(currentOrigin, account,
                        function _originGetImageCb(err, img) {
                    if (err) {
                        subnext(err);
                        return;
                    }

                    // Stop when an admin image is found - must check that the
                    // same admin image exists in the local DC.
                    if (img.owner !== account) {
                        log.debug({uuid: uuid}, 'ImportDcImage: origin has a ' +
                            'different owner - check origin exists locally');
                        Image.get(app, currentOrigin, log,
                                function (err2) {
                            if (err2) {
                                if (err2.restCode === 'ResourceNotFound') {
                                    subnext(new errors.ResourceNotFoundError(
                                        format(
                                            'Unable to import - origin ' +
                                            'image %s must already exist in ' +
                                            'the datacenter (as this image ' +
                                            'is not owned by you).',
                                            currentOrigin
                                        )));
                                    return;
                                }
                                subnext(err2);
                                return;
                            }
                            subnext();
                        });
                        return;
                    }

                    originImages.push(img);
                    // Follow the origin chain.
                    if (img.origin) {
                        if (originImages.length >= maxOriginCount) {
                            subnext(new errors.InternalError(format(
                                'Origin chain too long, exceeds %d images',
                                maxOriginCount)));
                            return;
                        }
                        validateOneOriginImage(img.origin, subnext);
                        return;
                    }
                    subnext();
                });
            }

            validateOneOriginImage(ctx.image.origin, cb);
        },

        function doImportFromDc(_, cb) {
            var skipOwnerCheck = false;
            log.debug({datacenter: datacenter, uuid: uuid, source: source},
                'ImportDcImage: start import');
            Image.createImportImageJob(req, uuid, source, skipOwnerCheck, log,
                    function _createImportImageJobCb(err, jobUuid) {
                if (err) {
                    cb(err);
                    return;
                }

                // Allow clients to know where is wfapi located
                res.header('workflow-api', app.config.wfapi.url);
                res.send({ image_uuid: uuid, job_uuid: jobUuid });
                cb();
            });
        }

    ]}, function _importFromDcPipelineCb(err) {
        if (client) {
            client.close();
        }
        next(err || false);
    });
}


function apiAdminImportDockerImage(req, res, next) {
    if (req.query.action !== 'import-docker-image') {
        return next();
    }

    docker.adminImportDockerImage({Image: Image, req: req, res: res}, next);
}


function apiAdminPushDockerImage(req, res, next) {
    docker.adminPushDockerImage({Image: Image, req: req, res: res}, next);
}


function apiAdminImportLxdImage(req, res, next) {
    if (req.query.action !== 'import-lxd-image') {
        return next();
    }

    lxd.adminImportLxdImage({Image: Image, req: req, res: res}, next);
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
    } else if (constants.VALID_FILE_COMPRESSIONS.indexOf(compression) === -1) {
        return next(new errors.InvalidParameterError(
            format('invalid compression "%s" (must be one of %s)',
                compression, constants.VALID_FILE_COMPRESSIONS.join(', ')),
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
        if (constants.VALID_STORAGES.indexOf(preferredStorage) === -1) {
            return next(new errors.InvalidParameterError(
                format('invalid storage "%s" (must be one of %s)',
                    preferredStorage, constants.VALID_STORAGES.join(', ')),
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
        if (size === 0) {
            return next(new errors.DownloadError(
                'image file size is 0 bytes, empty files are not allowed'));
        }
        if (size > constants.MAX_IMAGE_SIZE) {
            return next(new errors.DownloadError(format(
                'image file size, %s, exceeds the maximum allowed file ' +
                'size, %s', size, constants.MAX_IMAGE_SIZE_STR)));
        }
        if (contentLength && size !== contentLength) {
            return next(new errors.DownloadError(format(
                '"Content-Length" header, %s, does not match uploaded ' +
                'size, %d', contentLength, size)));
        }

        sha1 = shasum.digest('hex');
        if (sha1Param && sha1Param !== sha1) {
            return next(new errors.DownloadError(format(
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

    if (contentLength !== undefined &&
        contentLength > constants.MAX_IMAGE_SIZE) {

        finish(new errors.UploadError(format(
            'image file size %s (from Content-Length) exceeds the maximum ' +
            'allowed size, %s', contentLength, constants.MAX_IMAGE_SIZE_STR)));
    }

    size = 0;
    var shasum = crypto.createHash('sha1');
    var md5sum = crypto.createHash('md5');
    req.on('data', function (chunk) {
        size += chunk.length;
        if (size > constants.MAX_IMAGE_SIZE) {
            finish(new errors.UploadError(format(
                'image file size exceeds the maximum allowed size, %s',
                constants.MAX_IMAGE_SIZE_STR)));
        }
        shasum.update(chunk);
        md5sum.update(chunk);
    });
    req.on('end', function () {
        req.log.trace('req "end" event');
    });
    req.on('close', function () {
        req.log.trace('req "close" event');
    });

    stor = req._app.chooseStor(req._image, preferredStorage);
    stor.storeFileFromStream({
        image: req._image,
        stream: req,
        reqId: req.id(),
        filename: 'file0'
    }, function (sErr, tmpFilename, filename) {
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
        if (constants.VALID_STORAGES.indexOf(preferredStorage) === -1) {
            return next(new errors.InvalidParameterError(
                format('invalid storage "%s" (must be one of %s)',
                    preferredStorage, constants.VALID_STORAGES.join(', ')),
                [ { field: 'storage', code: 'Invalid' } ]));
        }
    }

    var uuid = req.params.uuid;
    var client = new sdcClients.IMGAPI(utils.commonHttpClientOpts({
        url: req.query.source,
        log: req.log
    }, req));

    // Next handler that closes the IMGAPI client before running callback.
    // TODO: Maybe better to move these calls into a vasync chain.
    var _next = next;
    function closeClientAndCallNext(err) {
        client.close();
        _next(err);
    }
    next = closeClientAndCallNext;

    // Get the image so we can get the manifest file details.
    client.getImage(uuid, addImageFileFromImgapiSource);

    function addImageFileFromImgapiSource(err, manifest) {
        if (err) {
            req.log.error(err, 'apiAddImageFile: failed to get image %s',
                uuid);
            next(new errors.RemoteSourceError(format('Unable ' +
                'to get manifest for image %s. Error from remote: %s',
                uuid, err.message || err.code)));
            return;
        }

        var compression = manifest.files[0].compression;
        var sha1Param = manifest.files[0].sha1;
        var contentLength = manifest.files[0].size;
        var size = 0;
        var sha1, stor;

        client.getImageFileStream(uuid, pipeStream);
        function pipeStream(fileErr, stream) {
            if (fileErr) {
                req.log.error(fileErr, 'failed to get stream for image file %s',
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
                if (size > constants.MAX_IMAGE_SIZE) {
                    return next(new errors.DownloadError(format(
                        'image file size, %s, exceeds the maximum allowed ' +
                        'file size, %s', size, constants.MAX_IMAGE_SIZE_STR)));
                }
                if (contentLength && size !== contentLength) {
                    return next(new errors.DownloadError(format(
                        '"Content-Length" header, %s, does not match ' +
                        'downloaded size, %d', contentLength, size)));
                }

                sha1 = shasum.digest('hex');
                if (sha1Param && sha1Param !== sha1) {
                    return next(new errors.DownloadError(format(
                        '"sha1" file field, %s, does not match the ' +
                        'downloaded file sha1 hash, %s', sha1Param, sha1)));
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
                if (size > constants.MAX_IMAGE_SIZE) {
                    finish(new errors.DownloadError(format(
                        'image file size exceeds the maximum allowed size, %s',
                        constants.MAX_IMAGE_SIZE_STR)));
                }
                shasum.update(chunk);
                md5sum.update(chunk);
            });
            stream.on('end', function () {
                req.log.trace('req "end" event');
            });
            stream.on('close', function () {
                req.log.trace('req "close" event');
            });

            stor = req._app.chooseStor(req._image, preferredStorage);
            stor.storeFileFromStream({
                image: req._image,
                stream: stream,
                reqId: stream.id(),
                filename: 'file0'
            }, function (sErr, tmpFilename, filename) {
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


function apiAddImageFileFromUrl(req, res, next) {

    req.log.debug({image: req._image}, 'apiAddImageFileFromUrl: start');

    // Can't change files on an activated image.
    if (req._image.activated) {
        return next(new errors.ImageFilesImmutableError(req._image.uuid));
    }

    var sha1, expectedSha1;
    if (req.query.sha1) {
        expectedSha1 = req.query.sha1;
    }
    var compression = req.query.compression;

    if (!compression) {
        return next(new errors.InvalidParameterError('missing "compression"',
            [ { field: 'compression', code: 'Missing' } ]));
    } else if (constants.VALID_FILE_COMPRESSIONS.indexOf(compression) === -1) {
        return next(new errors.InvalidParameterError(
            format('invalid compression "%s" (must be one of %s)',
                compression, constants.VALID_FILE_COMPRESSIONS.join(', ')),
            [ { field: 'compression', code: 'Invalid' } ]));
    }

    var fileUrl = req.body.file_url;
    if (fileUrl === undefined) {
        return next(new errors.InvalidParameterError(
            'missing "file_url" field from request body',
            [ {field: 'file_url', code: 'Missing'} ]));
    }

    if (fileUrl.indexOf('https:') !== 0) {
        return next(new errors.InvalidParameterError(
            'Only URLs using the https: scheme are supported',
            [ {field: 'file_url', code: 'Invalid'} ]));
    }

    /*
     * Node's default HTTP timeout is two minutes, and this request can take
     * longer than that to complete.  Set this connection's timeout to an hour
     * to avoid an abrupt close after two minutes.
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
        if (constants.VALID_STORAGES.indexOf(preferredStorage) === -1) {
            return next(new errors.InvalidParameterError(
                format('invalid storage "%s" (must be one of %s)',
                    preferredStorage, constants.VALID_STORAGES.join(', ')),
                [ { field: 'storage', code: 'Invalid' } ]));
        }
    }

    var size = 0;
    var stor;  // the storage class
    function finish_(err, tmpFilename, filename) {
        if (err) {
            req.log.info('Error during image file addition', err);
            return next(err);
        }

        if (size === 0) {
            return next(new errors.DownloadError(
                'image file size is 0 bytes, empty files are not allowed'));
        }
        if (size > constants.MAX_IMAGE_SIZE) {
            return next(new errors.DownloadError(format(
                'image file size, %s, exceeds the maximum allowed file ' +
                'size, %s', size, constants.MAX_IMAGE_SIZE_STR)));
        }

        sha1 = shasum.digest('hex');
        if (expectedSha1 && expectedSha1 !== sha1) {
            return next(new errors.DownloadError(format(
                'expected sha1 hash, %s, does not match the uploaded ' +
                'file sha1 hash, %s', expectedSha1, sha1)));
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

    size = 0;
    var shasum = crypto.createHash('sha1');
    var md5sum = crypto.createHash('md5');
    // Add a user-agent header. For for node 4.x, that means parsing the URL
    // and adding its constituents to an options object since we can't pass
    // the URL and then add additional options to the request.
    var parsedUrl = url.parse(fileUrl);
    var getOptions = {
        headers: {
            'User-Agent': req._app.serverName
        },
        hostname: parsedUrl.hostname,
        path: parsedUrl.path,
        port: parsedUrl.port,
        protocol: parsedUrl.protocol
    };

    https.get(getOptions, function getRemoteImageFile(response) {

        // stor.storeFileFromStream requires a paused stream
        response.pause();

        // Limitation: we don't support HTTP 30x redirects yet.
        if (response.statusCode !== 200) {
            return next(new errors.DownloadError(
                format(
                    'HTTP %s error attempting to download image',
                    response.statusCode)));
        }

        response.on('data', function (chunk) {
            size += chunk.length;
            if (size > constants.MAX_IMAGE_SIZE) {
                finish(new errors.UploadError(format(
                    'image file size exceeds the maximum allowed size, %s',
                    constants.MAX_IMAGE_SIZE_STR)));
            }
            shasum.update(chunk);
            md5sum.update(chunk);
        });
        response.on('end', function () {
            req.log.trace('req "end" event');
        });
        response.on('close', function () {
            req.log.trace('req "close" event');
        });

        stor = req._app.chooseStor(req._image, preferredStorage);
        stor.storeFileFromStream({
            image: req._image,
            stream: response,
            reqId: req.id(),
            filename: 'file0'
        }, function (sErr, tmpFilename, filename) {
            if (sErr) {
                req.log.error(sErr, 'error storing image file');
                finish(errors.parseErrorFromStorage(
                    sErr, 'error receiving image file'));
            } else {
                finish(null, tmpFilename, filename);
            }
        });
    }).on('error', function (e) {
        return next(new errors.DownloadError(
            'Error getting image: ' + e));
    });
}


/**
 * Complete the AddImageFile[FromSource] endpoint by moving the image file
 * into its final (non-tmp) place, if a tmp storage location was used.
 */
function finishMoveImageFile(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.file, 'req.file');
    assert.object(req._image, 'req._image');
    assert.string(req.storage, 'req.storage');
    assert.object(res, 'res');
    assert.func(next, 'next');

    req.log.debug({uuid: req._image.uuid}, 'finishMoveImageFile: start');

    if (req._image.activated) {
        return next(new errors.ImageAlreadyActivatedError(req._image.uuid));
    }

    vasync.pipeline({ funcs: [
        function doMoveImageFile(_, cb) {
            var stor = req._app.getStor(req.storage);
            assert.object(stor, 'stor');
            if (req.tmpFilename) {
                assert.string(req.filename, 'req.filename');
                assert.string(req.tmpFilename, 'req.tmpFilename');
                stor.moveImageFile(req._image, req.tmpFilename, req.filename,
                    cb);
            } else {
                // File is already in its final `req.filename` location.
                cb();
            }
        },
        function addImageFileDetails(_, cb) {
            req._image.addFile(req._app, req.file, req.log, function (err) {
                if (err) {
                    req.log.error(err, 'error adding file info to Image');
                    cb(new errors.InternalError(err, 'could not save image'));
                    return;
                }
                cb();
            });
        }

    ]}, function _onFinishMoveImageFileCb(err) {
        if (err) {
            next(err);
            return;
        }

        req.log.debug({uuid: req._image.uuid}, 'finishMoveImageFile: success');

        var serialized = req._image.serialize(req._app.mode, req.getVersion());
        resSetEtag(req, res, serialized);
        res.send(serialized);
        next();
    });
}


/**
 * Set file cache-related headers for GetImageFile before the
 * `conditionalRequest` middleware is run.
 */
function resSetImageFileCacheHeaders(req, res, next) {
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
    stor.createImageFileReadStream(req._image, 'file0', {},
            function (sErr, stream) {
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
        stream.resume();
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
        if (constants.VALID_STORAGES.indexOf(preferredStorage) === -1) {
            return next(new errors.InvalidParameterError(
                format('invalid storage "%s" (must be one of %s)',
                    preferredStorage, constants.VALID_STORAGES.join(', ')),
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
        if (size > constants.MAX_ICON_SIZE) {
            return next(new errors.UploadError(format(
                'icon size, %s, exceeds the maximum allowed file ' +
                'size, %s', size, constants.MAX_ICON_SIZE_STR)));
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

    if (contentLength !== undefined &&
        contentLength > constants.MAX_ICON_SIZE) {

        finish(new errors.UploadError(format(
            'icon size %s (from Content-Length) exceeds the maximum allowed ' +
            'size, %s', contentLength, constants.MAX_ICON_SIZE_STR)));
    }

    size = 0;
    var shasum = crypto.createHash('sha1');
    var md5sum = crypto.createHash('md5');
    req.on('data', function (chunk) {
        size += chunk.length;
        if (size > constants.MAX_ICON_SIZE) {
            finish(new errors.UploadError(format(
                'icon size exceeds the maximum allowed size, %s',
                constants.MAX_ICON_SIZE_STR)));
        }
        shasum.update(chunk);
        md5sum.update(chunk);
    });
    req.on('end', function () {
        req.log.trace('req "end" event');
    });
    req.on('close', function () {
        req.log.trace('req "close" event');
    });

    stor = req._app.chooseStor(req._image, preferredStorage);
    stor.storeFileFromStream({
        image: req._image,
        stream: req,
        reqId: req.id(),
        filename: 'icon'
    }, function (sErr, tmpFilename, filename) {
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
 * into its final (non-tmp) place, if a tmpFilename was used.
 */
function finishMoveImageIcon(req, res, next) {
    req.log.debug({image: req._image}, 'MoveImageIcon: start');


    vasync.pipeline({
        funcs: [
            function doMoveImageFileIfNecessary(_, cb) {
                if (!req.tmpFilename) {
                    cb();
                    return;
                }

                var stor = req._app.getStor(req.storage);
                stor.moveImageFile(req._image, req.tmpFilename, req.filename,
                    cb);
            },

            function addToImageObjectAndRespond(_, cb) {
                req._image.addIcon(req._app, req.icon, req.log, function (err) {
                    if (err) {
                        req.log.error(err, 'error setting icon=true to Image');
                        cb(new errors.InternalError(err,
                            'could not save icon data'));
                        return;
                    }

                    var serialized = req._image.serialize(req._app.mode,
                            req.getVersion());
                    resSetEtag(req, res, serialized);
                    res.send(serialized);
                    cb();
                });
            }
        ]
    }, function finish(err) {
        next(err);
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

            var serialized = req._image.serialize(req._app.mode,
                    req.getVersion());
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
function resSetImageIconCacheHeaders(req, res, next) {
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
    stor.createImageFileReadStream(req._image, 'icon', {},
            function (sErr, stream) {
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
        stream.resume();
    });
}


/**
 * An admin-only endpoint to change the storage for the image file.
 *
 * E.g.: Change the storage for image $uuid to "manta":
 *
 *      POST /images/$uuid?action=change-stor&stor=manta
 */
function apiAdminChangeImageStor(req, res, cb) {
    if (req.query.action !== 'change-stor')
        return cb();

    var image = req._image;
    var app = req._app;
    var log = req.log;

    if (req.query.account) {
        return cb(new errors.OperatorOnlyError());
    }
    if (!req.query.stor) {
        cb(new errors.ValidationFailedError(
            'missing "stor" query parameter',
            [ { field: 'stor', code: 'MissingParameter' } ]));
        return;
    }
    var newStor = app.getStor(req.query.stor);
    if (newStor === undefined) {
        cb(new errors.ValidationFailedError(
            'unknown storage type "' + req.query.stor + '"',
            [ { field: 'stor', code: 'Invalid' } ]));
        return;
    }

    if (image.icon) {
        cb(new errors.NotImplementedError(
            'cannot change stor for images with an icon'));
        return;
    }

    /*
     * Node's default HTTP timeout is two minutes, and this request can take
     * longer than that to complete.  Set this connection's timeout to an hour
     * to avoid an abrupt close after two minutes.
     */
    req.connection.setTimeout(60 * 60 * 1000);

    var curStor = app.getStor(image.files[0].stor);
    var needToChange = (newStor.type !== curStor.type);

    vasync.pipeline({arg: {}, funcs: [
        function copyIt(ctx, next) {
            if (!needToChange) {
                next();
                return;
            }
            log.trace('AdminChangeImageStor: copyIt');

            curStor.createImageFileReadStream(image, 'file0', {},
                    function (rErr, rStream) {
                if (rErr) {
                    next(rErr);
                    return;
                }

                newStor.storeFileFromStream({
                    image: image,
                    stream: rStream,
                    reqId: req.id(),
                    filename: 'file0',
                    type: 'application/octet-stream',
                    contentMD5: image.files[0].contentMD5,
                    size: image.files[0].size
                }, function (wErr, tmpFilename, filename) {
                    if (wErr) {
                        next(errors.parseErrorFromStorage(
                            wErr, 'error moving image file'));
                    } else {
                        ctx.tmpFilename = tmpFilename;
                        ctx.filename = filename;
                        next();
                    }
                });
            });
        },

        function moveToFinalIfNecessary(ctx, next) {
            if (!needToChange || !ctx.tmpFileName) {
                next();
                return;
            }

            log.trace('AdminChangeImageStor: moveToFinal');
            newStor.moveImageFile(image, ctx.tmpFilename, ctx.filename, next);
        },

        function updateManifest(_, next) {
            if (!needToChange) {
                next();
                return;
            }

            log.trace('AdminChangeImageStor: updateManifest');
            image.files[0].stor = newStor.type;
            image.raw.files[0].stor = newStor.type;
            app.db.modify(image.uuid, image.raw, function (modErr) {
                if (modErr) {
                    return next(new errors.InternalError(modErr,
                        'could not save updated manifest'));
                }
                app.cacheInvalidateWrite('Image', image);
                next();
            });
        },

        function delOldStorFile(_, next) {
            if (!needToChange) {
                next();
                return;
            }
            log.trace('AdminChangeImageStor: delOldStorFile');

            curStor.deleteImageFile(image, 'file0', next);
        }

    ]}, function (err) {
        if (err) {
            return cb(err);
        }

        // Respond.
        var serialized = image.serialize(app.mode, '*', /* admin= */ true);
        res.send(serialized);
        cb(false);
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
        'xz': '.xz',
        'none': ''
    }[file.compression || 'none'];

    var account = req.query.account;
    // account is given:
    //      Call from CloudAPI, account must be the same as the manta user
    // TODO: with RBAC v2 work this should be a check with secapi that the
    //      account can write to that area.
    if (account) {
        app.ufdsClient.getUserEx({
            searchType: 'uuid',
            value: account
        }, function (err, user) {
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
    //      This is a call by the admin user. IMGAPI places *no guard* on
    //      where in Manta it will export.
    } else {
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
                var string = JSON.stringify(
                        image.serialize(app.mode, req.getVersion()), null, 4);

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
            function exportFile(next) {
                stor.exportImageFile(image, fileStorPath, function (err) {
                    if (err) {
                        next(errors.parseErrorFromStorage(
                            err, 'error exporting image file'));
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
                'manta_url': app.config.manta.url,
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
        var serialized = req._image.serialize(req._app.mode, req.getVersion());
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
        var serialized = req._image.serialize(req._app.mode, req.getVersion());
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
        var serialized = req._image.serialize(req._app.mode, req.getVersion());
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

    var app = req._app;
    var image;

    vasync.pipeline({arg: {}, funcs: [
        function validateFields(ctx, next) {
            var ADMIN_ONLY_ATTRS = [
                'state',
                'error',
                'billing_tags',
                'traits',
                'files',   // Restricted to digest and uncompressedDigest.
                'origin',  // Restricted to unactivated images.
                'uuid'     // Restricted to unactivated images.
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
                } else if ((key === 'uuid' || key === 'origin' ||
                        key === 'files') && data[key] !== undefined) {
                    // These fields are a special case (used by docker build),
                    // and it requires that the image be unactivated.
                    if (req._image.activated) {
                        errs.push({
                            field: key,
                            code: 'NotAllowed',
                            message: 'Can only be updated on unactivated images'
                        });
                    } else if (key === 'files') {
                        // Only allow changes to digest and uncompressedDigest.
                        Object.keys(data.files[0]).forEach(function (fKey) {
                            var file0 = req._image.files[0];
                            if (fKey === 'digest') {
                                return;
                            } else if (fKey === 'uncompressedDigest') {
                                return;
                            } else if (data.files[0][fKey] !== file0[fKey]) {
                                errs.push({
                                    field: key,
                                    code: 'NotAllowed',
                                    message: 'Can only update "digest" or '
                                        + '"uncompressedDigest" fields on files'
                                });
                            }
                        });
                    }
                }
            }

            if (errs.length) {
                var fields = errs.map(function (e) { return e.field; });
                return next(new errors.ValidationFailedError(
                    'invalid image update data: ' + fields.join(', '), errs));
            }

            // Convert from the API 'tags' to raw data 'tagsObj' and 'tags'.
            if (data.tags) {
                data.tagsObj = data.tags;
                data.tags = utils.tagsSearchArrayFromObj(data.tags);
                dataKeys = Object.keys(data);
            }

            // Merge new values into existing raw data.
            var raw = objCopy(req._image.raw);
            for (i = 0; i < dataKeys.length; i++) {
                key = dataKeys[i];
                if (key === 'files') {
                    // Special handling for files, to only allow updating of
                    // the digest and uncompressedDigest fields, whilst leaving
                    // the other file attributes unchanged.
                    if (data['files'] && data['files'][0]) {
                        if (data['files'][0].digest) {
                            raw['files'][0].digest = data['files'][0].digest;
                        }
                        if (data['files'][0].uncompressedDigest) {
                            raw['files'][0].uncompressedDigest =
                                data['files'][0].uncompressedDigest;
                        }
                    }
                } else if (data[key] === null) {
                    delete raw[key];
                } else {
                    raw[key] = data[key];
                }
            }

            // Revalidate.
            try {
                image = new Image(app, raw);
            } catch (cErr) {
                return next(cErr);
            }

            ctx.uuidChanged = (req._image.uuid !== image.uuid);
            next();
        },

        function checkOwner(_, next) {
            utils.checkOwnerExists({
                app: app,
                owner: image.owner
            }, next);
        },

        function doMoveImageFile(ctx, next) {
            if (!ctx.uuidChanged) {
                next();
                return;
            }
            req._image.moveFileToImage(app, image, req.log, next);
        },

        function doModify(_, next) {
            Image.modify(app, image, req.log, next);
        },

        function deleteOldImage(ctx, next) {
            if (!ctx.uuidChanged) {
                next();
                return;
            }
            // Delete the original model.
            app.db.del(req._image.uuid, function (delErr) {
                if (delErr) {
                    return next(delErr);
                }
                app.cacheInvalidateDelete('Image', req._image);
                next();
            });
        }

    ]}, function (err) {
        if (err) {
            return cb(err);
        }

        // Respond.
        var serialized = image.serialize(app.mode, req.getVersion());
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
                        function (d) { return d.value.uuid; });
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
        function chanRemove(next) {
            if (actuallyDelete) {
                return next();
            }
            image.channelRemove(req._app, req.channel.name, req.log, next);
        },
        function deleteImage(next) {
            if (!actuallyDelete) {
                return next();
            }
            image.delete(req._app, req.log, next);
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
        var serialized = req._image.serialize(req._app.mode, req.getVersion());
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
        var serialized = req._image.serialize(req._app.mode, req.getVersion());
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


function apiCloneImage(req, res, next) {
    assert.object(req, 'req');
    assert.object(req._app, 'req._app');
    assert.equal(req._app.mode, 'dc', 'app is in dc mode');
    assert.object(req._image, 'req._image');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var account;
    var app = req._app;
    var clonedImages = [];
    var image = req._image;
    var log = req.log;

    if (req.query && req.query.account) {
        account = req.query.account;
    }

    // Validation.
    if (!UUID_RE.test(account)) {
        next(new errors.InvalidParameterError(
            format('invalid "account": not a UUID: "%s"', account),
            [ { field: 'account', code: 'Invalid' } ]));
        return;
    }

    if (!image.activated) {
        next(new errors.ValidationFailedError('image is not active',
            [ { field: 'active', code: 'Invalid' } ]));
        return;
    }

    if (!image.acl || image.acl.indexOf(account) === -1) {
        next(new errors.ImageNotSharedError(null, account, image.uuid));
        return;
    }

    if (image.type === 'docker') {
        next(new errors.ValidationFailedError(
            'docker images cannot be cloned',
            [ { field: 'type', code: 'Invalid' } ]));
        return;
    }

    log.debug({image: image}, 'cloneImage: start');

    vasync.pipeline({arg: {}, funcs: [
        // Find and validate each of the origin images:
        // 1. must be activated or disabled (disabled means cannot provision)
        // 2. must be owned by the given user (or admin)
        function lookupOriginImages(ctx, pipeNext) {
            // The images to clone, starting from the base.
            ctx.imagesToClone = [image];

            if (!image.origin) {
                pipeNext();
                return;
            }

            function validateOneOriginImage(currentOrigin, subnext) {
                Image.get(app, currentOrigin, log,
                        function _cloneImageGetCb(err, img) {
                    if (err) {
                        subnext(err);
                        return;
                    }
                    // Stop cloning when an admin image is found.
                    if (img.owner === constants.UNSET_OWNER_UUID ||
                            img.owner === app.config.adminUuid) {
                        ctx.originImage = img;
                        subnext();
                        return;
                    }
                    ctx.imagesToClone.unshift(img);
                    // Follow the origin chain.
                    if (img.origin) {
                        if (ctx.imagesToClone.length >=
                                constants.MAX_ORIGIN_DEPTH) {
                            subnext(new errors.InternalError(format(
                                'Origin chain too long, exceeds %d images',
                                constants.MAX_ORIGIN_DEPTH)));
                            return;
                        }
                        validateOneOriginImage(img.origin, subnext);
                        return;
                    }
                    subnext();
                });
            }

            validateOneOriginImage(image.origin, pipeNext);
        },

        // Clone all of the images in the imagesToClone array.
        function cloneImages(ctx, pipeNext) {
            assert.arrayOfObject(ctx.imagesToClone, 'ctx.imagesToClone');

            log.info({uuid: image.uuid},
                'cloneImage: %d images to clone',
                ctx.imagesToClone.length);

            function cloneOneImage(img, nextImageCb) {
                vasync.pipeline({ arg: {}, funcs: [
                    cloneImgMetadata,
                    cloneImgFiles,
                    activateClonedImg
                ]}, nextImageCb);

                function cloneImgMetadata(subctx, subnext) {
                    var imgData = img.serialize(app.mode, '*');
                    var lastIdx = ctx.imagesToClone.length - 1;
                    var isFinalImg = (img === ctx.imagesToClone[lastIdx]);
                    // Remove these image fields.
                    delete imgData.acl;  // No access given to others.
                    delete imgData.uuid; // So we get a new uuid.
                    delete imgData.published_at; // Will be updated.
                    // Change the owner and update the origin.
                    imgData.owner = account;
                    if (ctx.originImage) {
                        imgData.origin = ctx.originImage.uuid;
                    }
                    // Disable intermediate images (so they are not shown as
                    // provisionable), otherwise it would be strange when you
                    // clone image X, but then you see image X, Y and Z (where
                    // Y and Z are parent images of X).
                    if (!isFinalImg) {
                        imgData.disabled = true;
                    }
                    // Create the clone.
                    Image.create(app, imgData, false, false,
                            function _cloneImageCreateCb(cErr, newimg) {
                        if (cErr) {
                            subnext(cErr);
                            return;
                        }
                        subctx.newimg = newimg;
                        ctx.originImage = newimg;
                        clonedImages.push(newimg);
                        subnext();
                    });
                }

                function cloneImgFiles(subctx, subnext) {
                    img.copyFilesToImage(app, subctx.newimg, log, subnext);
                }

                function activateClonedImg(subctx, subnext) {
                    subctx.newimg.activate(app, log, function _imgActCb(err) {
                        if (!err) {
                            log.info({uuid: image.uuid,
                                    clone_uuid: subctx.newimg.uuid},
                                'image cloned');
                        }
                        subnext(err);
                    });
                }
            }

            function cleanupDeleteOneImage(img, deleteNextImg) {
                img.delete(app, log, function _delOneImgCb(delErr) {
                    if (delErr) {
                        log.error({uuid: img.uuid},
                            'clone cleanup failure: unable to delete cloned ' +
                            'image: %s', delErr);
                    }
                    deleteNextImg();
                });
            }

            vasync.forEachPipeline({
                func: cloneOneImage,
                inputs: ctx.imagesToClone
            }, function _cloneImgPipeCb(err) {
                if (err) {
                    // Failure - cleanup newly created/cloned images.
                    vasync.forEachPipeline({
                        func: cleanupDeleteOneImage,
                        inputs: clonedImages
                    }, function _deleteImgPipeCb() {
                        pipeNext(err);
                    });
                    return;
                }
                pipeNext();
            });
        }

    ]}, function _clonePipelineCb(err) {
        if (err) {
            log.error({account: account, image: image.uuid},
                'Unable to clone image: %s', err);
            next(err);
            return;
        }

        var finalImage = clonedImages[clonedImages.length - 1];
        res.send(finalImage.serialize(app.mode, req.getVersion()));
        next();
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
 * Validate `?inclAdminFields=<true|false>` query param
 * and set `req.inclAdminFields`.
 */
function reqInclAdminFields(req, res, next) {
    try {
        var inclAdminFields = utils.boolFromString(
            req.query.inclAdminFields, false, 'inclAdminFields');
    } catch (err) {
        next(err);
        return;
    }

    if (inclAdminFields && req._app.mode !== 'dc' &&
        req.remoteUser === undefined)
    {
        next(new errors.UnauthorizedError(
            'Unauthorized (auth required to use "inclAdminFields" parameter)'));
        return;
    }

    req.inclAdminFields = inclAdminFields;
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
            } else if (!image.activated) {
                // Unactivated image: cannot see others' unactivated images.
                log.info({image: image, account: account},
                    'access denied: unactivated image owned by someone else');
                access = false;
            } else if (image.public) {
                // Public activated image (might currently be disabled).
                access = true;
            } else if (image.acl && image.acl.indexOf(account) !== -1) {
                // Private image for which `account` is on the ACL.
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

        /*
         * Set Etag for conditional request handling.
         *
         * Don't set it as a header because we don't know which handler is
         * making use of reqGetImage. However `restify.conditionalRequest`
         * will pick up on `res.etag`.
         *
         * Dev Note: We're a little loosey goosey about which serialization
         * (when different Accept-Version clients are in play) is used for the
         * Etag here. It shouldn't matter in practice.
         */
        var shasum = crypto.createHash('sha1');
        shasum.update(
            JSON.stringify(image.serialize(req._app.mode, req.getVersion())),
            'utf8');
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
 * Ensures the referenced image is a docker image.
 */
function reqEnsureImageIsDockerImage(req, res, next) {
    assert.object(req._image, 'req._image');
    if (req._image.type !== 'docker') {
        next(new errors.ValidationFailedError(
            'image is not a docker image',
            [ { field: 'type', code: 'Invalid' } ]));
        return;
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
function mountApi(server, app, reqAuth, reqPassiveAuth) {
    server.get(
        {path: '/images', name: 'ListImages'},
        reqPassiveAuth,
        channels.reqChannelAllowStar,
        reqInclAdminFields,
        apiListImages);
    server.get(
        {path: '/images/:uuid', name: 'GetImage'},
        reqValidUuid,
        reqPassiveAuth,
        channels.reqChannelAllowStar,
        reqGetImage,    // add `req._image`, ensure access
        reqInclAdminFields,
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
        apiAdminImportDockerImage,
        apiAdminImportLxdImage,
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
    server.post(
        {path: '/images/:uuid/file/from-url', name: 'AddImageFileFromUrl'},
        reqAuth,
        reqValidUuid,
        channels.reqChannel,
        reqGetImage,    // add `req._image`, ensure access
        reqEnsureAccountIsImageOwner,
        restify.bodyParser({mapParams: false}),
        apiAddImageFileFromUrl,
        reqGetImage,    // reload the image after a long running function
        finishMoveImageFile);
    server.get(
        {path: '/images/:uuid/file', name: 'GetImageFile'},
        reqValidUuid,
        channels.reqChannelAllowStar,
        reqGetImage,    // add `req._image`, ensure access
        resSetImageFileCacheHeaders,
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
        channels.reqChannelAllowStar,
        reqGetImage,    // add `req._image`, ensure access
        resSetImageIconCacheHeaders,
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
        apiImportImageFromDatacenter,
        reqGetImage,               // add `req._image`, ensure access
        apiAdminChangeImageStor,
        reqEnsureAccountIsImageOwner,
        apiExportImage,
        restify.conditionalRequest(),
        apiActivateImage,
        apiEnableDisableImage,
        apiChannelAddImage,
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
    server.post(
        {path: '/images/:uuid/push', name: 'AdminPushDockerImage'},
        reqAuth,
        reqValidUuid,
        resume,
        restify.bodyParser({mapParams: false}),
        reqGetImage,  // ensure have access to image before pushing it
        reqEnsureAccountIsImageOwner,
        reqEnsureImageIsDockerImage,
        apiAdminPushDockerImage);
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
        channels.reqChannelAllowStar,
        reqGetImage,    // add `req._image`, ensure access
        apiListImageJobs);


    // IMGAPI functionality that is only available in 'dc' mode.
    if (app.mode === 'dc') {

        server.post(
            {path: '/images/:uuid/clone', name: 'CloneImage'},
            reqAuth,
            reqValidUuid,
            channels.reqChannel,
            reqGetImage,
            apiCloneImage);
    }
}



function bunyanImageSerializer(img) {
    // 'config.mode' isn't know yet, but that doesn't matter for internal
    // logging.
    return ((img && img.serialize) ? img.serialize('dc', '*') : img);
}



//---- exports

module.exports = {
    Image: Image,
    mountApi: mountApi,
    bunyanImageSerializer: bunyanImageSerializer
};
