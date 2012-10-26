/*
 * Copyright (c) 2012 Joyent Inc. All rights reserved.
 *
 * Basic ping test.
 */

var format = require('util').format;

var IMGAPI = require('sdc-clients').IMGAPI;


// node-tap API
if (require.cache[__dirname + '/tap4nodeunit.js'])
    delete require.cache[__dirname + '/tap4nodeunit.js'];
var tap4nodeunit = require('./tap4nodeunit.js');
var after = tap4nodeunit.after;
var before = tap4nodeunit.before;
var test = tap4nodeunit.test;



before(function (next) {
    this.imgapiClient = new IMGAPI({url: process.env.IMGAPI_URL});
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
    })
});

test('ping error', function (t) {
    this.imgapiClient.ping('ValidationFailed', function (err, pong, res) {
        t.ok(err, 'got error');
        t.equal(err.httpCode, '422', 'httpCode');
        t.equal(err.body.code, 'ValidationFailed', 'body.code');
        t.ok(err.body.message, 'res body has a message');
        t.notOk(pong, 'no pong');
        t.equal(res.statusCode, 422, '422 statusCode');
        t.equal(res.headers.server, 'IMGAPI', 'IMGAPI server header');
        t.end();
    })
});
