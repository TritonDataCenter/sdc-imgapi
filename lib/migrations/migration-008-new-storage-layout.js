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
 * IMGAPI db migration: Move to new storage layout for image files, from:
 *      .../images/$uuid
 * to:
 *      .../images/$uuid3charprefix/$uuid
 */

var fs = require('fs');
var path = require('path');
var manta = require('manta');
var assert = require('assert-plus');
var async = require('async');
var mkdirp = require('mkdirp');
var passwd = require('passwd');

var lib_config = require('../config');
var constants = require('../constants');


//---- globals

var NAME = path.basename(__filename);
var UUID_REGEX =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

var config;
var mantaClient;
var mantaDir, localDir;



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


var _nobodyCache;
function getNobody(callback) {
    if (_nobodyCache !== undefined)
        return callback(_nobodyCache);

    passwd.get('nobody', function (nobody) {
        _nobodyCache = nobody;
        callback(_nobodyCache);
    });
}


function moveMantaImages(callback) {
    mantaClient.ls(mantaDir, function (lsErr, res) {
        if (lsErr) {
            if (lsErr.statusCode && lsErr.statusCode === 404) {
              return callback();
            } else {
              return callback(lsErr);
            }
        }

        var dirs = [];
        res.on('object', function (obj) {
            // Ignore objects
        });
        res.on('directory', function (dir) {
            if (UUID_REGEX.test(dir.name)) {
                dirs.push(dir.name);
            }
        });
        // Only remove directory if it's empty
        res.once('end', function () {
            async.forEachSeries(dirs, moveImage, callback);
        });
    });

    function moveImage(dir, next) {
        var prefix = dir.slice(0, 3);
        var dirPath = path.join(mantaDir, dir);
        var newDirPath = path.join(mantaDir, prefix, dir);

        mantaClient.mkdirp(newDirPath, function (mkErr) {
            if (mkErr) {
                return next(mkErr);
            }

            mantaClient.ls(dirPath, function (lsErr, res) {
                if (lsErr) {
                    return next(lsErr);
                }

                var files = [];
                res.on('object', function (obj) {
                    // $prefix, $uuid/file0
                    // $prefix, $uuid/icon
                    files.push([ prefix, path.join(dir, obj.name) ]);
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

    function moveFile(array, next) {
        var prefix = array[0];
        var file = array[1];

        var oldPath = path.join(mantaDir, file);
        var newPath = path.join(mantaDir, prefix, file);

        mantaClient.info(oldPath, function (infoErr, fInfo) {
            if (infoErr) {
                return next(infoErr);
            }

            return moveAndRemove(fInfo.md5);
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
    assert.string(config.manta.url, 'config.manta.url');
    assert.string(config.manta.user, 'config.manta.user');
    assert.string(config.manta.key, 'config.manta.key');
    assert.string(config.manta.keyId, 'config.manta.keyId');
    assert.optionalBool(config.manta.insecure, 'config.manta.insecure');
    assert.string(config.manta.rootDir, 'config.manta.rootDir');

    var insecure = config.manta.hasOwnProperty('insecure') ?
        config.manta.insecure : false;
    mantaDir = path.join(config.manta.rootDir, 'images');  // global

    mantaClient = manta.createClient({
        sign: {
            key: config.manta.key,
            keyId: config.manta.keyId,
            user: config.manta.user
        },
        user: config.manta.user,
        url: config.manta.url,
        rejectUnauthorized: !insecure
    });

    return moveMantaImages(callback);
}


function moveLocalImages(callback) {
    fs.readdir(localDir, function (dirErr, dirs) {
        if (dirErr) {
            warn(dirErr, 'Error reading local storage directory');
            return callback(dirErr);
        }

        async.forEachSeries(dirs, moveDir, function (moveDirErr) {
            if (moveDirErr) {
                warn('Error moving local directories');
                callback(moveDirErr);
            } else {
                info('Images successfully moved to new location');
                callback();
            }

        });
    });

    function moveDir(dir, next) {
        if (! UUID_REGEX.test(dir)) {
            if (dir.length !== 3) {
                warn('Directory %s is not a UUID, skipping', dir);
            }
            return next();
        }

        var prefix = dir.slice(0, 3);
        var oldDir = path.join(localDir, dir);
        var newDir = path.join(localDir, prefix, dir);
        var prefixDir = path.join(localDir, prefix);

        mkdirp(prefixDir, function (mkErr) {
            if (mkErr) {
                warn('Could not create %s', prefixDir);
                return next(mkErr);
            }

            fs.rename(oldDir, newDir, function (moveErr) {
                if (moveErr) {
                    warn('Could not move %s', oldDir);
                    return next(moveErr);
                }

                if (config.mode !== 'dc') {
                    info('%s has been moved successfully', dir);
                    return next();
                }
                // chmod new image directory to 'nobody' user so the imgapi
                // service (running as 'nobody') can change it.
                getNobody(function (nobody) {
                    if (!nobody) {
                        return next(new Error('could not get nobody user'));
                    }
                    fs.chown(prefixDir, Number(nobody.userId),
                    Number(nobody.groupId), function (chownErr) {
                        if (chownErr) {
                            return next(chownErr);
                        }
                        info('%s has been moved successfully', dir);
                        return next();
                    });
                });
            });
        });
    }
}


function localMigrate(callback) {
    localDir = constants.STORAGE_LOCAL_IMAGES_DIR;  // global
    assert.ok(localDir !== '/',
        'cannot have empty or root dir for local storage');

    return moveLocalImages(callback);
}



//---- mainline

function main(argv) {
    lib_config.loadConfig({}, function (confErr, config_) {
        if (confErr) {
            errexit(confErr);
            return;
        }

        config = config_;
        assert.object(config.storageTypes, 'config.storageTypes');

        // Because all IMGAPI instances have local storage
        var functions = [ localMigrate ];
        if (config.storageTypes.indexOf('manta') !== -1) {
            functions.push(mantaMigrate);
        }

        async.series(functions, function (err) {
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
