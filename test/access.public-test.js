/*
 * Copyright (c) 2012 Joyent Inc. All rights reserved.
 *
 * Test public vs. auth'd access to a 'public' mode IMGAPI (e.g.
 * https://images.joyent.com).
 */

var format = require('util').format;
var assert = require('assert-plus');
var async = require('async');

//var imgapi = require('sdc-clients').IMGAPI;   // temp broken by TOOLS-211
var imgapi = require('sdc-clients/lib/imgapi');



// node-tap API
if (require.cache[__dirname + '/tap4nodeunit.js'])
    delete require.cache[__dirname + '/tap4nodeunit.js'];
var tap4nodeunit = require('./tap4nodeunit.js');
var after = tap4nodeunit.after;
var before = tap4nodeunit.before;
var test = tap4nodeunit.test;



before(function (next) {
    var options = {
        url: process.env.IMGAPI_URL,
        agent: false
    };
    if (process.env.IMGAPI_PASSWORD) {
        options.user = process.env.IMGAPI_USER;
        options.password = process.env.IMGAPI_PASSWORD;
    } else if (process.env.IMGAPI_URL === 'https://images.joyent.com') {
        assert.ok(process.env.JOYENT_IMGADM_USER,
            'JOYENT_IMGADM_USER envvar is not set');
        assert.ok(process.env.JOYENT_IMGADM_IDENTITY,
            'JOYENT_IMGADM_IDENTITY envvar is not set');
        options.user = process.env.JOYENT_IMGADM_USER;
        options.sign = imgapi.cliSigner({
            keyId: process.env.JOYENT_IMGADM_IDENTITY,
            user: process.env.JOYENT_IMGADM_USER
        });
    } else {
        assert.fail('What no auth info!?');
    }
    this.authClient = imgapi.createClient(options);
    this.noAuthClient = imgapi.createClient({
        url: process.env.IMGAPI_URL,
        agent: false
    });
    next();
});

test('ping: auth', function (t) {
    this.authClient.ping(function (err, pong) {
        t.ifError(err, 'ping err: ', err);
        t.ok(pong, 'pong');
        t.equal(pong.ping, 'pong', 'expected pong');
        t.ok(pong.pid, 'pong.pid');
        t.ok(pong.version, 'pong.version');
        t.end();
    });
});

test('ping: no auth', function (t) {
    this.authClient.ping(function (err, pong) {
        t.ifError(err, 'ping err: ', err);
        t.ok(pong, 'pong');
        t.equal(pong.ping, 'pong', 'expected pong');
        t.ok(pong.version, 'pong.version');
        // No 'pid' given on unauthed '/ping' to 'public' mode IMGAPI server.
        t.ok(pong.pid, undefined);
        t.end();
    });
});


test('401 on misc endpoints without auth', function (t) {
    var self = this;
    var endpoints = [
        //'adminUpdateState',
        'adminGetState'
    ];
    async.forEachSeries(
        endpoints,
        function (endpoint, next) {
            self.noAuthClient[endpoint](function (err) {
                t.ok(err, endpoint + ' got error: ' + err);
                t.equal(err.statusCode, '401', endpoint + ' err.statusCode');
                next();
            });
        },
        function (err) {
            t.ifError(err, err);
            t.end();
        }
    );
});

test('401 on modifying endpoints without auth', function (t) {
    var self = this;
    var endpoints = [
        ['createImage', [ {} ] ],
        ['addImageFile', [ { uuid: '900850d9-4bc2-da4b-84be-7e7cd50fe136',
                           file: __filename,
                           size: 42,
                           compression: 'none' } ]],
        ['activateImage', ['900850d9-4bc2-da4b-84be-7e7cd50fe136']],
        ['disableImage', ['900850d9-4bc2-da4b-84be-7e7cd50fe136']],
        ['enableImage', ['900850d9-4bc2-da4b-84be-7e7cd50fe136']],
        ['updateImage', ['900850d9-4bc2-da4b-84be-7e7cd50fe136', {}]],
        ['addImageAcl', ['900850d9-4bc2-da4b-84be-7e7cd50fe136', []]],
        ['removeImageAcl', ['900850d9-4bc2-da4b-84be-7e7cd50fe136', []]],
        ['deleteImage', ['900850d9-4bc2-da4b-84be-7e7cd50fe136']]
    ];
    async.forEachSeries(
        endpoints,
        function (endpoint, next) {
            var name = endpoint[0];
            var args = endpoint[1];
            function theCallback(err) {
                t.ok(err, name + ' got error: ' + err);
                t.equal(err.statusCode, '401', name + ' err.statusCode');
                next();
            }
            args.push(theCallback);
            self.noAuthClient[name].apply(self.noAuthClient, args);
        },
        function (err) {
            t.ifError(err, err);
            t.end();
        }
    );
});

test('CreateImage fail for a private image', function (t) {
    var data = {
        name: 'my-priv-image',
        version: '1.0.0',
        os: 'smartos',
        owner: '639e90cd-71ec-c449-bc7a-2446651cce7c',
        public: false,
        type: 'zone-dataset'
    };
    this.authClient.createImage(data, function (err, image, res) {
        t.ok(err, 'got error: ' + err);
        if (err) {
            t.equal(err.body.code, 'ValidationFailed',
                'err code: ' + err.body.code);
        }
        t.end();
    });
});

test('UpdateImage fail for a private image', function (t) {
    var self = this;
    // Find an image to test with (this is playing fast and loose).
    self.authClient.listImages(function (listErr, images, res) {
        var uuid = images[0].uuid;
        var data = { 'public': false };
        self.authClient.updateImage(uuid, data, function (err2, image, res2) {
            t.ok(err2, 'got error: ' + err2);
            if (err2) {
                t.equal(err2.body.code, 'ValidationFailed',
                    'err code: ' + err2.body.code);
                t.ok(err2.message.indexOf('public') !== -1,
                    'error in validating "public" field');
            }
            t.end();
        });
    });
});

test('unauthed user cannot see state other than active', function (t) {
    var self = this;

    // all
    self.noAuthClient.listImages({state: 'all'}, function (err, images, res) {
        t.ifError(err, err);
        t.ok(images, 'got images');
        t.equal(images.length, 2, 'only the expected 2 images');
        images.forEach(function (image) {
            t.equal(image.state, 'active');
        });

        // disabled
        self.noAuthClient.listImages({state: 'disabled'},
                                     function (err2, dImages, res2) {
            t.ifError(err2, err2);
            t.equal(dImages.length, 0, 'no disabled images for me');

            // unactivated
            self.noAuthClient.listImages({state: 'unactivated'},
                                         function (err3, uImages, res3) {
                t.ifError(err3, err3);
                t.equal(uImages.length, 0, 'no disabled images for me');
            });
        });
    });
    t.end();
});
