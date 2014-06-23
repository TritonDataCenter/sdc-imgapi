#!/usr/bin/env node
/*
 * IMGAPI db migration: renames the 'tags' field to separate flag 'tag'
 * fields.
 */

var p = console.log;
var fs = require('fs');
var path = require('path');
var ldap = require('ldapjs');
var errors = require('../errors');
var assert = require('assert-plus');
var async = require('async');
var passwd = require('passwd');



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
var config = JSON.parse(fs.readFileSync(CONFIG_PATH));
var ufdsClient = null;  // set in `getUfdsClient()`




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
        connectTimeout: 2 * 1000
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


function objectToTag(obj) {
    if (typeof (obj) === 'string') {
        obj = JSON.parse(obj);
    }

    var values = [];
    Object.keys(obj).forEach(function (key) {
        var value = key + '=' + obj[key];
        values.push(value);
    });

    return values;
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
    var id = (config.database.type === 'ufds' ? image.dn
        : image.uuid + '.raw');
    var tags = image.tags;
    if (!tags)
        return callback();
    info('migrate "%s"', id);

    // Rename it to tags and make it an array and not a stringified object
    if (config.database.type === 'ufds') {
        var changes = [ {
            operation: 'add',
            modification: { tag: objectToTag(tags) }
        }, {
            operation: 'delete',
            modification: { tags: tags }
        } ];
        ufdsClient.modify(image.dn, changes, callback);
    } else {
        if (tags.length > 0) {
            image.tag = objectToTag(image.tags);
        }
        delete image.tags;
        var dbPath = path.resolve(config.database.dir, image.uuid + '.raw');
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
}

function ufdsMigrate(callback) {
    assert.equal(config.database.type, 'ufds');
    getUfdsClient(function (err, client) {
        if (err)
            return callback(err);
        ufdsClient = client; // intentionally global
        ufdsListImages(function (err2, images) {
            if (err2)
                return callback(err2);
            async.forEachSeries(images, migrateImage, callback);
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
    var migrator = (config.database.type === 'ufds'
        ? ufdsMigrate : localMigrate);
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
