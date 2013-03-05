/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * IMGAPI endpoints for '/datasets/...'. These are solely here to easy the
 * transition from DSAPI. Because of the drop of URNs, the mapping isn't
 * perfect.
 */

var warn = console.warn;
var util = require('util'),
    format = util.format;

var assert = require('assert-plus');
var restify = require('restify');
var async = require('async');

var errors = require('./errors');

var utils = require('./utils'),
    objCopy = utils.objCopy,
    boolFromString = utils.boolFromString,
    isPositiveInteger = utils.isPositiveInteger;
var redir = require('./utils').redir;



//---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



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
        'ListImages query');

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
            type: query.type
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
    req.log.trace({filterOpts: filterOpts}, 'ListImages filterOpts');

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
            req._image = image;
            next();
        });
    });
}


function apiQueueCreateImageJob(req, res, next) {
    if (req.query.action !== 'create_from_snapshot')
        return next();

    var wfapi = req._app.wfapi;
    if (wfapi.connected !== true) {
        return next(new WfapiIsDownError());
    }

    wfapi.createImageFromSnapshotJob(
        req._image.uuid, req.query.snapshot, function (err, jobUuid) {
        if (err) {
            return next(err);
        }
        // When we call create_from_snapshot should we return additional
        // information related to the job that we just queued?
        return next();
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
    req.log.debug({image: req._image}, "AddImageFile: start");

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

    // Validate storage. Only allowed for admin
    var storage = req.query.storage;
    if (storage && req.query.account) {
        var error = {
            field: 'storage',
            code: 'NotAllowed',
            message: 'Parameter cannot be specified by non-operators'
        };
        return next(new errors.InvalidParameterError(
            format('invalid storage "%s"', storage), [error]));
    } else if (storage) {
        if (VALID_STORAGES.indexOf(storage) === -1) {
            return next(new errors.InvalidParameterError(
                format('invalid storage "%s" (must be one of %s)',
                    storage, VALID_STORAGES.join(', ')),
                [{field: 'storage', code: 'Invalid'}]));
        }
    } else if (req.query.account) {
        storage = 'manta';
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
            req.log.error(err, 'error storing image file');
            return next(errors.parseErrorFromStorage(err,
                'error receiving image file'));
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
    });
    req.on('close', function () {
        req.log.trace('req "close" event');
    });

    stor = req._app.storFromImage(req._image, storage);
    stor.storeFileFromStream(req._image, req, 'file0', function (sErr) {
        finish(sErr);
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
    req.log.debug({image: image}, "GetImageFile: start");

    var finished = false;
    function finish(err) {
        if (finished) {
            return;
        }
        finished = true;
        if (err) {
            req.log.error(err, 'error getting image file');
            return next(errors.parseErrorFromStorage(err,
                'error getting image file'));
        }
        next();
    }

    var file = req._image.files[0];
    assert.object(file, 'image.files[0]');
    var stor = req._app.getStor(file.stor);
    stor.createImageFileReadStream(req._image, function (sErr, stream) {
        // TODO: handle 404?
        if (sErr) {
            return finish(sErr);
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
    req.log.debug({image: req._image}, "AddImageIcon: start");

    if (ICON_CONTENT_TYPES.indexOf(req.headers['content-type']) === -1) {
        return next(new errors.UploadError(format(
            'invalid content-type, %s, must be one of %s',
            req.headers['content-type'], ICON_CONTENT_TYPES.join(', '))));
    }

    // Validate storage. Only allowed for admin
    var storage = req.query.storage;
    if (storage && req.query.account) {
        var error = {
            field: 'storage',
            code: 'NotAllowed',
            message: 'Parameter cannot be specified by non-operators'
        };
        return next(new errors.InvalidParameterError(
            format('invalid storage "%s"', storage), [error]));
    } else if (storage) {
        if (VALID_STORAGES.indexOf(storage) === -1) {
            return next(new errors.InvalidParameterError(
                format('invalid storage "%s" (must be one of %s)',
                    storage, VALID_STORAGES.join(', ')),
                [{field: 'storage', code: 'Invalid'}]));
        }
    } else if (req.query.account) {
        storage = 'manta';
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
            req.log.error(err, 'error storing icon file');
            return next(errors.parseErrorFromStorage(err,
                'error receiving image icon'));
        }
        var icon = {
            sha1: shasum.digest('hex'),
            size: size,
            contentType: req.headers['content-type'],
            contentMD5: md5sum.digest('base64'),
            mtime: (new Date()).toISOString(),
            stor: stor.type
        };
        if (size > MAX_ICON_FILE_SIZE) {
            return next(new errors.UploadError(format(
                'icon file size, %s, exceeds the maximum allowed file '
                + 'size, 128KB', size)));
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
    });
    req.on('close', function () {
        req.log.trace('req "close" event');
    });

    stor = req._app.storFromImage(req._image, storage);
    stor.storeFileFromStream(req._image, req, 'icon', function (sErr) {
        finish(sErr);
    });
}


function apiDeleteImageIcon(req, res, next) {
    var image = req._image;
    req.log.debug({image: image}, "DeleteImageIcon: start");

    var icon = image.icon;
    assert.object(icon, 'image.icon');
    var stor = req._app.getStor(icon.stor);
    stor.deleteImageFile(image, 'icon', function (fileErr) {
        if (fileErr) {
            req.log.error({err: fileErr, image: image},
                'error deleting model icon, this image may have a'
                + 'zombie icon file which must be remove manually '
                + 'by an operator');
            return next(errors.parseErrorFromStorage(fileErr,
                'error deleting image icon'));
        }

        req._image.deleteIcon(req._app, req.log, function (err) {
            if (err) {
                req.log.error(err, 'error removing icon from Image');
                return next(new errors.InternalError(err,
                    'could not save image'));
            }
            res.send(req._image.serialize(req._app.mode));
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
    req.log.debug({image: image}, "GetImageIcon: start");

    var finished = false;
    function finish(err) {
        if (finished) {
            return;
        }
        finished = true;
        if (err) {
            req.log.error(err, 'error getting icon file');
            return next(errors.parseErrorFromStorage(err,
                'error getting image icon'));
        }
        next();
    }

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

    req.log.debug({image: req._image}, "ActivateImage: start");
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

    req.log.debug({image: req._image}, action + ": start");
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
    var key;
    for (i = 0; i < dataKeys.length; i++) {
        key = dataKeys[i];
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
        var fields = errs.map(function (e) { return e.field; });
        return next(new errors.ValidationFailedError(
            'invalid image update data: ' + fields.join(', '), errs));
    }

    // Merge new values into existing raw data.
    var raw = req._image.raw;
    for (i = 0; i < dataKeys.length; i++) {
        key = dataKeys[i];
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
                    return next(errors.parseErrorFromStorage(fileErr,
                        'error deleting image file'));
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

    req.log.debug({image: req._image}, "RemoveImageAcl: start");

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
 * Ensure the 'snapshot' request param is valid when creating an image from a
 * snapshot. Not sure what to validate other than the presence of this when
 * action is create_from_snapshot
 */
function reqValidSnapshot(req, res, next) {
    if (req.query.action !== 'create_from_snapshot')
        return next();

    var snapshot = req.query.snapshot;
    if (snapshot === undefined) {
        var errs = [{ field: 'snapshot', code: 'MissingParameter' }];
        return next(new errors.ValidationFailedError(
            'missing snapshot parameter', errs));
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


function apiGetDataset(req, res, next) {
    var arg = req.params.arg;
    if (UUID_RE.test(arg)) {
        redir('/images/' + arg, true)(req, res, next);
    } else {
        var parts = arg.split(/:/g);
        if (parts.length === 2) {
            redir('/images/?name=' + parts[0] + '&version=' + parts[1],
                     true)(req, res, next);
        } else if (parts.length === 3) {
            redir('/images/?name=' + parts[2], true)(req, res, next);
        } else if (parts.length === 4) {
            redir('/images/?name=' + parts[2] + '&version=' + parts[3],
                     true)(req, res, next);
        } else {
            redir('/images/?name=' + arg, true)(req, res, next);
        }
    }
}

/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 */
function mountApi(server) {
    server.get(
        {path: '/datasets', name: 'ListDatasets'},
        redir('/images', true));
    server.get(
        {path: '/datasets/:arg', name: 'GetDataset'},
        apiGetDataset);
}



//---- exports

module.exports = {
    mountApi: mountApi
};
