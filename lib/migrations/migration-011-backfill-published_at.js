#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * IMGAPI db migration: TODO: describe
 */

var p = console.log;
var fs = require('fs');
var path = require('path');
var moray = require('moray');
var bunyan = require('bunyan');
var errors = require('../errors');
var assert = require('assert-plus');
var async = require('async');
var passwd = require('passwd');
var format = require('util').format;
var execFile = require('child_process').execFile;
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');


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

var BUCKET = {
    name: 'imgapi_images',
    indices: {
        index: {
            uuid: { type: 'string', unique: true},
            name: { type: 'string' },
            version: { type: 'string' },
            owner: { type: 'string' },
            origin: { type: 'string' },
            state: { type: 'string' },
            urn: { type: 'string', unique: true },
            tags: { type: '[string]' },
            billing_tags: { type: '[string]' },
            acl: { type: '[string]' },
            activated: { type: 'boolean' },
            disabled: { type: 'boolean' },
            public: { type: 'boolean' },
            os: { type: 'string' },
            type: { type: 'string' },
            expires_at: { type: 'string' },
            published_at: { type: 'string' }
        }
    }
};


// Because regular findObjects will not load the "hidden" billing_tags values
// we need to load all raw objets with sql() and then perform a single
// getObject for each one of them
var allPublishedAt = {};


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
    var req = morayClient.sql('select * from ' + BUCKET.name);

    req.once('error', function (err) {
        return callback(err);
    });

    req.on('record', function (object) {
        var value = JSON.parse(object._value);
        if (value.published_at !== undefined) {
            allPublishedAt[object._key] = value.published_at;
        }
    });

    req.once('end', function () {
        return callback(null);
    });
}


function migrateImage(uuid, callback) {
    info('migrate "%s"', uuid);

    // We just need to write the image again so its moray index is
    // written correctly
    morayClient.getObject(BUCKET.name, uuid, function (getErr, object) {
        if (getErr) {
            callback(getErr);
            return;
        }

        var image = object.value;
        image.published_at = allPublishedAt[uuid];

        morayClient.putObject(BUCKET.name, uuid, image, { noBucketCache: true },
        function (err) {
            if (err) {
                callback(err);
                return;
            }

            info('"published_at" for image %s has been updated', uuid);
            callback();
        });
    });
}

function morayMigrate(callback) {
    assert.equal(config.database.type, 'moray');
    morayListImages(function (err2) {
        if (err2) {
            return callback(err2);
        }

        var images = Object.keys(allPublishedAt);

        info('%d images to potentially migrate', images.length);
        async.forEachSeries(images, migrateImage, callback);
    });
}

function updateBucket(callback) {
    getMorayClient(function (mclient) {
        morayClient = mclient;
        morayClient.getBucket(BUCKET.name, function (err, bck) {
            if (err) {
                return callback(err);
            } else if (bck.index.published_at !== undefined) {
                info('"published_at" index already exists, no need to add');
                return callback();
            }

            info('adding "published_at" index');
            morayClient.updateBucket(BUCKET.name, BUCKET.indices, callback);
        });
    });
}



//---- mainline

function main(argv) {
    assert.object(config.storage, 'config.storage');
    assert.object(config.storage.local, 'config.storage.local');
    assert.string(config.storage.local.baseDir, 'config.storage.local.baseDir');
    assert.object(config.database, 'config.database');
    assert.object(config.database, 'config.database');

    if (config.database.type !== 'moray') {
        info('migration not needed, databases type is not moray');
        process.exit(0);
    }

    updateBucket(function (updateErr) {
        if (updateErr) {
            errexit(updateErr);
            return;
        }

        morayMigrate(function (err) {
            if (err) {
                errexit(err);
            } else {
                process.exit(0);
            }
        });
    });
}

if (require.main === module) {
    main(process.argv);
}
