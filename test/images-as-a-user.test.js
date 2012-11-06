/*
 * Copyright (c) 2012 Joyent Inc. All rights reserved.
 *
 * Test /images endpoints usage as a user, i.e. as cloudapi will call imgapi.
 */

var format = require('util').format;
var async = require('async');
//var IMGAPI = require('sdc-clients').IMGAPI;   // temp broken by TOOLS-211
var IMGAPI = require('sdc-clients/lib/imgapi');


// node-tap API
if (require.cache[__dirname + '/tap4nodeunit.js'])
    delete require.cache[__dirname + '/tap4nodeunit.js'];
var tap4nodeunit = require('./tap4nodeunit.js');
var after = tap4nodeunit.after;
var before = tap4nodeunit.before;
var test = tap4nodeunit.test;


var vader = '86055c40-2547-11e2-8a6b-4bb37edc84ba';
var luke = '91ba0e64-2547-11e2-a972-df579e5fddb3';
var emperor = 'a0b6b534-2547-11e2-b758-63a2afd747d1';
var sdc = 'ba28f844-8cb4-f141-882d-46d6251e6a9f';
var imageUuidFromName = {
    'base-1.8.1': 'c58161c0-2547-11e2-a75e-9fdca1940570',
    'nodejs-1.0.0': 'da58c25a-2547-11e2-9b8d-136daa650e8a',
    'base-2.0.0': 'e078a6aa-2547-11e2-8688-03ac37b2b4a0',
    'i-am-your-father': '7a1b1967-6ecf-1e4c-8f09-f49094cc36ad',
    'come-to-the-dark-side': '9f819499-8298-9842-8cc5-1c2838196ab4',
    'he-will-join-us-or-die': '2d28c64f-fb16-2145-a0ca-f626aea35c77'
};



before(function (next) {
    this.imgapiClient = new IMGAPI({url: process.env.IMGAPI_URL});
    next();
});



test('ListImages: vader', function (t) {
    var opts = {user: vader};
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.ok(Array.isArray(images), 'images');
        var names = images.map(function (i) { return i.name });
        [// vader's active
         'i-am-your-father',
         // public ones
         'base-1.8.1'].forEach(function (name) {
            t.ok(names.indexOf(name) != -1, name);
        });
        t.end();
    })
});

test('ListImages: vader, state=all', function (t) {
    var opts = {user: vader, state: 'all'}
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.ok(Array.isArray(images), 'images');
        var names = images.map(function (i) { return i.name });
        [// all of vader's own images
         'i-am-your-father',
         'come-to-the-dark-side',
         'he-will-join-us-or-die',
         // public ones
         'base-1.8.1'].forEach(function (name) {
            t.ok(names.indexOf(name) != -1, name);
        });
        t.end();
    })
});

test('ListImages: vader, state=disabled', function (t) {
    var opts = {user: vader, state: 'disabled'}
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.equal(images.length, 1, 'only one image');
        t.equal(images[0].name, 'come-to-the-dark-side', 'disabled image');
        t.end();
    })
});

test('ListImages: vader, state=unactivated', function (t) {
    var opts = {user: vader, state: 'unactivated'}
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.equal(images.length, 1, 'only one image');
        t.equal(images[0].name, 'he-will-join-us-or-die', 'unactivated image');
        t.end();
    })
});

test('ListImages: vader, public=false', function (t) {
    var opts = {user: vader, state: 'all', public: false};
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.ok(Array.isArray(images), 'images');
        var names = images.map(function (i) { return i.name });
        [// all of vader's own images
         'i-am-your-father',
         'come-to-the-dark-side',
         'he-will-join-us-or-die'].forEach(function (name) {
            t.ok(names.indexOf(name) != -1, name);
        });
        t.equal(images.length, 3, 'only the 3 vader images');
        t.end();
    })
});

test('ListImages: vader, public=true', function (t) {
    var opts = {user: vader, state: 'all', public: true};
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.ok(Array.isArray(images), 'images');
        var names = images.map(function (i) { return i.name });
        [// NOT vader's private images
         'i-am-your-father',
         'come-to-the-dark-side',
         'he-will-join-us-or-die'].forEach(function (name) {
            t.equal(names.indexOf(name), -1, name);
        });
        t.end();
    })
});

// 'user'
test('ListImages: luke', function (t) {
    var opts = {user: luke};
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.ok(Array.isArray(images), 'images');
        var names = images.map(function (i) { return i.name });
        [// vader's active image shared with luke
         'i-am-your-father',
         // public ones
         'base-1.8.1'].forEach(function (name) {
            t.ok(names.indexOf(name) != -1, name);
        });
        // NOT these ones
        ['come-to-the-dark-side',
         'he-will-join-us-or-die'].forEach(function (name) {
            t.equal(names.indexOf(name), -1, name);
        });
        t.end();
    })
});

// 'type'
test('ListImages: vader, type=zone-dataset', function (t) {
    var opts = {user: vader, type: 'zone-dataset'};
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.ok(images.length > 0);
        t.end();
    })
});
test('ListImages: vader, type=bogus', function (t) {
    var opts = {user: vader, type: 'bogus'};
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.equal(images.length, 0);
        t.end();
    })
});

// 'os'
test('ListImages: vader, os=smartos', function (t) {
    var opts = {user: vader, os: 'smartos'};
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.ok(images.length > 0);
        t.end();
    })
});
test('ListImages: vader, os=bogus', function (t) {
    var opts = {user: vader, os: 'bogus'};
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.equal(images.length, 0);
        t.end();
    })
});

// 'name'
test('ListImages: vader, name=i-am-your-father', function (t) {
    var opts = {user: vader, name: 'i-am-your-father'};
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.equal(images.length, 1, 'just the one');
        t.equal(images[0].name, 'i-am-your-father', 'i-am-your-father');
        t.end();
    })
});

// '~name'
test('ListImages: vader, name=~father', function (t) {
    var opts = {user: vader, name: '~father'};
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.equal(images.length, 1, 'just the one');
        t.equal(images[0].name, 'i-am-your-father', 'i-am-your-father');
        t.end();
    })
});

// 'owner' (*and* 'user')
test('ListImages: vader, owner=vader, state=all', function (t) {
    var opts = {user: vader, owner: vader, state: 'all'};
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.ok(Array.isArray(images), 'images');
        // All of vader's own images.
        var names = images.map(function (i) { return i.name });
        ['i-am-your-father',
         'come-to-the-dark-side',
         'he-will-join-us-or-die'].forEach(function (name) {
            t.ok(names.indexOf(name) !== -1, name);
        });
        t.equal(images.length, 3, 'only vader images');
        t.end();
    })
});
test('ListImages: luke, owner=vader', function (t) {
    var opts = {user: luke, owner: vader};
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.ok(Array.isArray(images), 'images');
        // Only vader's active image shared with luke.
        t.equal(images.length, 1, 'just the one');
        t.equal(images[0].name, 'i-am-your-father');
        t.end();
    })
});
test('ListImages: luke, owner=sdc', function (t) {
    var opts = {user: luke, owner: sdc};
    this.imgapiClient.listImages(opts, function (err, images) {
        t.ifError(err, 'ListImages err: ', err);
        t.ok(images, 'images');
        t.ok(Array.isArray(images), 'images');
        var names = images.map(function (i) { return i.name });
        // Only sdc's active public image(s).
        t.ok(names.indexOf('base-1.8.1') !== -1);
        t.ok(names.indexOf('i-am-your-father') === -1);
        t.end();
    })
});


// Tests from test-data.ldif comment.
var data = {
    // 1. everyone can see 'base-1.8.1'
    'base-1.8.1': [
        {uuid: vader,   login: 'vader',   cansee: true},
        {uuid: luke,    login: 'luke',    cansee: true},
        {uuid: emperor, login: 'emperor', cansee: true},
        {uuid: sdc,     login: 'sdc',     cansee: true},
    ],
    // 2. only sdc can see 'nodejs-1.0.0'
    'nodejs-1.0.0': [
        {uuid: vader,   login: 'vader',   cansee: false},
        {uuid: luke,    login: 'luke',    cansee: false},
        {uuid: emperor, login: 'emperor', cansee: false},
        {uuid: sdc,     login: 'sdc',     cansee: true},
    ],
    // 3. only sdc can see 'base-2.0.0'
    'base-2.0.0': [
        {uuid: vader,   login: 'vader',   cansee: false},
        {uuid: luke,    login: 'luke',    cansee: false},
        {uuid: emperor, login: 'emperor', cansee: false},
        {uuid: sdc,     login: 'sdc',     cansee: true},
    ],
    // 4. vader and luke can see 'i-am-your-father'
    'i-am-your-father': [
        {uuid: vader,   login: 'vader',   cansee: true},
        {uuid: luke,    login: 'luke',    cansee: true},
        {uuid: emperor, login: 'emperor', cansee: false},
        {uuid: sdc,     login: 'sdc',     cansee: false},
    ],
    // 5. only vader can see 'come-to-the-dark-side'
    'come-to-the-dark-side': [
        {uuid: vader,   login: 'vader',   cansee: true},
        {uuid: luke,    login: 'luke',    cansee: false},
        {uuid: emperor, login: 'emperor', cansee: false},
        {uuid: sdc,     login: 'sdc',     cansee: false},
    ],
    // 6. only vader can see 'he-will-join-us-or-die'
    'he-will-join-us-or-die': [
        {uuid: vader,   login: 'vader',   cansee: true},
        {uuid: luke,    login: 'luke',    cansee: false},
        {uuid: emperor, login: 'emperor', cansee: false},
        {uuid: sdc,     login: 'sdc',     cansee: false},
    ],
};
Object.keys(data).forEach(function (name) {
    test(format('ListImages: who can see "%s"?', name), function (t) {
        var self = this;
        var users = data[name];
        async.forEach(users, function (user, next) {
            var opts = {user: user.uuid, state: 'all'};
            self.imgapiClient.listImages(opts, function (err, images) {
                if (err) {
                    return next(err);
                }
                var names = images.map(function (i) { return i.name });
                if (user.cansee) {
                    t.ok(names.indexOf(name) !== -1,
                        format('user %s can see image %s', user.login, name));
                } else {
                    t.equal(names.indexOf(name), -1,
                        format('user %s cannot see image %s', user.login, name));
                }
                next();
            });
        }, function (err2) {
            t.ifError(err2, err2);
            t.end();
        });
    });
})

// Ensure the same visibilities for GetImage.
Object.keys(data).forEach(function (name) {
    test(format('GetImage: who can see "%s"?', name), function (t) {
        var self = this;
        var imageUuid = imageUuidFromName[name];
        var users = data[name];
        async.forEach(users, function (user, next) {
            self.imgapiClient.getImage(imageUuid, user.uuid, function (err, image) {
                if (!user.cansee) {
                    t.ok(err);
                    t.equal(err.statusCode, 404,
                        format('user %s cannot see image %s', user.login,
                               name));
                    t.notOk(image);
                } else {
                    t.equal(image.uuid, imageUuid,
                        format('user %s can see image %s', user.login, name));
                    t.ifError(err, err);
                }
                next();
            });
        }, function (err2) {
            t.ifError(err2, err2);
            t.end();
        });
    });
})

