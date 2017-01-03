/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * Test AdminImportImage endpoint.
 */

var format = require('util').format;
var exec = require('child_process').exec;
var crypto = require('crypto');
var fs = require('fs');
var dns = require('dns');
var https = require('https');
var async = require('async');
var restify = require('restify');
//var IMGAPI = require('sdc-clients').IMGAPI;   // temp broken by TOOLS-211
var IMGAPI = require('sdc-clients/lib/imgapi');
var DSAPI = require('sdc-clients/lib/dsapi');


// node-tap API
if (require.cache[__dirname + '/tap4nodeunit.js'])
    delete require.cache[__dirname + '/tap4nodeunit.js'];
var tap4nodeunit = require('./tap4nodeunit.js');
var after = tap4nodeunit.after;
var before = tap4nodeunit.before;
var test = tap4nodeunit.test;
function skiptest() {} // quick hack to comment out a test



//---- globals

var vader = '86055c40-2547-11e2-8a6b-4bb37edc84ba';
var luke = '91ba0e64-2547-11e2-a972-df579e5fddb3';
var sdc = 'ba28f844-8cb4-f141-882d-46d6251e6a9f';


//---- tests

before(function (next) {
    this.client = new IMGAPI({url: process.env.IMGAPI_URL, agent: false});
    next();
});


test('AdminImportImage should fail if called for a user', function (t) {
    // Use a raw restify client. The IMGAPI client doesn't allow this
    // erroneous call.
    var client = restify.createJsonClient({
        url: process.env.IMGAPI_URL,
        agent: false
    });
    var path = '/images/2e8a7f4d-4a38-0844-a489-3cd1ae25a5c8' +
        '?action=import&account=8d89dfe9-5cc7-6648-8ff7-50fa8bba1352';
    var data = {};
    client.post(path, data, function (err, req, res, body) {
        t.ok(err, 'got an error');
        t.equal(err.statusCode, 403, 'err.statusCode');
        t.equal(body.code, 'OperatorOnly', 'body.code');
        t.ok(body.message);
        t.end();
    });
});

test('AdminImportImage should error on UUID mismatch', function (t) {
    // Use a raw restify client. The IMGAPI client doesn't allow this
    // erroneous call.
    var client = restify.createJsonClient({
        url: process.env.IMGAPI_URL,
        agent: false
    });
    var uuid = '43302fc6-9595-e94b-9166-039b0acda443';
    var data = {
        uuid: '83379eba-0ab1-4541-b82a-6d1d4701ec6d'
    };
    var path = format('/images/%s?action=import', uuid);
    client.post(path, data, function (err, req, res, body) {
        t.ok(err, 'got an error');
        t.equal(err.statusCode, 422, 'err.statusCode');
        t.equal(err.body.code, 'InvalidParameter', 'err.body.code');
        t.ok(err.body.message);
        t.equal(err.body.errors.length, 1, 'err.body has "errors" array');
        t.equal(err.body.errors[0].field, 'uuid', 'err.body.errors[0].field');
        t.end();
    });
});

test('AdminImportImage should fail if UUID already exists', function (t) {
    var data = {
        v: 2,
        uuid: 'c58161c0-2547-11e2-a75e-9fdca1940570', // from test-data.ldif
        published_at: (new Date()).toISOString(),
        name: 'base',
        version: '1.8.1',
        type: 'zone-dataset',
        os: 'smartos',
        owner: 'ba28f844-8cb4-f141-882d-46d6251e6a9f'
    };
    this.client.adminImportImage(data, function (err, image, res) {
        t.ok(err, 'got an error: ' + err);
        t.equal(err.statusCode, 409, 'err.statusCode');
        t.equal(err.body.code, 'ImageUuidAlreadyExists', 'err.body.code');
        t.ok(err.body.message);
        t.end();
    });
});

test('AdminImportImage should 404 on bogus UUID', function (t) {
    var data = {uuid: '3dae5131', foo: 'bar'}; // bogus UUID
    this.client.adminImportImage(data, function (err, image, res) {
        t.ok(err, 'got an error');
        t.equal(err.statusCode, 404, 'err.statusCode');
        t.equal(err.body.code, 'ResourceNotFound', 'err.body.code');
        t.ok(err.body.message);
        t.end();
    });
});

/**
 * AdminImportImage scenario: zone-dataset manifest local file
 * - AdminImportImage from local imgmanifest file
 * - AddImageFile from local file
 * - ActivateImage
 * - GetImage, GetImageFile checks
 * - clean up: delete it
 */
test('AdminImportImage from local .imgmanifest', function (t) {
    var self = this;
    var data = JSON.parse(
        fs.readFileSync(__dirname + '/fauxnodejs-1.4.0.imgmanifest', 'utf8'));
    var uuid = data.uuid;
    var filePath = __dirname + '/fauxnodejs-1.4.0.zfs.bz2';
    var fileCompression = 'bzip2';
    var size;
    var sha1;
    var md5;
    var aImage;

    function create(next) {
        self.client.adminImportImage(data, function (err, image, res) {
            t.ifError(err);
            t.ok(image, 'got an image object');
            if (image) {
                t.equal(image.uuid, data.uuid, 'expected image.uuid matched');
                t.equal(image.published_at, data.published_at,
                    'expected image.published_at matched');
                t.equal(image.state, 'unactivated',
                    'image.state is unactivated');
                t.equal(image.inherited_directories.join(','),
                    data.inherited_directories.join(','),
                    'expected inherited_directories matched');
                t.ok(image.billing_tags, 'have image.billing_tags');
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
        self.client.addImageFile(fopts, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            if (image) {
                t.equal(image.files.length, 1, 'image.files');
                t.equal(image.files[0].sha1, sha1, 'image.files.0.sha1');
                t.equal(image.files[0].size, size, 'image.files.0.size');
            }
            next(err);
        });
    }
    function activate(next) {
        self.client.activateImage(uuid, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.state, 'active');
            aImage = image;
            next();
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
    function deleteImage(next) {
        self.client.deleteImage(uuid, function (err, res) {
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
            getImage,
            getFile,
            deleteImage
        ],
        function (err) {
            t.end();
        }
    );
});

/**
 * AdminImportImage scenario: zone-dataset dsmanifest local file
 * - AdminImportImage from local dsmanifest file
 * - AddImageFile from local file
 * - ActivateImage
 * - GetImage, GetImageFile checks
 * - clean up: delete it
 */
test('AdminImportImage from local .dsmanifest', function (t) {
    var self = this;
    var data = JSON.parse(
        fs.readFileSync(__dirname + '/fauxnodejs-1.4.0.dsmanifest', 'utf8'));
    var uuid = data.uuid;
    var filePath = __dirname + '/fauxnodejs-1.4.0.zfs.bz2';
    var fileCompression = 'bzip2';
    var size;
    var sha1;
    var md5;
    var aImage;

    function create(next) {
        var iOpts = {skipOwnerCheck: true};
        self.client.adminImportImage(data, iOpts, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            if (image) {
                t.equal(image.uuid, data.uuid);
                t.equal(image.published_at, data.published_at);
                t.equal(image.state, 'unactivated');
                t.equal(image.inherited_directories.join(','),
                    data.inherited_directories.join(','),
                    'inherited_directories');
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
        self.client.addImageFile(fopts, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.files.length, 1, 'image.files');
            t.equal(image.files[0].sha1, sha1, 'image.files.0.sha1');
            t.equal(image.files[0].size, size, 'image.files.0.size');
            next(err);
        });
    }
    function activate(next) {
        self.client.activateImage(uuid, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.state, 'active');
            aImage = image;
            next();
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
    function deleteImage(next) {
        self.client.deleteImage(uuid, function (err, res) {
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
            getImage,
            getFile,
            deleteImage
        ],
        function (err) {
            t.end();
        }
    );
});


/**
 * AdminImportImage scenario: zvol dsmanifest local file
 * - AdminImportImage from local dsmanifest file
 * - AddImageFile from local file
 * - ActivateImage
 * - GetImage, GetImageFile checks
 * - clean up: delete it
 */
test('AdminImportImage zvol from local .dsmanifest', function (t) {
    var self = this;
    var data = JSON.parse(
        fs.readFileSync(__dirname + '/fauxubuntu.dsmanifest', 'utf8'));
    var uuid = data.uuid;
    var filePath = __dirname + '/fauxubuntu.zfs.bz2';
    var fileCompression = 'bzip2';
    var size;
    var sha1;
    var md5;
    var aImage;

    function create(next) {
        var iOpts = {skipOwnerCheck: true};
        self.client.adminImportImage(data, iOpts, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            if (image) {
                t.equal(image.uuid, data.uuid);
                t.equal(image.published_at, data.published_at);
                t.notOk(image.created_at);
                t.equal(image.disk_driver, data.disk_driver);
                t.equal(image.state, 'unactivated');
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
        self.client.addImageFile(fopts, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.files.length, 1, 'image.files');
            t.equal(image.files[0].sha1, sha1, 'image.files.0.sha1');
            t.equal(image.files[0].size, size, 'image.files.0.size');
            next(err);
        });
    }
    function activate(next) {
        self.client.activateImage(uuid, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.state, 'active');
            aImage = image;
            next();
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
    function deleteImage(next) {
        self.client.deleteImage(uuid, function (err, res) {
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
            getImage,
            getFile,
            deleteImage
        ],
        function (err) {
            t.end();
        }
    );
});


/**
 * AdminImportImage scenario from images.joyent.com:
 * - get manifest from images.joyent.com/images/:uuid
 * - AdminImportImage with that manifest
 * - AddImageFile *stream* from images.joyent.com/images/:uuid/file
 * - ActivateImage
 * - GetImage, GetImageFile checks
 * - clean up: delete it
 */
if (!process.env.IMGAPI_TEST_OFFLINE)
test('AdminImportImage from images.joyent.com', function (t) {
    var self = this;
    // Pick a small one: minimal-32@15.2.0
    var uuid = '0764d78e-3472-11e5-8949-4f31abea4e05';
    var manifest;
    var filePath = format('/var/tmp/image-test-file-%s.zfs.bz2', process.pid);
    var fileCompression = 'bzip2';
    var size;
    var sha1;
    var md5;
    var aImage;

    var imagesClient = new IMGAPI({
        url: 'https://images.joyent.com',
        agent: false
    });

    function getManifestFromImagesJo(next) {
        imagesClient.getImage(uuid, function (err, image) {
            t.ifError(err, err);
            t.ok(image);
            manifest = image;
            next();
        });
    }
    function getFileFromImagesJo(next) {
        imagesClient.getImageFile(uuid, filePath, function (err, res) {
            t.ifError(err, err);
            if (err) {
                return next(err);
            }
            var sha1hash = crypto.createHash('sha1');
            var md5hash = crypto.createHash('md5');
            size = 0;
            var s = fs.createReadStream(filePath);
            s.on('data', function (d) {
                sha1hash.update(d);
                md5hash.update(d);
                size += d.length;
            });
            s.on('end', function () {
                sha1 = sha1hash.digest('hex');
                md5 = md5hash.digest('base64');
                t.equal(md5, res.headers['content-md5'], 'md5');
                t.equal(sha1, manifest.files[0].sha1,
                    'sha1 matches manifest data');
                t.equal(size, manifest.files[0].size,
                    'size matches manifest data');
                next();
            });
        });
    }
    function create(next) {
        self.client.adminImportImage(manifest, {}, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            if (image) {
                t.equal(image.uuid, manifest.uuid);
                t.equal(image.published_at, manifest.published_at);
                t.equal(image.state, 'unactivated');
            }
            next(err);
        });
    }
    function addFile(next) {
        var fopts = {uuid: uuid, file: filePath, compression: fileCompression};
        self.client.addImageFile(fopts, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.files.length, 1, 'image.files');
            t.equal(image.files[0].sha1, sha1, 'image.files.0.sha1');
            t.equal(image.files[0].size, size, 'image.files.0.size');
            next(err);
        });
    }
    function activate(next) {
        self.client.activateImage(uuid, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.state, 'active');
            aImage = image;
            next();
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
    function deleteImage(next) {
        self.client.deleteImage(uuid, function (err, res) {
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
            getManifestFromImagesJo,
            getFileFromImagesJo,
            create,
            addFile,
            activate,
            getImage,
            getFile,
            deleteImage
        ],
        function (err) {
            t.end();
        }
    );
});


/**
 * AdminImportImage scenario from datasets.joyent.com:
 * - get manifest from datasets.joyent.com/datasets/:uuid
 * - AdminImportImage with that manifest
 * - AddImageFile *stream* from file URL from the dsmanifest
 * - ActivateImage
 * - GetImage, GetImageFile checks
 * - clean up: delete it
 */
if (!process.env.IMGAPI_TEST_OFFLINE)
test('AdminImportImage from datasets.joyent.com', function (t) {
    var self = this;
    // Pick a small one: minimal-32@15.2.0
    var uuid = '0764d78e-3472-11e5-8949-4f31abea4e05';
    var manifest;
    var filePath = format('/var/tmp/dataset-test-file-%s.zfs.bz2', process.pid);
    var fileCompression = 'bzip2';
    var size;
    var sha1;
    var md5;
    var aImage;

    var datasetsClient = new DSAPI({
        url: 'https://datasets.joyent.com',
        agent: false
    });

    function getManifestFromDatasetsJo(next) {
        datasetsClient.getImage(uuid, function (err, dataset) {
            t.ifError(err, err);
            t.ok(dataset);
            manifest = dataset;
            next();
        });
    }
    function getFileFromDatasetsJo(next) {
        var url = manifest.files[0].url;
        var stream = fs.createWriteStream(filePath);
        https.get(url, function (res) {
            var sha1hash = crypto.createHash('sha1');
            var md5hash = crypto.createHash('md5');
            size = 0;
            res.pipe(stream);
            res.on('data', function (d) {
                sha1hash.update(d);
                md5hash.update(d);
                size += d.length;
            });
            res.on('end', function () {
                sha1 = sha1hash.digest('hex');
                md5 = md5hash.digest('base64');
                // No 'Content-MD5' header check because datasets.joyent.com
                // doesn't set that header.
                t.equal(sha1, manifest.files[0].sha1,
                    'sha1 matches manifest data');
                t.equal(size, manifest.files[0].size,
                    'size matches manifest data');
                next();
            });
        });
    }
    function create(next) {
        var iOpts = {skipOwnerCheck: true};
        self.client.adminImportImage(manifest, iOpts,
                                     function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            if (image) {
                t.equal(image.uuid, manifest.uuid);
                t.equal(image.published_at, manifest.published_at);
                t.equal(image.state, 'unactivated');
            }
            next(err);
        });
    }
    function addFile(next) {
        var fopts = {uuid: uuid, file: filePath, compression: fileCompression};
        self.client.addImageFile(fopts, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.files.length, 1, 'image.files');
            t.equal(image.files[0].sha1, sha1, 'image.files.0.sha1');
            t.equal(image.files[0].size, size, 'image.files.0.size');
            next(err);
        });
    }
    function activate(next) {
        self.client.activateImage(uuid, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.state, 'active');
            aImage = image;
            next();
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
    function deleteImage(next) {
        self.client.deleteImage(uuid, function (err, res) {
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
            getManifestFromDatasetsJo,
            getFileFromDatasetsJo,
            create,
            addFile,
            activate,
            getImage,
            getFile,
            deleteImage
        ],
        function (err) {
            t.end();
        }
    );
});


/**
 * AdminImportRemoteImage scenario from images.joyent.com. These steps happen
 * inside IMGAPI:
 * - get manifest from images.joyent.com/images/:uuid
 * - CreateImage with downloaded manifest
 * - AddImageFile *stream* from images.joyent.com/images/:uuid/file
 * - ActivateImage
 */
if (!process.env.IMGAPI_TEST_OFFLINE)
test('AdminImportRemoteImage from images.joyent.com', function (t) {
    var self = this;
    // Pick a small one: minimal-32@15.2.0
    var uuid = '0764d78e-3472-11e5-8949-4f31abea4e05';
    var aImage;
    var imagesUrl = 'https://images.joyent.com';

    function importRemote(next) {
        self.client.adminImportRemoteImageAndWait(uuid, imagesUrl, {},
            function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            if (image) {
                t.ok(image.uuid);
                t.ok(image.published_at);
                t.equal(image.state, 'active');
                aImage = image;
            }
            next(err);
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
            var hash = crypto.createHash('sha1');
            var s = fs.createReadStream(tmpFilePath);
            s.on('data', function (d) { hash.update(d); });
            s.on('end', function () {
                var actual_sha1 = hash.digest('hex');
                t.equal(aImage.files[0].sha1, actual_sha1,
                    'sha1 matches image data');
                next();
            });
        });
    }
    function deleteImage(next) {
        self.client.deleteImage(uuid, function (err, res) {
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
            importRemote,
            getFile,
            deleteImage
        ],
        function (err) {
            t.end();
        }
    );
});


/**
 * AdminImportRemoteImage from updates.joyent.com.
 */
if (!process.env.IMGAPI_TEST_OFFLINE)
test('AdminImportRemoteImage from updates.joyent.com (dev chan)', function (t) {
    var self = this;
    var name = 'assets';  // The 'assets' images are typically small.
    var sourceImage;
    var uuid;
    var aImage;
    var source = 'https://updates.joyent.com';

    function pickUuid(next) {
        var updates = new IMGAPI({url: source, agent: false, channel: 'dev'});
        updates.listImages({name: name}, function (err, imgs) {
            t.ifError(err, err);
            t.ok(imgs, 'got images');
            t.ok(imgs.length > 1, 'have ' + name + ' images to choose from');
            sourceImage = imgs[0];
            uuid = sourceImage.uuid;
            next(err);
        });
    }
    function importRemote(next) {
        self.client.adminImportRemoteImageAndWait(uuid, source, {},
            function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            if (image) {
                t.ok(image.uuid);
                t.ok(image.published_at);
                t.equal(image.state, 'active');
                aImage = image;
            }
            next(err);
        });
    }
    function getFile(next) {
        var tmpFilePath = format('/var/tmp/imgapi-test-file-%s.zfs.bz2',
            process.pid);
        self.client.getImageFile(uuid, tmpFilePath, function (err, res) {
            t.ifError(err, err);
            if (err) {
                return next(err);
            }
            var hash = crypto.createHash('sha1');
            var s = fs.createReadStream(tmpFilePath);
            s.on('data', function (d) { hash.update(d); });
            s.on('end', function () {
                var actual_sha1 = hash.digest('hex');
                t.equal(aImage.files[0].sha1, actual_sha1,
                    'sha1 matches image data');
                next();
            });
        });
    }
    function deleteImage(next) {
        self.client.deleteImage(uuid, function (err, res) {
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
            pickUuid,
            importRemote,
            getFile,
            deleteImage
        ],
        function (err) {
            t.end();
        }
    );
});
