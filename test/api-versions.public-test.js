/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Test API version (i.e. Accept-Version header) handling.
 *
 * Need to be part of the "public" mode tests, because that's where we have
 * an imgapi that uses channels... which is the currently differentiator
 * btwn v1 and v2 GetImage responses.
 */

var p = console.log;
var format = require('util').format;
var assert = require('assert-plus');
var fs = require('fs');
var once = require('once');

var imgapi = require('sdc-clients').IMGAPI;



// node-tap API
if (require.cache[__dirname + '/tap4nodeunit.js'])
    delete require.cache[__dirname + '/tap4nodeunit.js'];
var tap4nodeunit = require('./tap4nodeunit.js');
var after = tap4nodeunit.after;
var before = tap4nodeunit.before;
var test = tap4nodeunit.test;


//---- globals

// The name of the event on a write stream indicating it is done.
var nodeVer = process.versions.node.split('.').map(Number);
var writeStreamFinishEvent = 'finish';
if (nodeVer[0] === 0 && nodeVer[1] <= 8) {
    writeStreamFinishEvent = 'close';
}


//---- support stuff

function mergeObjs(a, b) {
    assert.object(a, 'a');
    assert.object(b, 'b');
    var obj = {};
    Object.keys(a).forEach(function (key) { obj[key] = a[key]; });
    Object.keys(b).forEach(function (key) { obj[key] = b[key]; });
    return obj;
}


//---- tests

before(function (next) {
    var opts = {
        url: process.env.IMGAPI_URL,
        agent: false
    };
    if (process.env.IMGAPI_PASSWORD) {
        opts.user = process.env.IMGAPI_USER;
        opts.password = process.env.IMGAPI_PASSWORD;
    } else if (process.env.IMGAPI_URL === 'https://images.joyent.com') {
        assert.fail('Do not run the channels tests against images.jo.');
    }
    this.clients = {
        undef:      imgapi.createClient(opts),
        nover:      imgapi.createClient(mergeObjs(opts, {version: null})),
        star:       imgapi.createClient(mergeObjs(opts, {version: '*'})),
        one:        imgapi.createClient(mergeObjs(opts, {version: '~1'})),
        two:        imgapi.createClient(mergeObjs(opts, {version: '~2'})),
        gretsky:    imgapi.createClient(mergeObjs(opts, {version: '~99'}))
    };
    next();
});


test('GetImage (implicit "*") gets latest ver', function (t) {
    this.clients.undef.getImage('8ba6d20f-6013-f944-9d69-929ebdef45a2', {},
            function (err, img) {
        t.ifError(err);
        t.ok(img.channels);
        t.end();
    });
});

test('GetImage (nover) gets v1', function (t) {
    this.clients.nover.getImage('8ba6d20f-6013-f944-9d69-929ebdef45a2', {},
            function (err, img) {
        t.ifError(err);
        t.equal(img.channels, undefined);
        t.end();
    });
});

test('GetImage (~1) gets v1', function (t) {
    this.clients.one.getImage('8ba6d20f-6013-f944-9d69-929ebdef45a2', {},
            function (err, img) {
        t.ifError(err);
        t.equal(img.channels, undefined);
        t.end();
    });
});

test('GetImage (~2) gets latest ver', function (t) {
    this.clients.two.getImage('8ba6d20f-6013-f944-9d69-929ebdef45a2', {},
            function (err, img) {
        t.ifError(err);
        t.ok(img.channels);
        t.end();
    });
});

test('GetImage (~99) gets version error', function (t) {
    this.clients.gretsky.getImage('8ba6d20f-6013-f944-9d69-929ebdef45a2', {},
            function (err, img) {
        t.ok(err);
        t.equal(err.statusCode, 400);
        t.equal(err.body.code, 'InvalidVersion');
        t.end();
    });
});
