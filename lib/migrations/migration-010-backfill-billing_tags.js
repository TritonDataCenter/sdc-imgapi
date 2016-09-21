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
 * IMGAPI db migration: TODO: describe
 */

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

var lib_config = require('../config');


//---- globals

var NAME = path.basename(__filename);

var config;
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
            expires_at: { type: 'string' }
        }
    }
};

// Because regular findObjects will not load the "hidden" billing_tags values
// we need to load all raw objets with sql() and then perform a single
// getObject for each one of them
var allBillingTags = {};


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
    // var req = morayClient.findObjects('imgapi_images', 'uuid=*');
    var req = morayClient.sql('select * from ' + BUCKET.name);

    req.once('error', function (err) {
        return callback(err);
    });

    req.on('record', function (object) {
        var value = JSON.parse(object._value);
        if (value.billing_tags !== undefined) {
            allBillingTags[object._key] = value.billing_tags;
        }
    });

    req.once('end', function () {
        return callback(null);
    });
}


function migrateImage(uuid, callback) {
    info('migrate "%s"', uuid);

    // We just need to write the image again. billing_tags was previously inside
    // _value and now we need to write the object again so its moray index is
    // written correctly
    morayClient.getObject(BUCKET.name, uuid, function (getErr, object) {
        if (getErr) {
            callback(getErr);
            return;
        }

        var image = object.value;
        image.billing_tags = allBillingTags[uuid];

        morayClient.putObject(BUCKET.name, uuid, image, { noBucketCache: true },
        function (err) {
            if (err) {
                callback(err);
                return;
            }

            info('"billing_tags" for image %s have been updated', uuid);
            callback();
        });
    });
}

function morayMigrate(callback) {
    assert.equal(config.databaseType, 'moray');
    morayListImages(function (err2) {
        if (err2) {
            return callback(err2);
        }

        var images = Object.keys(allBillingTags);

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
            } else if (bck.index.billing_tags !== undefined) {
                info('"billing_tags" index already exists, no need to add');
                return callback();
            }

            info('adding "billing_tags" index');
            morayClient.updateBucket(BUCKET.name, BUCKET.indices, callback);
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
    });
}

if (require.main === module) {
    main(process.argv);
}
