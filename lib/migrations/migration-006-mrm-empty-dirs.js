#!/usr/bin/env node
/*
 * IMGAPI db migration: adds guid field to every image files object.
 */

var p = console.log;
var fs = require('fs');
var path = require('path');
var manta = require('manta');
var assert = require('assert-plus');
var async = require('async');
var format = require('util').format;


//---- globals

var NAME = path.basename(__filename);

var CONFIG_PATH = '/opt/smartdc/imgapi/etc/imgapi.config.json';
if (fs.existsSync('/root/THIS-IS-IMAGES.JOYENT.COM.txt') ||
    fs.existsSync('/root/THIS-IS-UPDATES.JOYENT.COM.txt')) {
    CONFIG_PATH = '/root/config/imgapi.config.json';
}
var IMGAPI_URL = 'http://127.0.0.1';
if (fs.existsSync('/root/THIS-IS-IMAGES.JOYENT.COM.txt') ||
    fs.existsSync('/root/THIS-IS-UPDATES.JOYENT.COM.txt')) {
    IMGAPI_URL = 'https://127.0.0.1';
}
var config = JSON.parse(fs.readFileSync(CONFIG_PATH));

var mantaClient, imagesDir;



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


function mrmEmptyDirs(callback) {
    mantaClient.ls(imagesDir, function (lsErr, res) {
        if (lsErr) {
            return callback(lsErr);
        }

        var dirs = [];
        res.on('object', function (obj) {
            // Ignore objects
        });
        res.on('directory', function (dir) {
            dirs.push(dir.name);
        });
        // Only remove directory if it's empty
        res.once('end', function () {
            async.forEachSeries(dirs, rmrDir, callback);
        });
    });

    function rmrDir(dir, next) {
        var dirPath = path.join(imagesDir, dir);

        mantaClient.ls(dirPath, function (lsErr, res) {
            if (lsErr) {
                return next(lsErr);
            }

            var found = 0;
            res.on('object', function (obj) {
                found++;
            });
            res.on('directory', function (dir) {
                found++;
            });
            // Only remove directory if it's empty
            res.once('end', function () {
                if (found > 0) {
                    info('directory "%s" not empty', dirPath);
                    return next();
                }

                mantaClient.rmr(dirPath, function (rmErr) {
                    if (rmErr) {
                        return next(rmErr);
                    }
                    info('directory "%s" has been removed', dirPath);
                    return next();
                });
            });
        });
    }
}


function mantaMigrate(callback) {
    var mantaCfg = config.storage.manta;
    assert.string(config.datacenterName, 'config.datacenterName');
    assert.string(mantaCfg.url, 'manta.url');
    assert.string(mantaCfg.user, 'manta.user');
    assert.string(mantaCfg.key, 'manta.key');
    assert.string(mantaCfg.keyId, 'manta.keyId');
    assert.optionalBool(mantaCfg.insecure, 'manta.insecure');

    var insecure = mantaCfg.hasOwnProperty('insecure') ?
        mantaCfg.insecure : false;
    var user = mantaCfg.user;
    imagesDir = format('/%s/stor/imgapi/%s/images', user,config.datacenterName);

    mantaClient = manta.createClient({
        sign: {
            key: mantaCfg.key,
            keyId: mantaCfg.keyId,
            user: user
        },
        user: user,
        url: mantaCfg.url,
        rejectUnauthorized: !insecure
    });

    return mrmEmptyDirs(callback);
}



//---- mainline

function main(argv) {
    assert.object(config.storage, 'config.storage');
    if (config.storage.manta) {
        mantaMigrate(function (err) {
            if (err) {
                errexit(err);
            } else {
                process.exit(0);
            }
        });
    } else {
        info('IMGAPI instance not configured to use Manta');
        process.exit(0);
    }
}

if (require.main === module) {
    main(process.argv);
}
