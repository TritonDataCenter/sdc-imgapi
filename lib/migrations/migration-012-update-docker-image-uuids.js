#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
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

var errors = require('../errors');
var utils = require('../utils');


//---- globals

var NAME = path.basename(__filename);

var CONFIG_PATH;
if (fs.existsSync('/opt/smartdc/imgapi')) {
    CONFIG_PATH = '/opt/smartdc/imgapi/etc/imgapi.config.json';
} else if (fs.existsSync('/root/THIS-IS-IMAGES.JOYENT.COM.txt') ||
    fs.existsSync('/root/THIS-IS-UPDATES.JOYENT.COM.txt')) {
    CONFIG_PATH = '/root/config/imgapi.config.json';
} else {
    CONFIG_PATH = path.resolve(__dirname, '..', '..', 'etc',
        'imgapi.config.json');
}
var IMGAPI_URL = 'http://127.0.0.1';
if (fs.existsSync('/root/THIS-IS-IMAGES.JOYENT.COM.txt') ||
    fs.existsSync('/root/THIS-IS-UPDATES.JOYENT.COM.txt')) {
    IMGAPI_URL = 'https://127.0.0.1';
}
var config = JSON.parse(fs.readFileSync(CONFIG_PATH));
var morayClient = null;  // set in `getMorayClient()`


//---- support functions

function errexit(err) {
    console.error(NAME + ' error: ' + err);
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


function morayListImages(callback) {
    var images = [];
    var req = morayClient.sql('select * from ' + BUCKET
        + ' where type=\'docker\'');

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
            if (getErr) {
                callback(getErr);
                return;
            }
            origin = object.value;
            cb();
        });
    }

    function linkFile(cb) {
        info('migrating image %s to new UUID %s', uuid, newUuid);

        var newPrefix = newUuid.slice(0, 3);
        var newDir = path.join(localDir, newPrefix, newUuid);
        var newFile = path.join(newDir, 'file0');

        mkdirp(newDir, function (mkErr) {
            if (mkErr) {
                warn('Could not create %s', newDir);
                return cb(mkErr);
            }

            fs.link(oldFile, newFile, function (moveErr) {
                if (moveErr && moveErr.code && moveErr.code === 'EEXIST') {
                    warn('Destination file already exists %s', newFile);
                    return cb();
                } else if (moveErr) {
                    warn('Could not link %s', newFile);
                    return cb(moveErr);
                }

                // chmod new image directory to 'nobody' user so the imgapi
                // service (running as 'nobody') can change it.
                getNobody(function (nobody) {
                    if (!nobody) {
                        return cb(new Error('could not get nobody user'));
                    }
                    fs.chown(newDir, Number(nobody.userId),
                    Number(nobody.groupId), function (chownErr) {
                        if (chownErr) {
                            return cb(chownErr);
                        }
                        info('%s has been linked successfully', newFile);
                        return cb();
                    });
                });
            });
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

        if (!image.files || image.files[0].stor !== 'local') {
            warn('cannot migrate %s. Image file is not stored locally', uuid);
            callback();
            return;
        } else if (!image.tagsObj || !image.tagsObj['docker:repo'] ||
            !image.tagsObj['docker:id']) {
            warn('cannot migrate %s. Image docker tags are incomplete', uuid);
            callback();
            return;
        }

        indexName = drc.parseRepo(image.tagsObj['docker:repo']).index.name;
        newUuid = imgmanifest.imgUuidFromDockerInfo({
            id: image.tagsObj['docker:id'],
            indexName: indexName
        });

        if (newUuid === uuid) {
            trace('image %s appears to have been migrated already', uuid);
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
    assert.object(config.storage, 'config.storage');
    assert.object(config.storage.local, 'config.storage.local');
    assert.string(config.storage.local.baseDir, 'config.storage.local.baseDir');
    assert.object(config.database, 'config.database');

    if (config.database.type !== 'moray') {
        errexit('migration not supported, database type is not moray');
    }

    var localCfg = config.storage.local;
    assert.string(localCfg.baseDir, 'local.baseDir');

    var baseDir = path.resolve(localCfg.baseDir);
    localDir = path.join(baseDir, 'images');

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
}

if (require.main === module) {
    main(process.argv);
}
