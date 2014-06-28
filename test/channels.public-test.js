/*
 * Copyright (c) 2014 Joyent Inc. All rights reserved.
 *
 * Test channels handling.
 *
 * We do this as a "public-test" rather than a "dc-test"
 * because practically speaking it is updates.joyent.com (a mode=private,
 * functionally equiv to mode=public) that has channels support and never the
 * mode=dc IMGAPI in SDC installations.
 */

var p = console.log;
var format = require('util').format;
var assert = require('assert-plus');
var async = require('async');

var imgapi = require('sdc-clients').IMGAPI;



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
        assert.fail('Do not run the channels tests against images.jo.');
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


test('ListChannels', function (t) {
    this.authClient.listChannels({}, function (err, channels) {
        t.ifError(err, 'ListChannels err: ', err);
        t.ok(channels, 'channels');
        t.equal(channels.length, 3, 'channels.length');
        t.equal(
            channels.filter(function (ch) { return ch.default; })[0].name,
            'dev');
        t.end();
    });
});

test('ListImages with implied dev channel has indevchan', function (t) {
    this.authClient.listImages(function (err, images) {
        t.ifError(err);
        t.equal(
            images
                .filter(function (img) { return img.name === 'indevchan'; })
                .length,
            1);
        t.end();
    });
});

test('ListImages with implied dev channel has no innochan', function (t) {
    this.authClient.listImages(function (err, images) {
        t.ifError(err);
        t.equal(
            images
                .filter(function (img) { return img.name === 'innochan'; })
                .length,
            0);
        t.end();
    });
});

test('ListImages with implied dev channel has no instagingchan', function (t) {
    this.authClient.listImages(function (err, images) {
        t.ifError(err);
        t.equal(
            images
                .filter(function (img) { return img.name === 'instagingchan'; })
                .length,
            0);
        t.end();
    });
});

test('ListImages with dev channel has indevchan', function (t) {
    this.authClient.listImages({channel: 'dev'}, function (err, images) {
        t.ifError(err);
        t.equal(
            images
                .filter(function (img) { return img.name === 'indevchan'; })
                .length,
            1);
        t.end();
    });
});

test('ListImages with dev channel has no innochan', function (t) {
    this.authClient.listImages({channel: 'dev'}, function (err, images) {
        t.ifError(err);
        t.equal(
            images
                .filter(function (img) { return img.name === 'innochan'; })
                .length,
            0);
        t.end();
    });
});

test('ListImages with dev channel has no instagingchan', function (t) {
    this.authClient.listImages({channel: 'dev'}, function (err, images) {
        t.ifError(err);
        t.equal(
            images
                .filter(function (img) { return img.name === 'instagingchan'; })
                .length,
            0);
        t.end();
    });
});

test('ListImages with staging channel has no indevchan', function (t) {
    this.authClient.listImages({channel: 'staging'}, function (err, images) {
        t.ifError(err);
        t.equal(
            images
                .filter(function (img) { return img.name === 'indevchan'; })
                .length,
            0);
        t.end();
    });
});

test('ListImages with staging channel has instagingchan', function (t) {
    this.authClient.listImages({channel: 'staging'}, function (err, images) {
        t.ifError(err);
        t.equal(
            images
                .filter(function (img) { return img.name === 'instagingchan'; })
                .length,
            1);
        t.end();
    });
});

test('ListImages with channel=* has no innochan', function (t) {
    this.authClient.listImages({channel: '*'}, function (err, images) {
        t.ifError(err);
        t.equal(
            images
                .filter(function (img) { return img.name === 'innochan'; })
                .length,
            0);
        t.end();
    });
});

test('ListImages with channel=* has indevchan and instagingchan', function (t) {
    this.authClient.listImages({channel: '*'}, function (err, images) {
        t.ifError(err);
        t.equal(
            images
                .filter(function (img) { return img.name === 'indevchan'; })
                .length,
            1);
        t.equal(
            images
                .filter(function (img) { return img.name === 'instagingchan'; })
                .length,
            1);
        t.end();
    });
});

test('ListImages with bogus channel errors', function (t) {
    this.authClient.listImages({channel: 'bogus'}, function (err, images) {
        t.ok(err);
        t.equal(err.body.code, 'ValidationFailed');
        t.equal(err.body.errors[0].field, 'channel');
        t.end();
    });
});


test('GetImage with implied dev channel can get indevchan', function (t) {
    this.authClient.getImage('8ba6d20f-6013-f944-9d69-929ebdef45a2', {},
                             function (err, image) {
        t.ifError(err);
        t.ok(image);
        t.equal(image.uuid, '8ba6d20f-6013-f944-9d69-929ebdef45a2');
        t.ok(image.channels.indexOf('dev') !== -1);
        t.end();
    });
});

test('GetImage with implied dev channel cannot get innochan', function (t) {
    this.authClient.getImage('c58161c0-2547-11e2-a75e-9fdca1940570', {},
                             function (err, image) {
        t.ok(err);
        t.equal(err.body.code, 'ResourceNotFound');
        t.end();
    });
});

test('GetImage with implied dev channel cannot get instagingchan',
     function (t) {
    this.authClient.getImage('3e6ebb8c-bb37-9245-ba5d-43d172461be6', {},
                             function (err, image) {
        t.ok(err);
        if (err) {
            t.equal(err.body.code, 'ResourceNotFound');
        }
        t.end();
    });
});

test('GetImage with dev channel can get indevchan', function (t) {
    this.authClient.getImage('8ba6d20f-6013-f944-9d69-929ebdef45a2',
                             {query: {channel: 'dev'}},
                             function (err, image) {
        t.ifError(err);
        t.ok(image);
        t.equal(image.uuid, '8ba6d20f-6013-f944-9d69-929ebdef45a2');
        t.ok(image.channels.indexOf('dev') !== -1);
        t.end();
    });
});

test('GetImage with dev channel cannot get innochan', function (t) {
    this.authClient.getImage('c58161c0-2547-11e2-a75e-9fdca1940570',
                             {query: {channel: 'dev'}},
                             function (err, image) {
        t.ok(err);
        t.equal(err.body.code, 'ResourceNotFound');
        t.end();
    });
});

test('GetImage with dev channel cannot get instagingchan', function (t) {
    this.authClient.getImage('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
                             {query: {channel: 'dev'}},
                             function (err, image) {
        t.ok(err);
        if (err) {
            t.equal(err.body.code, 'ResourceNotFound');
        }
        t.end();
    });
});

test('GetImage with staging channel can get instagingchan', function (t) {
    this.authClient.getImage('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
                             {query: {channel: 'staging'}},
                             function (err, image) {
        t.ifError(err);
        t.ok(image);
        t.equal(image.uuid, '3e6ebb8c-bb37-9245-ba5d-43d172461be6');
        t.ok(image.channels.indexOf('staging') !== -1);
        t.end();
    });
});

test('GetImage with staging channel cannot get innochan', function (t) {
    this.authClient.getImage('c58161c0-2547-11e2-a75e-9fdca1940570',
                             {query: {channel: 'staging'}},
                             function (err, image) {
        t.ok(err);
        t.equal(err.body.code, 'ResourceNotFound');
        t.end();
    });
});

test('GetImage with staging channel cannot get indevchan', function (t) {
    this.authClient.getImage('8ba6d20f-6013-f944-9d69-929ebdef45a2',
                             {query: {channel: 'staging'}},
                             function (err, image) {
        t.ok(err);
        if (err) {
            t.equal(err.body.code, 'ResourceNotFound');
        }
        t.end();
    });
});

test('GetImage with bogus channel gets error', function (t) {
    this.authClient.getImage('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
                             {query: {channel: 'bogus'}},
                             function (err, image) {
        t.plan(3);
        t.ok(err);
        if (err) {
            t.equal(err.body.code, 'ValidationFailed');
            t.equal(err.body.errors[0].field, 'channel');
        }
        t.end();
    });
});
