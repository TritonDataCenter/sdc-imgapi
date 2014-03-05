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

var UUID_REGEX =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var config = JSON.parse(fs.readFileSync(CONFIG_PATH));

var mantaClient, imagesDir, newImagesDir;



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


function moveImages(callback) {
    mantaClient.ls(imagesDir, function (lsErr, res) {
        if (lsErr) {
            return callback(lsErr);
        }

        var dirs = [];
        res.on('object', function (obj) {
            // Ignore objects
        });
        res.on('directory', function (dir) {
            if (UUID_REGEX.test(dir.name)) {
                dirs.push(dir.name);
            } else {
                info('directory %s is not a UUID, ignoring', dir.name);
            }
        });
        // Only remove directory if it's empty
        res.once('end', function () {
            async.forEachSeries(dirs, moveImage, callback);
        });
    });

    function moveImage(dir, next) {
        var dirPath = path.join(imagesDir, dir);

        mantaClient.ls(dirPath, function (lsErr, res) {
            if (lsErr) {
                return next(lsErr);
            }

            var files = [];
            res.on('object', function (obj) {
                // $uuid/file0
                // $uuid/icon
                files.push(path.join(dir, obj.name));
            });
            res.on('directory', function (aDir) {
                // There should not be any directories here
            });
            // Only remove directory if it's empty
            res.once('end', function () {
                if (files.length) {
                    // Remove dir after move
                    async.forEachSeries(files, moveFile, function (aErr) {
                        if (aErr) {
                            return next(aErr);
                        }
                        return removeDir(dirPath, next);
                    });
                } else {
                    return removeDir(dirPath, next);
                }
            });
        });
    }

    function removeDir(dirPath, next) {
        mantaClient.rmr(dirPath, function (rmErr) {
            if (rmErr) {
                return next(rmErr);
            }
            info('directory "%s" has been removed',
                dirPath);
            return next();
        });
    }

    function moveFile(file, next) {
        var oldPath = path.join(imagesDir, file);
        var newPath = path.join(newImagesDir, file);
        var newDir = path.dirname(newPath);

        mantaClient.info(oldPath, function (infoErr, fInfo) {
            if (infoErr) {
                return next(infoErr);
            }

            // Make sure new directory exists first
            mantaClient.mkdirp(newDir, function (mkErr) {
                if (mkErr) {
                    return callback(mkErr);
                }
                return moveAndRemove(fInfo.md5);
            });
        });

        function moveAndRemove(oldMd5) {
            mantaClient.ln(oldPath, newPath, function (lnErr) {
                if (lnErr) {
                    return next(lnErr);
                }

                // Now, make sure both md5's match before removing the source
                mantaClient.info(newPath, function (info2Err, info2) {
                    if (info2Err) {
                        return next(info2Err);
                    }

                    if (oldMd5 !== info2.md5) {
                        warn('md5 for "%s" doesn\'t match old md5 (%s vs %s)',
                            newPath, oldMd5, info2.md5);
                        return next();
                    }
                    // If it matches, delete the old file
                    mantaClient.unlink(oldPath, function (ulErr) {
                        if (ulErr) {
                            return next(ulErr);
                        }

                        info('directory "%s" successfully moved', newPath);
                        return next();
                    });
                });
            });
        }
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
    imagesDir = format('/%s/stor/imgapi/%s', user, config.datacenterName);
    newImagesDir = format('/%s/stor/imgapi/%s/images',
        user, config.datacenterName);

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

    return moveImages(callback);
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
