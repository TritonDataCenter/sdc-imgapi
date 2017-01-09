#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/*
 * Update type=docker images to the new UUID scheme. In early sdc-docker days
 * the image UUID was just the first half of the Docker ID. That changed to
 * be a v5 uuid of the Docker registry host and the Docker ID (see DOCKER-257).
 * This migration handles that UUID change:
 * - update 'manifest.uuid' in the DB
 * - update 'manifest.origin' in the DB
 * - drop tags.docker=true, this is obsolete
 * - move the files in storage as appropriate (new loc b/c new uuid)
 *
 * Limitations:
 * - Don't handle a "local" DB (i.e. only handle Moray DB).
 * - Don't handle a "manta" storage. While Docker images are intended to be
 *   stored in Manta, there was a bug before this migration that meant they
 *   weren't.
 */

var fs = require('fs');
var path = require('path');
var moray = require('moray');
var bunyan = require('bunyan');
var assert = require('assert-plus');
var async = require('async');
var passwd = require('passwd');
var format = require('util').format;
var execFile = require('child_process').execFile;
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var imgmanifest = require('imgmanifest');
var drc = require('docker-registry-client');
var vasync = require('vasync');

var lib_config = require('../config');
var constants = require('../constants');
var errors = require('../errors');
var utils = require('../utils');


//---- globals

var NAME = path.basename(__filename);

var config;
var morayClient = null;  // set in `getMorayClient()`


//---- support functions

function errexit(err) {
    arguments[0] = NAME + ' error: ' + arguments[0];
    console.error.apply(null, arguments);
    process.exit(1);
}

function warn() {
    arguments[0] = NAME + ' warn: ' + arguments[0];
    console.warn.apply(null, arguments);
}

function info() {
    arguments[0] = NAME + ' info: ' + arguments[0];
    console.log.apply(null, arguments);
}

var trace = function () {};
if (process.env.TRACE) {
    trace = function () {
        arguments[0] = NAME + ' trace: ' + arguments[0];
        console.log.apply(null, arguments);
    };
}

var _nobodyCache;
function getNobody(callback) {
    if (_nobodyCache !== undefined)
        return callback(_nobodyCache);

    passwd.get('nobody', function (nobody) {
        _nobodyCache = nobody;
        callback(_nobodyCache);
    });
}


var BUCKET = 'imgapi_images';
var localDir;


function getMorayClient(callback) {
    var client = moray.createClient({
        connectTimeout: config.moray.connectTimeout || 200,
        host: config.moray.host,
        port: config.moray.port,
        log: bunyan.createLogger({
            name: 'moray',
            level: 'INFO',
            stream: process.stdout,
            serializers: bunyan.stdSerializers
        }),
        reconnect: true,
        retry: (config.moray.retry === false ? false : {
            retries: Infinity,
            minTimeout: 1000,
            maxTimeout: 16000
        })
    });

    client.on('connect', function () {
        return callback(client);
    });
}

function morayFind(bucket, filter, callback) {
    var hits = [];
    var req = morayClient.findObjects(bucket, filter);
    req.once('error', function (err) {
        trace('morayFind(%s, "%s") error: %s', bucket, filter, err);
        return callback(err);
    });
    req.on('record', function (object) {
        hits.push(object);
    });
    req.once('end', function () {
        trace('morayFind(%s, "%s") hits: %j', bucket, filter, hits);
        return callback(null, hits);
    });
}

function morayListImages(callback) {
    var images = [];
    var req = morayClient.sql('select * from ' + BUCKET
        + ' where type=\'docker\' and activated');

    req.once('error', function (err) {
        return callback(err);
    });

    req.on('record', function (object) {
        var value = JSON.parse(object._value);
        images.push(value.uuid);
    });

    req.once('end', function () {
        return callback(null, images);
    });
}


/*
 * Images are going to be migrated only under the following conditions:
 *
 * 1. type === 'docker'
 * 2. files[0].stor === local
 * 3. tags['docker:repo'] and tags['docker:id'] are present
 * 4. newUuid !== uuid
 */
function migrateImage(uuid, callback) {
    trace('migrate "%s"', uuid);
    var image;
    var indexName;
    var newUuid;
    var origin;

    var oldPrefix = uuid.slice(0, 3);
    var oldFile = path.join(localDir, oldPrefix, uuid, 'file0');

    function getOrigin(cb) {
        if (!image.origin) {
            return cb();
        }

        morayClient.getObject(BUCKET, image.origin, function (getErr, object) {
            if (getErr && getErr.name === 'ObjectNotFoundError') {
                /*
                 * If the origin was already migrated, it won't be there
                 * anymore. We have the uuid, which in the old world, is the
                 * first half of the Docker ID. We'll make a short (12-char)
                 * Docker ID and search by 'version=shortDockerId'. Bit of a
                 * hack, but should have a unique hit.
                 */
                var shortId = image.origin.replace(/-/g, '').slice(0, 12);
                var filter = '(&(name=docker-layer)(version=' + shortId + '))';
                morayFind(BUCKET, filter, function (getErr2, hits) {
                    if (getErr2) {
                        cb(getErr2);
                    } else {
                        assert.equal(hits.length, 1,
                            'unexpected number of image hits for origin: '
                            + hits);
                        origin = hits[0].value;
                        cb();
                    }
                });
            } else if (getErr) {
                cb(getErr);
            } else {
                origin = object.value;
                cb();
            }
        });
    }

    function linkFile(cb) {
        info('migrating image %s to new UUID %s', uuid, newUuid);

        var newPrefix = newUuid.slice(0, 3);
        var newDir = path.join(localDir, newPrefix, newUuid);
        var newFile = path.join(newDir, 'file0');

        vasync.pipeline({arg: {}, funcs: [
            function getNobodyInfo(ctx, next) {
                getNobody(function (nobody) {
                    if (!nobody) {
                        next(new Error('could not get nobody user'));
                    } else {
                        ctx.nobody = nobody;
                        next();
                    }
                });
            },

            function makeNewDir(ctx, next) {
                mkdirp(newDir, function (err) {
                    if (err) {
                        warn('Could not mkdir -p %s', newDir);
                        next(err);
                    } else {
                        next();
                    }
                });
            },

            function chownNewDir(ctx, next) {
                // IMGAPI runs as 'nobody' and must own this dir.
                fs.chown(newDir,
                    Number(ctx.nobody.userId),
                    Number(ctx.nobody.groupId),
                    next);
            },

            function chownNewPrefixDir(ctx, next) {
                fs.chown(path.dirname(newDir),
                    Number(ctx.nobody.userId),
                    Number(ctx.nobody.groupId),
                    next);
            },

            function linkTheFile(ctx, next) {
                fs.link(oldFile, newFile, function (err) {
                    if (err && err.code && err.code === 'EEXIST') {
                        warn('Destination file already exists: %s', newFile);
                        next();
                    } else if (err) {
                        warn('Could not link %s', newFile);
                        next(err);
                    } else {
                        // IMGAPI runs as 'nobody' and must own this file.
                        fs.chown(newFile,
                            Number(ctx.nobody.userId),
                            Number(ctx.nobody.groupId),
                            next);
                    }
                });
            }

        ]}, function (err) {
            if (!err) {
                info('%s has been linked successfully', newFile);
            }
            cb(err);
        });
    }

    function recreateObject(cb) {
        assert.ok(uuid !== newUuid);

        // Updates to the manifest.
        image.uuid = newUuid;
        if (config.adminUuid && image.owner === config.adminUuid) {
            // Move all sdc-docker-managed images to be private to admin.
            image.public = false;
        }
        if (image.tagsObj['docker'] === true) {
            delete image.tagsObj['docker'];
        }
        // Normalize tags['docker:repo'] to a repo 'localName'. Earlier code
        // would have, e.g. 'library/busybox'.
        if (image.tagsObj['docker:repo']) {
            var norm = drc.parseRepo(image.tagsObj['docker:repo']).localName;
            image.tagsObj['docker:repo'] = norm;
        }
        image.tags = utils.tagsSearchArrayFromObj(image.tagsObj);
        if (image.origin) {
            image.origin = imgmanifest.imgUuidFromDockerInfo({
                id: origin.tagsObj['docker:id'],
                indexName: indexName
            });
        }

        // Save changes to the DB.
        var batch = [ {
            bucket: BUCKET,
            key: newUuid,
            value: image
        }, {
            bucket: BUCKET,
            operation: 'delete',
            key: uuid
        }];
        morayClient.batch(batch, cb);
    }

    function unlinkFile(cb) {
        fs.unlink(oldFile, function (err) {
            if (err) {
                return cb(err);
            }
            info('%s has been removed successfully', oldFile);
            return cb();
        });
    }

    morayClient.getObject(BUCKET, uuid, function (getErr, object) {
        if (getErr) {
            callback(getErr);
            return;
        }

        image = object.value;

        if (!image.tagsObj || !image.tagsObj['docker:id']) {
            errexit('cannot migrate %s. Image docker tags are incomplete',
                uuid);
            callback();
            return;
        }

        var dockerId = image.tagsObj['docker:id'];
        if (dockerId.length !== 64) {
            // It's a different docker id to what we are expecting - skip it, as
            // it's likely a newer (v2.2) docker id of the form 'sha256:123...'.
            info('Skipped dockerId where length != 64: %s', dockerId);
            callback();
            return;
        }

        if (!image.tagsObj['docker:repo']) {
            // Cheat. We know before this migration (which was part of
            // private registry support) that the only index/registry from
            // which pulls were supported was 'docker.io'.
            indexName = 'docker.io';
        }
        if (!indexName) {
            indexName = drc.parseRepo(image.tagsObj['docker:repo']).index.name;
        }

        newUuid = imgmanifest.imgUuidFromDockerInfo({
            id: dockerId,
            indexName: indexName
        });

        if (newUuid === uuid) {
            trace('image %s appears to have been migrated already', uuid);
            callback();
            return;
        }

        if (!image.files || image.files[0].stor !== 'local') {
            errexit('cannot migrate %s. Image file is not stored locally',
                uuid);
            callback();
            return;
        }

        async.series([
            getOrigin,
            linkFile,
            recreateObject,
            unlinkFile
        ], callback);
    });
}

function morayMigrate(callback) {
    getMorayClient(function (mclient) {
        morayClient = mclient;

        morayListImages(function (err, images) {
            if (err) {
                return callback(err);
            }

            info('%d images to potentially migrate', images.length);
            async.forEachSeries(images, migrateImage, callback);
        });
    });
}


//---- mainline

function main(argv) {
    lib_config.loadConfig({}, function (confErr, config_) {
        if (confErr) {
            errexit(confErr);
            return;
        }

        config = config_;
        assert.string(config.databaseType, 'config.databaseType');

        if (config.databaseType !== 'moray') {
            errexit('migration not supported, database type is not moray');
        }

        localDir = constants.STORAGE_LOCAL_IMAGES_DIR;
        assert.ok(localDir !== '/',
            'cannot have empty or root dir for local storage');

        morayMigrate(function (err) {
            if (err) {
                errexit(err);
            } else {
                info('finished sucessfully');
                process.exit(0);
            }
        });
    });
}

if (require.main === module) {
    main(process.argv);
}
