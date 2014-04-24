#!/usr/bin/env node
/*
 * IMGAPI db migration: migrates every image from ufds to moray.
 */

var p = console.log;
var fs = require('fs');
var path = require('path');
var ldap = require('ldapjs');
var moray = require('moray');
var bunyan = require('bunyan');
var errors = require('../errors');
var assert = require('assert-plus');
var async = require('async');
var passwd = require('passwd');
var format = require('util').format;
var execFile = require('child_process').execFile;


//---- globals

var NAME = path.basename(__filename);

var CONFIG_PATH = '/opt/smartdc/imgapi/etc/imgapi.config.json';
var CONFIG_PATH = './etc/imgapi.config.json';
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
var ufdsClient = null;  // set in `getUfdsClient()`
var morayClient = null;  // set in `getMorayClient()`
var GUID_SCRIPT = path.resolve(__dirname + '/../../tools/get-image-dataset-guid.sh');



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

function getUfdsClient(callback) {
    var client = ldap.createClient({
        url: config.ufds.url,
        connectTimeout: 2 * 1000,
        tlsOptions: {
            rejectUnauthorized: false
        }
    });
    client.bind(config.ufds.bindDN, config.ufds.bindPassword,
        function (bErr) {
            if (bErr) {
                return callback(bErr);
            }
            return callback(null, client);
        }
    );
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

function ufdsListImages(callback) {
    var base = 'ou=images, o=smartdc';
    var opts = {
        filter: 'objectclass=sdcimage',
        scope: 'one'
    };
    ufdsClient.search(base, opts, function (sErr, result) {
        if (sErr) {
            return callback(sErr);
        }

        var images = [];
        result.on('searchEntry', function (entry) {
            images.push(entry.object);
        });

        result.on('error', function (err) {
            callback(err);
        });

        result.on('end', function (res) {
            if (res.status !== 0) {
                return callback(new errors.InternalError(
                    'non-zero status from LDAP search: ' + res));
            }
            callback(null, images);
        });
    });
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


function boolFromString(value) {
    if (value === 'false') {
        return false;
    } else if (value === 'true') {
        return true;
    } else if (typeof (value) === 'boolean') {
        return value;
    }
}


function objectToArray(string) {
    var object = JSON.parse(string);
    var array = [];
    for (var key in object) {
        array.push(key + '=' + object[key]);
    }
    return array;
}


function toNewImage(image) {
    delete image.dn;
    delete image.controls;
    delete image.objectclass;

    if (image.activated !== undefined) {
        image.activated = boolFromString(image.activated);
    }
    if (image.disabled !== undefined) {
        image.disabled = boolFromString(image.disabled);
    }
    if (image['public'] !== undefined) {
        image['public'] = boolFromString(image['public']);
    }
    if (image.generate_passwords !== undefined) {
        image.generate_passwords = boolFromString(image.generate_passwords);
    }
    if (image.image_size) {
        image.image_size = Number(image.image_size);
    }

    ['files', 'requirements', 'error', 'traits', 'icon', 'users'].
    forEach(function (key) {
        if (image[key] !== undefined) {
            image[key] = JSON.parse(image[key]);
        }
    });

    if (image.tags) {
        image.tags = objectToArray(image.tags);
        delete image.tag;
    }
    if (image.billingtag) {
        image.billing_tags = image.billingtag;
        delete image.billingtag;
    }

    return image;
}


function migrateImage(image, callback) {
    image = toNewImage(image);

    if (config.database.type === 'moray') {
        morayClient.getObject('imgapi_images', image.uuid, function (err, obj) {
            if (err) {
                // Only migrate images that don't exist on moray
                if (err.name === 'ObjectNotFoundError') {
                    info('migrate "%s"', image.uuid);
                    return morayClient.putObject('imgapi_images', image.uuid,
                        image, callback);
                } else {
                    return callback(err);
                }
            }

            //info('image "%s" already exists on moray', image.uuid);
            return callback();
        });
    } else {
        info('migrate "%s"', image.uuid);
        var dbPath = path.resolve(config.database.dir, image.uuid + '.raw');
        var content = JSON.stringify(image, null, 2);
        fs.writeFile(dbPath, content, 'utf8', function (err) {
            if (err) {
                return callback(err);
            }

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
}

function morayMigrate(callback) {
    assert.equal(config.database.type, 'moray');
    getUfdsClient(function (err, client) {
        if (err)
            return callback(err);
        ufdsClient = client; // intentionally global

        getMorayClient(function (mclient) {
            morayClient = mclient;

            ufdsListImages(function (err2, images) {
                if (err2)
                    return callback(err2);
                info('%d images to potentially migrate', images.length);
                async.forEachSeries(images, migrateImage, callback);
            });
        });
    });
}


function localListImages(callback) {
    /*JSSTYLED*/
    var RAW_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.raw$/;
    fs.readdir(config.database.dir, function (err, files) {
        var images = [];
        async.forEachSeries(
            files,
            function oneFile(file, next) {
                if (!RAW_FILE_RE.test(file))
                    return next();
                var path_ = path.resolve(config.database.dir, file);
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
    assert.equal(config.database.type, 'local');
    localListImages(function (err, images) {
        if (err)
            return callback(err);
        async.forEachSeries(images, migrateImage, callback);
    });
}



//---- mainline

function main(argv) {
    assert.object(config.database, 'config.database');
    assert.object(config.database, 'config.database');
    var migrator = (config.database.type === 'moray' ? morayMigrate
                                                     : localMigrate);
    migrator(function (err) {
        if (err) {
            errexit(err);
        } else {
            process.exit(0);
        }
    });
}

if (require.main === module) {
    main(process.argv);
}
