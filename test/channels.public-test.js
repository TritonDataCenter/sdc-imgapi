/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
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

var tmpDownloadFile = '/var/tmp/imgapi-channels-test-download';


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
    } else {
        assert.fail('What no auth info!?');
    }
    this.clients = {
        'nochan':  imgapi.createClient(opts),
        'star':    imgapi.createClient(mergeObjs(opts, {channel: '*'})),
        'bogus':   imgapi.createClient(mergeObjs(opts, {channel: 'bogus'})),
        'dev':     imgapi.createClient(mergeObjs(opts, {channel: 'dev'})),
        'staging': imgapi.createClient(mergeObjs(opts, {channel: 'staging'})),
        'release': imgapi.createClient(mergeObjs(opts, {channel: 'release'}))
    };
    next();
});


test('ListChannels', function (t) {
    this.clients.nochan.listChannels({}, function (err, channels) {
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
    this.clients.nochan.listImages(function (err, images) {
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
    this.clients.nochan.listImages(function (err, images) {
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
    this.clients.nochan.listImages(function (err, images) {
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
    this.clients.dev.listImages(function (err, images) {
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
    this.clients.dev.listImages(function (err, images) {
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
    this.clients.dev.listImages(function (err, images) {
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
    this.clients.staging.listImages(function (err, images) {
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
    this.clients.staging.listImages(function (err, images) {
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
    this.clients.star.listImages(function (err, images) {
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
    this.clients.star.listImages({channel: '*'}, function (err, images) {
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
    this.clients.bogus.listImages({channel: 'bogus'}, function (err, images) {
        t.ok(err);
        t.equal(err.body.code, 'ValidationFailed');
        t.equal(err.body.errors[0].field, 'channel');
        t.end();
    });
});


test('GetImage with implied dev channel can get indevchan', function (t) {
    this.clients.nochan.getImage('8ba6d20f-6013-f944-9d69-929ebdef45a2', {},
                             function (err, image) {
        t.ifError(err);
        t.ok(image);
        t.equal(image.uuid, '8ba6d20f-6013-f944-9d69-929ebdef45a2');
        t.ok(image.channels.indexOf('dev') !== -1);
        t.end();
    });
});

test('GetImage with implied dev channel cannot get innochan', function (t) {
    this.clients.nochan.getImage('c58161c0-2547-11e2-a75e-9fdca1940570', {},
                             function (err, image) {
        t.ok(err);
        t.equal(err.body.code, 'ResourceNotFound');
        t.end();
    });
});

test('GetImage with implied dev channel cannot get instagingchan',
     function (t) {
    this.clients.nochan.getImage('3e6ebb8c-bb37-9245-ba5d-43d172461be6', {},
                             function (err, image) {
        t.ok(err);
        if (err) {
            t.equal(err.body.code, 'ResourceNotFound');
        }
        t.end();
    });
});

test('GetImage with dev channel can get indevchan', function (t) {
    this.clients.dev.getImage('8ba6d20f-6013-f944-9d69-929ebdef45a2',
                             function (err, image) {
        t.ifError(err);
        t.ok(image);
        t.equal(image.uuid, '8ba6d20f-6013-f944-9d69-929ebdef45a2');
        t.ok(image.channels.indexOf('dev') !== -1);
        t.end();
    });
});

test('GetImage with dev channel cannot get innochan', function (t) {
    this.clients.dev.getImage('c58161c0-2547-11e2-a75e-9fdca1940570',
                             function (err, image) {
        t.ok(err);
        t.equal(err.body.code, 'ResourceNotFound');
        t.end();
    });
});

test('GetImage with dev channel cannot get instagingchan', function (t) {
    this.clients.dev.getImage('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
                             function (err, image) {
        t.ok(err);
        if (err) {
            t.equal(err.body.code, 'ResourceNotFound');
        }
        t.end();
    });
});

test('GetImage with staging channel can get instagingchan', function (t) {
    this.clients.staging.getImage('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
                             function (err, image) {
        t.ifError(err);
        t.ok(image);
        t.equal(image.uuid, '3e6ebb8c-bb37-9245-ba5d-43d172461be6');
        t.ok(image.channels.indexOf('staging') !== -1);
        t.end();
    });
});

test('GetImage with staging channel cannot get innochan', function (t) {
    this.clients.staging.getImage('c58161c0-2547-11e2-a75e-9fdca1940570',
                             function (err, image) {
        t.ok(err);
        t.equal(err.body.code, 'ResourceNotFound');
        t.end();
    });
});

test('GetImage with staging channel cannot get indevchan', function (t) {
    this.clients.staging.getImage('8ba6d20f-6013-f944-9d69-929ebdef45a2',
                             function (err, image) {
        t.ok(err);
        if (err) {
            t.equal(err.body.code, 'ResourceNotFound');
        }
        t.end();
    });
});

test('GetImage with bogus channel gets error', function (t) {
    this.clients.bogus.getImage('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
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



test('GetImageFile with implied dev channel can get indevchan', function (t) {
    this.clients.nochan.getImageFile('8ba6d20f-6013-f944-9d69-929ebdef45a2',
            tmpDownloadFile, function (err, res) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.equal(fs.readFileSync(tmpDownloadFile), 'file');
        t.end();
    });
});

test('GetImageFile with implied dev channel cannot get innochan', function (t) {
    this.clients.nochan.getImageFile('c58161c0-2547-11e2-a75e-9fdca1940570',
            tmpDownloadFile, function (err, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});

test('GetImageFile with implied dev channel cannot get instagingchan',
     function (t) {
    this.clients.nochan.getImageFile('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
            tmpDownloadFile, function (err, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});

test('GetImageFile with dev channel can get indevchan', function (t) {
    this.clients.dev.getImageFile('8ba6d20f-6013-f944-9d69-929ebdef45a2',
            tmpDownloadFile, undefined,
            function (err, res) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.equal(fs.readFileSync(tmpDownloadFile), 'file');
        t.end();
    });
});

test('GetImageFile with dev channel cannot get innochan', function (t) {
    this.clients.dev.getImageFile('c58161c0-2547-11e2-a75e-9fdca1940570',
            tmpDownloadFile, undefined,
            function (err, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});

test('GetImageFile with dev channel cannot get instagingchan', function (t) {
    this.clients.dev.getImageFile('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
            tmpDownloadFile, undefined,
            function (err, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});

test('GetImageFile with staging channel can get instagingchan', function (t) {
    this.clients.staging.getImageFile('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
            tmpDownloadFile, undefined,
            function (err, res) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.equal(fs.readFileSync(tmpDownloadFile), 'file');
        t.end();
    });
});

test('GetImageFile with staging channel cannot get innochan', function (t) {
    this.clients.staging.getImageFile('c58161c0-2547-11e2-a75e-9fdca1940570',
            tmpDownloadFile, undefined,
            function (err, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});

test('GetImageFile with staging channel cannot get indevchan', function (t) {
    this.clients.staging.getImageFile('8ba6d20f-6013-f944-9d69-929ebdef45a2',
            tmpDownloadFile, undefined,
            function (err, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});

test('GetImageFile with bogus channel gets error', function (t) {
    this.clients.bogus.getImageFile('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
            tmpDownloadFile, undefined,
            function (err, res) {
        t.plan(2);
        t.ok(err);
        if (err) t.equal(err.body.code, 'ValidationFailed');
        t.end();
    });
});


test('GetImageFile (stream) with staging channel can get instagingchan',
function (t) {
    this.clients.staging.getImageFileStream(
        '3e6ebb8c-bb37-9245-ba5d-43d172461be6', undefined,
    function (err, stream) {
        t.ifError(err);
        t.ok(stream);

        function finish_(err2) {
            t.ifError(err2);
            if (!err2) t.equal(fs.readFileSync(tmpDownloadFile), 'file');
            t.end();
        }
        var finish = once(finish_);

        var out = stream.pipe(fs.createWriteStream(tmpDownloadFile));
        out.on(writeStreamFinishEvent, finish);
        stream.on('error', finish);
        stream.resume();
    });
});

test('GetImageFile (stream) with staging channel cannot get innochan',
function (t) {
    this.clients.staging.getImageFileStream(
        'c58161c0-2547-11e2-a75e-9fdca1940570', undefined,
    function (err, stream) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(stream.statusCode, 404);
        t.end();
    });
});

test('GetImageFile (stream) with staging channel cannot get indevchan',
function (t) {
    this.clients.staging.getImageFileStream(
        '8ba6d20f-6013-f944-9d69-929ebdef45a2', undefined,
    function (err, stream) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(stream.statusCode, 404);
        t.end();
    });
});


test('GetImageIcon with implied dev channel can get indevchan', function (t) {
    this.clients.dev.getImageIcon('8ba6d20f-6013-f944-9d69-929ebdef45a2',
            tmpDownloadFile, function (err, res) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.equal(fs.readFileSync(tmpDownloadFile), 'icon');
        t.end();
    });
});

test('GetImageIcon with implied dev channel cannot get instagingchan',
     function (t) {
    this.clients.dev.getImageIcon('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
            tmpDownloadFile, function (err, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});

test('GetImageIcon with dev channel can get indevchan', function (t) {
    this.clients.dev.getImageIcon('8ba6d20f-6013-f944-9d69-929ebdef45a2',
            tmpDownloadFile, undefined,
            function (err, res) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.equal(fs.readFileSync(tmpDownloadFile), 'icon');
        t.end();
    });
});

test('GetImageIcon with dev channel cannot get instagingchan', function (t) {
    this.clients.dev.getImageIcon('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
            tmpDownloadFile, undefined,
            function (err, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});

test('GetImageIcon with staging channel can get instagingchan', function (t) {
    this.clients.staging.getImageIcon('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
            tmpDownloadFile, undefined,
            function (err, res) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.equal(fs.readFileSync(tmpDownloadFile), 'icon');
        t.end();
    });
});


test('GetImageIcon (stream) with staging channel can get instagingchan',
function (t) {
    this.clients.staging.getImageIconStream(
        '3e6ebb8c-bb37-9245-ba5d-43d172461be6', undefined,
    function (err, stream) {
        t.ifError(err);
        if (!err) {
            t.ok(stream);

            function finish_(err2) {
                t.ifError(err2);
                if (!err2) t.equal(fs.readFileSync(tmpDownloadFile), 'icon');
                t.end();
            }
            var finish = once(finish_);

            var out = stream.pipe(fs.createWriteStream(tmpDownloadFile));
            out.on(writeStreamFinishEvent, finish);
            stream.on('error', finish);
            stream.resume();
        } else {
            t.end();
        }
    });
});

test('GetImageIcon (stream) with staging channel cannot get innochan',
function (t) {
    this.clients.staging.getImageIconStream(
        'c58161c0-2547-11e2-a75e-9fdca1940570', undefined,
    function (err, stream) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(stream.statusCode, 404);
        t.end();
    });
});

test('GetImageIcon (stream) with staging channel cannot get indevchan',
function (t) {
    this.clients.staging.getImageIconStream(
        '8ba6d20f-6013-f944-9d69-929ebdef45a2', undefined,
    function (err, stream) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(stream.statusCode, 404);
        t.end();
    });
});


//---- UpdateImage (and many the endpoints in the same chain)

test('UpdateImage with staging channel can get instagingchan', function (t) {
    this.clients.staging.updateImage(
            '3e6ebb8c-bb37-9245-ba5d-43d172461be6',
            {tags: {foo: 'bar'}},
            function (err, img, res) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(img);
        t.ok(img.channels.indexOf('staging') !== -1);
        t.equal(img.tags.foo, 'bar');
        t.end();
    });
});

test('UpdateImage with staging channel cannot get indevchan', function (t) {
    this.clients.staging.updateImage(
            '8ba6d20f-6013-f944-9d69-929ebdef45a2',
            {tags: {foo: 'bar'}},
            function (err, img, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});


//---- CreateImage
// Ensure the set channel gets assigned.

test('CreateImage with implicit default channel', function (t) {
    var data = {
        name: 'my-CreateImage-staging-test',
        version: '1.0.0',
        os: 'other',
        type: 'other',
        owner: '639e90cd-71ec-c449-bc7a-2446651cce7c',
        public: true
    };
    this.clients.nochan.createImage(data, function (err, img, res) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(img);
        t.ok(img.channels.indexOf('dev') !== -1);
        t.equal(img.state, 'unactivated');
        t.end();
    });
});

test('CreateImage with release channel', function (t) {
    var data = {
        name: 'my-CreateImage-staging-test',
        version: '1.0.0',
        os: 'other',
        type: 'other',
        owner: '639e90cd-71ec-c449-bc7a-2446651cce7c',
        public: true
    };
    this.clients.release.createImage(data, function (err, img, res) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(img);
        t.ok(img.channels[0], 'release');
        t.equal(img.state, 'unactivated');
        t.end();
    });
});



//----  AddImageAcl/RemoveImageAcl

test('AddImageAcl with staging channel can get instagingchan', function (t) {
    this.clients.staging.addImageAcl('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
            ['aa1c57aa-1451-11e4-a20c-13e606e498d1'],
            undefined, function (err, img, res) {
        t.ifError(err);
        t.ok(img);
        t.ok(img.channels.indexOf('staging') !== -1);
        t.equal(res.statusCode, 200);
        t.end();
    });
});

test('AddImageAcl with staging channel cannot get indevchan', function (t) {
    this.clients.staging.addImageAcl('8ba6d20f-6013-f944-9d69-929ebdef45a2',
            ['aa1c57aa-1451-11e4-a20c-13e606e498d1'],
            undefined, function (err, img, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});

test('RemoveImageAcl with staging channel can get instagingchan', function (t) {
    this.clients.staging.removeImageAcl('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
            ['aa1c57aa-1451-11e4-a20c-13e606e498d1'],
            undefined, function (err, img, res) {
        t.ifError(err);
        t.ok(img);
        t.ok(img.channels.indexOf('staging') !== -1);
        t.equal(res.statusCode, 200);
        t.end();
    });
});

test('RemoveImageAcl with staging channel cannot get indevchan', function (t) {
    this.clients.staging.removeImageAcl('8ba6d20f-6013-f944-9d69-929ebdef45a2',
            ['aa1c57aa-1451-11e4-a20c-13e606e498d1'],
            undefined, function (err, img, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});



//---- ChannelAddImage

test('ChannelAddImage instagingchan to bogus channel', function (t) {
    var addOpts = {
        uuid: '3e6ebb8c-bb37-9245-ba5d-43d172461be6',
        channel: 'bogus'
    };
    this.clients.staging.channelAddImage(addOpts, function (err, img, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ValidationFailed');
        t.equal(res.statusCode, 422);
        t.end();
    });
});

test('ChannelAddImage unknown image to release channel', function (t) {
    var addOpts = {
        uuid: '3e6ebb8c-bb37-9245-ba5d-999999999999',
        channel: 'release'
    };
    this.clients.staging.channelAddImage(addOpts, function (err, img, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});

test('ChannelAddImage instagingchan image to release channel (using dev chan)',
function (t) {
    var addOpts = {
        uuid: '3e6ebb8c-bb37-9245-ba5d-43d172461be6',
        channel: 'release'
    };
    this.clients.dev.channelAddImage(addOpts, function (err, img, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});

test('ChannelAddImage instagingchan to release channel', function (t) {
    var addOpts = {
        uuid: '3e6ebb8c-bb37-9245-ba5d-43d172461be6',
        channel: 'release'
    };
    this.clients.staging.channelAddImage(addOpts, function (err, img, res) {
        t.ifError(err);
        t.ok(img);
        t.ok(img.channels.indexOf('staging') !== -1);
        t.ok(img.channels.indexOf('release') !== -1);
        t.equal(res.statusCode, 200);
        t.end();
    });
});

test('ListImages in release channel to assert have new one', function (t) {
    var uuid = '3e6ebb8c-bb37-9245-ba5d-43d172461be6';
    this.clients.release.listImages(function (err, images) {
        t.ifError(err);
        t.equal(
            images.filter(function (img) { return img.uuid === uuid; }).length,
            1);
        t.end();
    });
});

test('DeleteImage instagingchan to remove from release channel', function (t) {
    this.clients.release.deleteImage('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
            undefined, function (err, res) {
        t.ifError(err);
        t.equal(res.statusCode, 204);
        t.end();
    });
});

test('ListImages in release channel to assert removed', function (t) {
    var uuid = '3e6ebb8c-bb37-9245-ba5d-43d172461be6';
    this.clients.release.listImages(function (err, images) {
        t.ifError(err);
        t.equal(
            images.filter(function (img) { return img.uuid === uuid; }).length,
            0);
        t.end();
    });
});

test('ListImages in staging channel to assert still there', function (t) {
    var uuid = '3e6ebb8c-bb37-9245-ba5d-43d172461be6';
    this.clients.staging.listImages(function (err, images) {
        t.ifError(err);
        t.equal(
            images.filter(function (img) { return img.uuid === uuid; }).length,
            1);
        t.end();
    });
});



//----  DeleteImageIcon

test('DeleteImageIcon with staging channel can get instagingchan',
function (t) {
    this.clients.staging.deleteImageIcon('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
            undefined, function (err, img, res) {
        t.ifError(err);
        t.ok(img);
        t.ok(img.channels.indexOf('staging') !== -1);
        t.equal(res.statusCode, 200);
        t.end();
    });
});

test('DeleteImageIcon with staging channel cannot get indevchan', function (t) {
    this.clients.staging.deleteImageIcon('8ba6d20f-6013-f944-9d69-929ebdef45a2',
            undefined, function (err, img, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});


//----  DeleteImage

test('DeleteImage (ch=staging) can get instagingchan', function (t) {
    this.clients.staging.deleteImage('3e6ebb8c-bb37-9245-ba5d-43d172461be6',
            undefined, function (err, res) {
        t.ifError(err);
        t.equal(res.statusCode, 204);
        t.end();
    });
});

test('ListImages (ch=*) shows instagingchan is really gone', function (t) {
    this.clients.star.listImages(function (err, imgs) {
        t.ifError(err);
        t.equal(
            imgs.filter(function (img) {
                return img.name === 'instagingchan'; }
            ).length,
            0);
        t.end();
    });
});

test('DeleteImage (ch=staging) cannot get indevchan', function (t) {
    this.clients.staging.deleteImage('8ba6d20f-6013-f944-9d69-929ebdef45a2',
            undefined, function (err, res) {
        t.ok(err);
        if (err) t.equal(err.body.code, 'ResourceNotFound');
        t.equal(res.statusCode, 404);
        t.end();
    });
});


//---- DeleteImage with ?force_all_channels works as expected

test('DeleteImage (ch=dev) with ?force_all_channels fully deletes inmultichan',
function (t) {
    var uuid = '4e6ebb8c-bb37-9245-ba5d-43d172461be6';
    var delOpts = {
        forceAllChannels: true
    };
    this.clients.dev.deleteImage(uuid, delOpts, function (err, res) {
        t.ifError(err);
        t.equal(res.statusCode, 204);
        t.end();
    });
});

test('ListImages (ch=*) shows inmultichan is really gone', function (t) {
    this.clients.star.listImages(function (err, imgs) {
        t.ifError(err);
        t.equal(
            imgs.filter(function (img) {
                return img.name === 'inmultichan'; }
            ).length, 0);
        t.end();
    });
});
