/*
 * Copyright (c) 2012 Joyent Inc. All rights reserved.
 *
 * Test basic /images endpoints.
 */

var format = require('util').format;
var crypto = require('crypto');
var fs = require('fs');
var async = require('async');
//var IMGAPI = require('sdc-clients').IMGAPI;   // temp broken by TOOLS-211
var IMGAPI = require('sdc-clients/lib/imgapi');


// node-tap API
if (require.cache[__dirname + '/tap4nodeunit.js'])
    delete require.cache[__dirname + '/tap4nodeunit.js'];
var tap4nodeunit = require('./tap4nodeunit.js');
var after = tap4nodeunit.after;
var before = tap4nodeunit.before;
var test = tap4nodeunit.test;



//---- tests

before(function (next) {
    this.client = new IMGAPI({url: process.env.IMGAPI_URL});
    next();
});



test('ListImages returns a list', function (t) {
    this.client.listImages(function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.ok(Array.isArray(images), 'images');
        t.end();
    })
});

test('GetImage 404', function (t) {
    var bogus = '3560c262-fc65-0242-a446-7c6d1fb482e3';
    this.client.getImage(bogus, function (err, image, res) {
        t.ok(err, 'GetImage 404 error');
        t.notOk(image, 'image');
        t.equal(err.statusCode, 404, 'err.statusCode 404');
        t.equal(err.body.code, 'ResourceNotFound', 'body.code');
        t.ok(err.body.message, 'res body has a message');
        t.equal(res.statusCode, 404, 'res.statusCode 404');
        t.end();
    })
});

test('GetImage existing', function (t) {
    var uuid = 'c58161c0-2547-11e2-a75e-9fdca1940570'; // our test base-1.8.1
    this.client.getImage(uuid, function (err, image, res) {
        t.ifError(err, err);
        t.ok(image, 'image');
        if (image) {
            t.equal(image.uuid, uuid, 'image.uuid');
        }
        t.end();
    });
});


/**
 * Simple CreateImage scenario:
 * - luke creates a public one
 * - adds an image file
 * - activates it
 * - ensure others (e.g. vader) can see it
 * - update it
 * - adds an icon
 * ...
 * - clean up: delete it
 */
var vader = '86055c40-2547-11e2-8a6b-4bb37edc84ba';
var luke = '91ba0e64-2547-11e2-a972-df579e5fddb3';
var emperor = 'a0b6b534-2547-11e2-b758-63a2afd747d1';
var sdc = 'ba28f844-8cb4-f141-882d-46d6251e6a9f';
var what_a_piece_of_junk;
test('CreateImage', function (t) {
    var data = {
        name: 'what-a-piece-of-junk',
        version: '1.0.0',
        description: 'Describing the Millenium Falcon.',
        os: 'smartos',
        type: 'zone-dataset',
        public: true,
        requirements: { min_platform: [['7.0', '2012-12-24']] },
        billing_tags: ['oracle'],
        traits: { foo: "bar", ssd: true },
        homepage: 'http://images.com/v1.html'
    };

    var self = this;
    var filePath = __dirname + '/what_a_piece_of_junk.zfs.bz2';
    var iconPath = __dirname + '/icon.jpg';
    var fileCompression = 'bzip2';
    var uuid;
    var size, iconSize;
    var sha1, iconSha1;
    var md5, iconMd5;
    var aImage;

    function create(next) {
        self.client.createImage(data, luke, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            if (image) {
                uuid = image.uuid;
            }
            next(err);
        });
    }
    function getSize(next) {
        fs.stat(filePath, function (err, stats) {
            if (err)
                return next(err);
            size = stats.size;
            next();
        });
    }
    function getSha1(next) {
        var hash = crypto.createHash('sha1');
        var s = fs.createReadStream(filePath);
        s.on('data', function (d) { hash.update(d); });
        s.on('end', function () {
            sha1 = hash.digest('hex');
            next();
        });
    }
    function getMd5(next) {
        var hash = crypto.createHash('md5');
        var s = fs.createReadStream(filePath);
        s.on('data', function (d) { hash.update(d); });
        s.on('end', function () {
            md5 = hash.digest('base64');
            next();
        });
    }
    function addFile(next) {
        var fopts = {uuid: uuid, file: filePath, compression: fileCompression};
        self.client.addImageFile(fopts, luke, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.files.length, 1, 'image.files');
            t.equal(image.files[0].sha1, sha1, 'image.files.0.sha1');
            t.equal(image.files[0].size, size, 'image.files.0.size');
            next(err);
        });
    }
    function activate(next) {
        self.client.activateImage(uuid, luke, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.state, 'active');
            aImage = image;
            next();
        });
    }
    function disable(next) {
        self.client.disableImage(uuid, luke, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.disabled, true);
            aImage = image;
            next();
        });
    }
    function enable(next) {
        self.client.enableImage(uuid, luke, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.disabled, false);
            aImage = image;
            next();
        });
    }
    function update(next) {
        var mod = { description: 'awesome image'};
        self.client.updateImage(uuid, mod, luke, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.description, 'awesome image');
            aImage = image;
            next();
        });
    }
    function addAcl(next) {
        var acl = ['91ba0e64-2547-11e2-a972-df579e5fddb3'];
        self.client.addImageAcl(uuid, acl, luke, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.acl[0], acl[0]);
            aImage = image;
            next();
        });
    }
    function removeAcl(next) {
        var acl = ['91ba0e64-2547-11e2-a972-df579e5fddb3'];
        self.client.removeImageAcl(uuid, acl, luke, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.ok(!image.acl);
            aImage = image;
            next();
        });
    }
    function getIconSize(next) {
        fs.stat(iconPath, function (err, stats) {
            if (err)
                return next(err);
            iconSize = stats.size;
            next();
        });
    }
    function getIconSha1(next) {
        var hash = crypto.createHash('sha1');
        var s = fs.createReadStream(iconPath);
        s.on('data', function (d) { hash.update(d); });
        s.on('end', function () {
            iconSha1 = hash.digest('hex');
            // console.log(iconSha1);
            // process.exit(0);
            next();
        });
    }
    function getIconMd5(next) {
        var hash = crypto.createHash('md5');
        var s = fs.createReadStream(iconPath);
        s.on('data', function (d) { hash.update(d); });
        s.on('end', function () {
            iconMd5 = hash.digest('base64');
            next();
        });
    }
    function addIcon(next) {
        var fopts = {
            uuid: uuid, file: iconPath, contentType: 'image/jpeg'
        };
        self.client.addImageIcon(fopts, luke, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.ok(image.icon);
            aImage = image;
            next(err);
        });
    }
    function getImage(next) {
        self.client.getImage(uuid, vader, function (err, image, res) {
            t.ifError(err, err);
            t.equal(JSON.stringify(aImage), JSON.stringify(image), 'matches');
            next();
        });
    }
    function getFile(next) {
        var tmpFilePath = format('/var/tmp/imgapi-test-file-%s.zfs.bz2',
            process.pid);
        self.client.getImageFile(uuid, tmpFilePath, vader, function (err, res) {
            t.ifError(err, err);
            if (err) {
                return next(err);
            }
            t.equal(md5, res.headers['content-md5'], 'md5');
            var hash = crypto.createHash('sha1');
            var s = fs.createReadStream(tmpFilePath);
            s.on('data', function (d) { hash.update(d); });
            s.on('end', function () {
                var actual_sha1 = hash.digest('hex');
                t.equal(sha1, actual_sha1, 'sha1 matches upload');
                t.equal(aImage.files[0].sha1, actual_sha1,
                    'sha1 matches image data');
                next();
            });
        });
    }
    function getIcon(next) {
        var tmpFilePath = format('/var/tmp/imgapi-test-icon-%s.jpg',
            process.pid);
        self.client.getImageIcon(uuid, tmpFilePath, vader, function (err, res) {
            t.ifError(err, err);
            if (err) {
                return next(err);
            }
            console.log('wants md5 ' + iconMd5);
            console.log('wants sha1 ' + iconSha1);
            t.equal(iconMd5, res.headers['content-md5'], 'md5');
            var hash = crypto.createHash('sha1');
            var s = fs.createReadStream(tmpFilePath);
            s.on('data', function (d) { hash.update(d); });
            s.on('end', function () {
                var actual_sha1 = hash.digest('hex');
                t.equal(iconSha1, actual_sha1, 'sha1 matches icon upload');
                next();
            });
        });
    }
    function deleteIcon(next) {
        self.client.deleteImageIcon(uuid, vader, function (err, image, res) {
            t.ifError(err, err);
            t.ok(!(image.icon), 'no icon');
            next();
        });
    }
    function deleteImage(next) {
        self.client.deleteImage(uuid, luke, function (err, res) {
            t.ifError(err, err);
            if (err) {
                return next(err);
            }
            t.equal(res.statusCode, 204, 'res.statusCode 204');
            next();
        });
    }

    async.series(
        [
            create,
            getSize,
            getSha1,
            getMd5,
            addFile,
            activate,
            disable,
            enable,
            update,
            addAcl,
            removeAcl,
            getIconSize,
            getIconSha1,
            getIconMd5,
            addIcon,
            getImage,
            getFile,
            getIcon,
            deleteIcon,
            deleteImage
        ],
        function (err) {
            t.end();
        }
    );
});
