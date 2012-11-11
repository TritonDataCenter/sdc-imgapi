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
        t.equal(image.uuid, uuid, 'image.uuid');
        t.end();
    });
});


/**
 * Simple CreateImage scenario:
 * - luke creates a public one
 * - adds an image file
 * - activates it
 * - ensure all can see it
 */
var vader = '86055c40-2547-11e2-8a6b-4bb37edc84ba';
var luke = '91ba0e64-2547-11e2-a972-df579e5fddb3';
var emperor = 'a0b6b534-2547-11e2-b758-63a2afd747d1';
var sdc = 'ba28f844-8cb4-f141-882d-46d6251e6a9f';
var what_a_piece_of_junk;
test('CreateImage', function (t) {
    var data = {
        name: 'what-a-piece-of-junk',
        description: 'Describing the Millenium Falcon.',
        os: 'smartos',
        type: 'zone-dataset',
        public: 'true'
    };

    var self = this;
    var filePath = __dirname + '/what_a_piece_of_junk.zfs.bz2';
    var uuid;
    var size;
    var sha1;
    var aImage;

    function create(next) {
        self.client.createImage(data, luke, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            uuid = image.uuid;
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
        var sha1sum = crypto.createHash('sha1');
        var s = fs.createReadStream(filePath);
        s.on('data', function (d) { sha1sum.update(d); });
        s.on('end', function () {
            sha1 = sha1sum.digest('hex');
            next();
        });
    }
    function addFile(next) {
        self.client.addImageFile(uuid, filePath, luke,
            function (err, image, res) {
                t.ifError(err, err);
                t.ok(image);
                t.equal(image.files.length, 1, 'image.files');
                t.equal(image.files[0].sha1, sha1, 'image.files.0.sha1');
                t.equal(image.files[0].size, size, 'image.files.0.size');
                next(err);
            }
        );
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
    function getImage(next) {
        self.client.getImage(uuid, luke, function (err, image, res) {
            t.ifError(err, err);
            t.equal(JSON.stringify(aImage), JSON.stringify(image), 'matches');
            next();
        });
    }
    function getFile(next) {
        self.client.getImageFile(uuid, '/var/tmp/foo.zfs.bz2', luke, function (err, res) {
            t.ifError(err, err);
            //XXX START HERE
            // - test checksum of headers
            // - test sha1 content
            // - real filePath to which to download
            next();
        });
    }

    async.series(
        [
            create,
            getSize,
            getSha1,
            addFile,
            activate,
            getImage,
            getFile
        ],
        function (err) {
            t.end();
        }
    );
});
