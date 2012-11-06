/*
 * Copyright (c) 2012 Joyent Inc. All rights reserved.
 *
 * Test basic /images endpoints.
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



test('ListImages returns a list', function (t) {
    this.imgapiClient.listImages(function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.ok(Array.isArray(images), 'images');
        t.end();
    })
});

test('GetImage 404', function (t) {
    var bogus = '3560c262-fc65-0242-a446-7c6d1fb482e3';
    this.imgapiClient.getImage(bogus, function (err, image, res) {
        t.ok(err, 'GetImage 404 error');
        t.notOk(image, 'image');
        t.equal(err.httpCode, '404', 'httpCode');
        t.equal(err.body.code, 'ResourceNotFound', 'body.code');
        t.ok(err.body.message, 'res body has a message');
        t.equal(res.statusCode, 404, '404 statusCode');
        t.end();
    })
});

test('GetImage existing', function (t) {
    var uuid = 'c58161c0-2547-11e2-a75e-9fdca1940570'; // our test base-1.8.1
    this.imgapiClient.getImage(uuid, function (err, image, res) {
        t.ifError(err, 'GetImage 404 error');
        t.ok(image, 'image');
        t.equal(image.uuid, uuid, 'image.uuid');
        t.end();
    });
});



//test('CreateImage empty', function (t) {
//    var data = {};
//    this.imgapiClient.createImage(data, function (err, images) {
//        ...
//        t.end();
//    })
//});

