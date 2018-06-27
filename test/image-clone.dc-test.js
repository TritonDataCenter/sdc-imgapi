/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 * TRITON-53: Test the image clone endpoint.
 */

var util = require('util');

var IMGAPI = require('sdc-clients/lib/imgapi');
var restify = require('restify');
var uuid = require('uuid');


// ---- globals

var client;
var jsonClient;
var CLONED_IMAGE;
var CLONED_IMAGE_2;
var PUBLIC_OPERATOR_IMAGE = 'c58161c0-2547-11e2-a75e-9fdca1940570';
// Private image owned by vader, shared with luke.
var PRIVATE_SHARED_IMAGE = '7a1b1967-6ecf-1e4c-8f09-f49094cc36ad';
var IMGAPI_URL = process.env.IMGAPI_URL || 'http://localhost';
var LUKE = '91ba0e64-2547-11e2-a972-df579e5fddb3';
var VADER = '86055c40-2547-11e2-8a6b-4bb37edc84ba';

// ---- tests

var tests = {};

tests['setup'] = function (t) {
    client = new IMGAPI({url: IMGAPI_URL, agent: false});
    t.ok(client, 'got an imgapi client');
    jsonClient = restify.createJSONClient({
        connectTimeout: 250,
        rejectUnauthorized: false,
        retry: false,
        url: IMGAPI_URL
    });
    t.ok(jsonClient, 'got a json client');
    t.done();
};


tests['error when no account provided'] = function (t) {
    var url = util.format('/images/%s/clone', PRIVATE_SHARED_IMAGE);
    jsonClient.post(url, function (err) {
        t.ok(err, 'expect an error when no account provided');
        t.equal(err.statusCode, 422, 'error statusCode should be 422');
        t.ok(err.body, 'error should have a body object');
        if (err.body) {
            t.equal(err.body.code, 'InvalidParameter',
                'error code should be InvalidParameter');
        }
        t.done();
    });
};

tests['error when cloning a private image'] = function (t) {
    var account = uuid.v4();
    client.cloneImage(PRIVATE_SHARED_IMAGE, account, function (err) {
        t.ok(err, 'got an error');
        t.equal(err.statusCode, 404, 'error statusCode should be 404');
        t.ok(err.body, 'error should have a body object');
        if (err.body) {
            t.equal(err.body.code, 'ResourceNotFound',
                'error code should be ResourceNotFound');
        }
        t.done();
    });
};

tests['error when cloning public operator image'] = function (t) {
    var account = uuid.v4();
    client.cloneImage(PUBLIC_OPERATOR_IMAGE, account, function (err) {
        t.ok(err, 'got an error');
        t.equal(err.statusCode, 422, 'error statusCode should be 422');
        t.ok(err.body, 'error should have a body object');
        if (err.body) {
            t.equal(err.body.code, 'ImageNotShared',
                'error code should be ImageNotShared');
        }
        t.done();
    });
};

tests['error when cloning own image'] = function (t) {
    client.cloneImage(PRIVATE_SHARED_IMAGE, VADER, function (err) {
        t.ok(err, 'got an error');
        t.equal(err.statusCode, 422, 'error statusCode should be 422');
        t.ok(err.body, 'error should have a body object');
        if (err.body) {
            t.equal(err.body.code, 'ImageNotShared',
                'error code should be ImageNotShared');
        }
        t.done();
    });
};

tests['clone shared image'] = function (t) {
    client.cloneImage(PRIVATE_SHARED_IMAGE, LUKE, function (err, img) {
        t.ok(!err, 'should not have an error on cloneImage');
        t.ok(img, 'should return an image object');
        if (img) {
            CLONED_IMAGE = img.uuid;
            t.notEqual(CLONED_IMAGE, PRIVATE_SHARED_IMAGE,
                'cloned image should have a different uuid');
        }
        t.done();
    });
};

tests['clone the same image again'] = function (t) {
    client.cloneImage(PRIVATE_SHARED_IMAGE, LUKE, function (err, img) {
        t.ok(!err, 'should not have an error on cloneImage');
        t.ok(img, 'should return an image object');
        if (img) {
            CLONED_IMAGE_2 = img.uuid;
            t.notEqual(CLONED_IMAGE_2, PRIVATE_SHARED_IMAGE,
                'cloned image should have a different uuid');
            t.notEqual(CLONED_IMAGE_2, CLONED_IMAGE,
                'cloned image should have a different uuid');
        }
        t.done();
    });
};

tests['error when cloning the cloned image'] = function (t) {
    t.ok(CLONED_IMAGE, 'should have a cloned image');
    if (!CLONED_IMAGE) {
        t.done();
        return;
    }
    client.cloneImage(CLONED_IMAGE, LUKE, function (err) {
        t.ok(err, 'got an error');
        t.equal(err.statusCode, 422, 'error statusCode should be 422');
        t.ok(err.body, 'error should have a body object');
        if (err.body) {
            t.equal(err.body.code, 'ImageNotShared',
                'error code should be ImageNotShared');
        }
        t.done();
    });
};

tests['cleanup'] = function (t) {
    t.ok(CLONED_IMAGE, 'should have a cloned image');
    t.ok(CLONED_IMAGE_2, 'should have a second cloned image');
    if (!CLONED_IMAGE) {
        t.done();
        return;
    }
    client.deleteImage(CLONED_IMAGE, LUKE, function (err) {
        t.ok(!err, 'should not have an error deleting clone');
        if (!CLONED_IMAGE_2) {
            t.done();
            return;
        }
        client.deleteImage(CLONED_IMAGE_2, LUKE, function (err2) {
            t.ok(!err2, 'should not have an error deleting second clone');
            t.done();
        });
    });
};

exports.clone = tests;
