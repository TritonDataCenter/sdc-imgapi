#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/**
 * This script does *part* of the process of switching an IMGAPI to having all
 * its image files locally to having them all in Manta.
 *
 * Basically the process for that move would be:
 * - Run all current migrations (from lib/migrations/...) to ensure that you
 *   have a local storage structure matching that that will exist in Manta.
 * - Stop imgapi.
 * - Run `manta-sync ...` to move the local imgapi images storage to
 *   the appropriate base dir in Manta. TODO: examples
 * - Run this migration to have the manifests updated so that `files[0].stor = "manta"`.
 */

var p = console.log;
var fs = require('fs');
var path = require('path');
var ldap = require('ldapjs');
var assert = require('assert-plus');
var async = require('async');
var passwd = require('passwd');

var constants = require('../lib/constants');
var errors = require('../lib/errors');


//---- globals

var NAME = path.basename(__filename);

var CONFIG_PATH = '/data/imgapi/etc/imgapi.config.json';
var config = JSON.parse(fs.readFileSync(CONFIG_PATH));


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


var _nobodyCache = undefined;
function getNobody(callback) {
    if (_nobodyCache !== undefined)
        return callback(_nobodyCache);

    passwd.get('nobody', function (nobody) {
        _nobodyCache = nobody;
        callback(_nobodyCache);
    });
}


function migrateImage(image, callback) {
    var files = image.files;
    var uuid = image.uuid;
    if (!files)
        return callback();
    var file = files[0];
    if (!file)
        return callback();
    if (file.stor !== 'local')
        return callback();
    info('migrate "%s"', uuid);
    file.stor = 'manta';

    var dbPath = path.resolve(constants.DATABASE_LOCAL_DIR, uuid + '.raw');
    var content = JSON.stringify(image, null, 2);
    fs.writeFile(dbPath, content, 'utf8', function (err) {
        if (err)
            return callback(err);
        // chmod to 'nobody' user so the imgapi service (running as
        // 'nobody') can change it.
        getNobody(function (nobody) {
            if (!nobody) {
                return callback(new Error('could not get nobody user'));
            }
            fs.chown(dbPath, Number(nobody.userId), Number(nobody.groupId),
                callback);
        });
    });
}


function localListImages(callback) {
    /*JSSTYLED*/
    var RAW_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.raw$/;
    fs.readdir(constants.DATABASE_LOCAL_DIR, function (err, files) {
        var images = [];
        async.forEachSeries(
            files,
            function oneFile(file, next) {
                if (!RAW_FILE_RE.test(file))
                    return next();
                var path_ = path.resolve(constants.DATABASE_LOCAL_DIR, file);
                fs.readFile(path_, 'utf8', function (readErr, content) {
                    if (readErr)
                        return next(readErr);
                    try {
                        images.push(JSON.parse(content));
                    } catch (ex) {
                        return next(ex);
                    }
                    next();
                });
            },
            function done(err2) {
                callback(err2, images);
            }
        );
    });
}


function localMigrate(callback) {
    assert.equal(config.databaseType, 'local');
    localListImages(function (err, images) {
        if (err)
            return callback(err);
        async.forEachSeries(images, migrateImage, callback);
    });
}



//---- mainline

function main(argv) {
    assert.object(config.databaseType, 'config.databaseType');
    if (config.databaseType === 'local') {
        localMigrate(function (err) {
            if (err) {
                errexit(err);
            } else {
                process.exit(0);
            }
        });
    } else {
        info('IMGAPI instance not using a Local database');
        process.exit(0);
    }
}

if (require.main === module) {
    main(process.argv);
}
