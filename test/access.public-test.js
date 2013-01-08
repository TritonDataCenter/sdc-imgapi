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
        url: process.env.IMGAPI_URL
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
    this.noAuthClient = imgapi.createClient({url: process.env.IMGAPI_URL});
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
    })
});


test('401 on misc endpoints without auth', function (t) {
    var self = this;
    var endpoints = [
        'ping',
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
        ['createImage', [{}]],
        ['addImageFile', [{uuid: '900850d9-4bc2-da4b-84be-7e7cd50fe136',
                           file: __filename,
                           size: 42,
                           compression: 'none'}]],
        ['activateImage', ['900850d9-4bc2-da4b-84be-7e7cd50fe136']],
        ['updateImage', ['900850d9-4bc2-da4b-84be-7e7cd50fe136', {}]],
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
            t.equal(err.body.code, 'NoPrivateImages',
                'err code: ' + err.body.code);
        }
        t.end();
    });
});

test('UpdateImage fail for a private image', function (t) {
    // Public image from the test data
    var uuid = 'e078a6aa-2547-11e2-8688-03ac37b2b4a0';
    var data = { 'public': false };
    this.authClient.updateImage(uuid, data, function (err, image, res) {
        t.ok(err, 'got error: ' + err);
        if (err) {
            t.equal(err.body.code, 'NoPrivateImages',
                'err code: ' + err.body.code);
        }
        t.end();
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
                                     function (err, images, res) {
            t.ifError(err, err);
            t.equal(images.length, 0, 'no disabled images for me');

            // unactivated
            self.noAuthClient.listImages({state: 'unactivated'},
                                         function (err, images, res) {
                t.ifError(err, err);
                t.equal(images.length, 0, 'no disabled images for me');
            });
        });
    });
    t.end();
});
