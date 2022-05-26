/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 * Copyright 2022 MNX Cloud, Inc.
 */

/*
 * Basic ping test.
 */

var format = require('util').format;
var assert = require('assert-plus');
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
    if (process.env.IMGAPI_URL === 'https://images.smartos.org') {
        assert.ok(process.env.IMAGES_IMGADM_USER,
            'IMAGES_IMGADM_USER envvar is not set');
        assert.ok(process.env.IMAGES_IMGADM_IDENTITY,
            'IMAGES_IMGADM_IDENTITY envvar is not set');
        options.user = process.env.IMAGES_IMGADM_USER;
        options.sign = imgapi.cliSigner({
            keyId: process.env.IMAGES_IMGADM_IDENTITY,
            user: process.env.IMAGES_IMGADM_USER
        });
    }
    this.imgapiClient = imgapi.createClient(options);
    next();
});

test('ping', function (t) {
    this.imgapiClient.ping(function (err, pong) {
        t.ifError(err, 'ping err: ', err);
        t.ok(pong, 'pong');
        t.equal(pong.ping, 'pong', 'expected pong');
        t.ok(pong.pid, 'pong.pid');
        t.ok(pong.version, 'pong.version');
        t.end();
    });
});

test('ping error', function (t) {
    this.imgapiClient.ping('ValidationFailed', function (err, pong, res) {
        t.ok(err, 'got error');
        t.equal(err.statusCode, '422', 'err.statusCode');
        t.equal(err.body.code, 'ValidationFailed', 'body.code');
        t.ok(err.body.message, 'res body has a message');
        t.notOk(pong, 'no pong');
        t.equal(res.statusCode, 422, '422 statusCode');
        t.ok(res.headers.server, 'Server header');
        t.end();
    });
});
