/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Test the AdminImportLxdImage endpoint.
 */

var format = require('util').format;
var crypto = require('crypto');
var fs = require('fs');

var async = require('async');
var restify = require('restify');
var IMGAPI = require('sdc-clients').IMGAPI;


// node-tap API
if (require.cache[__dirname + '/tap4nodeunit.js'])
    delete require.cache[__dirname + '/tap4nodeunit.js'];
var tap4nodeunit = require('./tap4nodeunit.js');
var after = tap4nodeunit.after;
var before = tap4nodeunit.before;
var test = tap4nodeunit.test;
function skiptest() {} // quick hack to comment out a test



//---- globals

var actionParam = 'action=import-lxd-image';
var LXD_FTYPE_COMBINED_IMAGE = 'lxd_combined.tar.gz';
var LXD_IMAGE_ALIAS = 'alpine/3.12';
var LXD_IMAGE_REF = 'images:' + LXD_IMAGE_ALIAS;
var vader = '86055c40-2547-11e2-8a6b-4bb37edc84ba';


function getRestifyClient() {
    var client = restify.createJsonClient({
        url: process.env.IMGAPI_URL,
        agent: false
    });

    return client;
}

function getImgapiClient() {
    return new IMGAPI({url: process.env.IMGAPI_URL, agent: false});
}

//---- tests

test('AdminImportLxdImage should 422 when no alias is provided', function (t) {
    var client = getRestifyClient();
    var path = '/images?' + actionParam;
    var data = {};
    client.post(path, data, function (err) {
        t.ok(err, 'got an error');
        t.equal(err.statusCode, 422, 'err.statusCode');
        t.equal(err.body.code, 'ValidationFailed', 'err.body.code');
        t.ok(err.body.message);
        t.end();
    });
});

test('AdminImportLxdImage should fail if called for a user', function (t) {
    var client = getRestifyClient();
    var data = {alias: LXD_IMAGE_REF};
    var path = format('/images?%s&account=%s', actionParam, vader);
    client.post(path, data, function (err, req, res, body) {
        t.ok(err, 'got an error');
        t.equal(err.statusCode, 403, 'err.statusCode');
        t.equal(body.code, 'OperatorOnly', 'body.code');
        t.ok(body.message);
        t.end();
    });
});

/**
 * AdminImportLxdImage scenario from a lxd image server. These steps happen
 * inside IMGAPI:
 * - get lxd image manifest from lxd-image-server/images/:uuid
 * - CreateImage with downloaded lxd manifest
 * - AddImageFile *stream* from lxd-image-server/images/:uuid/file0
 * - AddImageFile *stream* from lxd-image-server/images/:uuid/file1
 * - ActivateImage
 */
if (!process.env.IMGAPI_TEST_OFFLINE)
test('AdminImportLxdImage from registry', function (t) {
    var aImage;
    var client = getRestifyClient();
    var imgapi = getImgapiClient();


    function importRemote(next) {
        var path = '/images?' + actionParam + '&alias=' + LXD_IMAGE_REF;
        client.post(path, {}, function (err, req, res) {
            t.ifError(err, err);
            next(err);
        });
    }


    function getImage(next) {
        var filters = {
            type: 'lxd'
        };
        imgapi.listImages(filters, function (err, images) {
            t.ifError(err, err);
            if (err) {
                next(err);
                return;
            }

            var image = images.find(function _findImage(img) {
                var aliases = (img.tags['lxd:aliases'] || '').split(',');
                return aliases.indexOf(LXD_IMAGE_ALIAS) >= 0;
            });

            t.ok(image);
            if (!image) {
                next(new Error('No lxd image with alias: ' + LXD_IMAGE_ALIAS));
                return;
            }

            aImage = image;
            t.ok(image.uuid);
            t.ok(image.published_at);
            t.equal(image.state, 'active');
            t.equal(image.type, 'lxd');

            var files = image.files;
            t.ok(Array.isArray(files), 'Array.isArray(files)');
            t.ok(files.length >= 1, 'Should be at least one image file');

            if (image.tags['lxd:ftype'] === LXD_FTYPE_COMBINED_IMAGE) {
                t.equal(files.length, 1,
                    'a combined lxd image should only have one file');
            } else {
                t.equal(files.length, 2, 'lxd image should have two files');
            }

            next();
        });
    }


    function getFile(index, next) {
        var tmpFilePath = format('/var/tmp/imgapi-test-file%d-%s.xz',
            index, process.pid);
        var opts = {index: index};
        imgapi.getImageFile(aImage.uuid, tmpFilePath, null, opts,
                function (err) {
            t.ifError(err, err);
            if (err) {
                next(err);
                return;
            }
            var hash = crypto.createHash('sha1');
            var s = fs.createReadStream(tmpFilePath);
            s.on('data', function (d) { hash.update(d); });
            s.on('error', function (streamErr) { next(streamErr); });
            s.on('end', function () {
                var actual_sha1 = hash.digest('hex');
                t.equal(aImage.files[index].sha1, actual_sha1,
                    'sha1 matches image data');
                next();
            });
        });
    }


    function getFile1(next) {
        getFile(0, next);
    }


    function getFile2(next) {
        if (aImage.tags['lxd:ftype'] === LXD_FTYPE_COMBINED_IMAGE) {
            next();
            return;
        }
        getFile(1, next);
    }


    function deleteImage(next) {
        var path = format('/images/%s', aImage.uuid);
        client.del(path, function (err, req, res) {
            t.ifError(err, err);
            if (err) {
                next(err);
                return;
            }
            t.equal(res.statusCode, 204, 'res.statusCode 204');
            next();
        });
    }


    async.series(
        [
            importRemote,
            getImage,
            getFile1,
            getFile2,
            deleteImage
        ],
        function (err) {
            if (err) {
                t.ok(false, 'Error: ' + err);
            }
            t.end();
        }
    );
});
