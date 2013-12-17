#!/usr/bin/env node
/*
 * IMGAPI db migration: adds guid field to every image files object.
 */

var p = console.log;
var fs = require('fs');
var path = require('path');
var ldap = require('ldapjs');
var errors = require('../errors');
var assert = require('assert-plus');
var async = require('async');
var passwd = require('passwd');
var format = require('util').format;
var execFile = require('child_process').execFile;


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
var ufdsClient = null;  // set in `getUfdsClient()`
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
        // Use this filter to only do (or perhaps on do *first*) public images:
        //  filter: '(&(objectclass=sdcimage)(disabled=false)(!(tag=smartdc_service=true))(public=true))',
        filter: '(&(objectclass=sdcimage)(disabled=false)(!(tag=smartdc_service=true)))',
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


var _nobodyCache = undefined;
function getNobody(callback) {
    if (_nobodyCache !== undefined)
        return callback(_nobodyCache);

    passwd.get('nobody', function (nobody) {
        _nobodyCache = nobody;
        callback(_nobodyCache);
    });
}


function getDatasetGuid(image, files, callback) {
    var guid;
    var execArgs = [IMGAPI_URL, image.uuid, files[0].compression || 'none'];

    execFile(GUID_SCRIPT, execArgs, function (err, stdout, stderr) {
        if (err) {
            return callback(err);
        } else {
            guid = bigDecimalFromHex(stdout.toString().replace(/\n|\r/g, ''));
            return callback(null, guid);
        }
    });
}


/**
 * From <http://stackoverflow.com/questions/12532871>
 * "How to convert a very large hex number to decimal in javascript"
 */
function bigDecimalFromHex(inputHex) {
    function add(x, y) {
        var c = 0, r = [];
        x = x.split('').map(Number);
        y = y.split('').map(Number);
        while (x.length || y.length) {
            var hex = (x.pop() || 0) + (y.pop() || 0) + c;
            r.unshift(hex < 10 ? hex : hex - 10);
            c = hex < 10 ? 0 : 1;
        }
        if (c) r.unshift(c);
        return r.join('');
    }

    var dec = '0';
    inputHex.split('').forEach(function (chr) {
        var n = parseInt(chr, 16);
        for (var t = 8; t; t >>= 1) {
            dec = add(dec, dec);
            if (n & t) dec = add(dec, '1');
        }
    });

    return dec;
}


function migrateImage(image, callback) {
    var id = (config.database.type === 'ufds' ? image.dn
        : image.uuid + '.raw');
    var files = image.files;
    if (!files)
        return callback();
    files = JSON.parse(files);
    if (files && files[0] && files[0].dataset_guid)
        return callback();

    info('migrate "%s"', id);
    getDatasetGuid(image, files, function (gerr, guid) {
        if (gerr) {
            return callback(gerr);
        } else if (!guid) {
            return callback();
        }

        files[0].dataset_guid = guid;
        // Rename it to tags and make it an array and not a stringified object
        if (config.database.type === 'ufds') {
            var changes = [ {
                operation: 'replace',
                modification: { files: JSON.stringify(files) }
            } ];
            ufdsClient.modify(image.dn, changes, callback);
        } else {
            image.files = JSON.stringify(files);
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
                    fs.chown(dbPath, Number(nobody.userId), Number(nobody.groupId), callback);
                });
            });
        }
    });
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
            info('%d images to potentially migrate', images.length);
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
