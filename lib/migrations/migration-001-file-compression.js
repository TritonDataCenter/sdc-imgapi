#!/usr/bin/env node
/*
 * IMGAPI UFDS db migration: add required files.*.compression field
 */

var fs = require('fs');
var path = require('path');
var ldap = require('ldapjs');
var errors = require('../errors');
var assert = require('assert-plus');
var async = require('async');



//---- globals

var NAME = path.basename(__filename);
var config = JSON.parse(fs.readFileSync('/opt/smartdc/imgapi/etc/imgapi.config.json'));
var ufdsClient = null;  // set in `getUfdsClient()`



//---- support functions

function getUfdsClient(callback) {
	var client = ldap.createClient({
		url: config.database.url,
		connectTimeout: 2 * 1000
	});
	client.bind(config.database.rootDn, config.database.password,
                    function (bErr) {
                        if (bErr) {
                            return callback(bErr);
                        }
                        return callback(null, client);
                    }
                );
}

function listImages(callback) {
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

function migrateImage(image, callback) {
	var files = image.files;
	if (!files)
		return callback();
	try {
		files = JSON.parse(files);
	} catch (ex) {
		warn('cannot migrate "%s": "files" is invalid JSON: %s', image.dn, files);
		return callback();
	}
	var file = files[0];
	if (!file)
		return callback();
	if (file.compression)
		return callback();
	info('migrate "%s"', image.dn);
	// This is a bad *HACK*: just presuming 'bzip2' because most (all?) our
	// current ones use bzip2 compression. Right answer is to sniff the magic
	// number of the actual file.
	file.compression = 'bzip2';
	var changes = {
		operation: 'replace',
		modification: {
			files: JSON.stringify(files)
		}
	};
	ufdsClient.modify(image.dn, changes, callback);
}



//---- mainline

function main(argv) {
    assert.object(config.database, 'config.database');
    assert.equal(config.database.type, 'ufds', 'this is a ufds-using IMGAPI');

	getUfdsClient(function (err, client) {
		if (err) errexit(err);
		ufdsClient = client; // intentionally global
		listImages(function (err2, images) {
			async.forEachSeries(images, migrateImage, function done(err) {
				if (err) errexit(err);
				process.exit(0);
			});
		});
	});
}

if (require.main === module) {
	main(process.argv);
}
