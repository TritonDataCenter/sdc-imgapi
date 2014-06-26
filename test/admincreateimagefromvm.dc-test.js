/*
 * Copyright (c) 2014 Joyent Inc. All rights reserved.
 *
 * Test CreateImageFromVm endpoint.
 */

var p = console.log;
var format = require('util').format;
var exec = require('child_process').exec;
var crypto = require('crypto');
var fs = require('fs');
var dns = require('dns');
var https = require('https');
var async = require('async');
var restify = require('restify');
var genUuid = require('libuuid');

var IMGAPI = require('sdc-clients').IMGAPI;
var DSAPI = require('sdc-clients/lib/dsapi');

// Needed for provisioning
var VMAPI = require('sdc-clients').VMAPI;
var NAPI = require('sdc-clients').NAPI;
var CNAPI = require('sdc-clients').CNAPI;


// node-tap API
if (require.cache[__dirname + '/tap4nodeunit.js'])
    delete require.cache[__dirname + '/tap4nodeunit.js'];
var tap4nodeunit = require('./tap4nodeunit.js');
var after = tap4nodeunit.after;
var before = tap4nodeunit.before;
var test = tap4nodeunit.test;



//---- globals

// Require base@14.1.0 installed. Note that
// globe-theatre.git/bin/stage-test-imgapi does this for us.
var TEST_IMAGE_UUID = 'caac17a4-d512-11e3-9d41-b756aebcb18f';


var NETWORK = null;
var SERVER = null;
var VM = null;
var IMAGE = null;

var CAN_RUN_TEST = (process.env.VMAPI_URL !== undefined &&
                    process.env.NAPI_URL !== undefined &&
                    process.env.CNAPI_URL !== undefined &&
                    process.env.UFDS_ADMIN_UUID !== undefined &&
                    (process.env.IMGAPI_IMAGE_CREATION_ENABLED === true ||
                        process.env.IMGAPI_IMAGE_CREATION_ENABLED === 'true'));
if (!CAN_RUN_TEST) {
    console.warn('WARNING: skipping image creation tests (CAN_RUN_TEST=false)');
}

function createManifest() {
    var uuid = genUuid.create();
    return {
        name: 'custom-image-' + uuid,
        version: '1.0.0',
        uuid: uuid,
        owner: process.env.UFDS_ADMIN_UUID
    };
}

function waitForState(vmapi, state, callback) {
    var TIMEOUT = 90;
    var times = 0;

    function check() {
        return vmapi.getVm({ uuid: VM }, function (err, vm) {
            if (err) {
                return callback(err);
            }

            if (vm.state === state) {
                times = 0;
                return callback(null);
            }

            times++;
            if (times == TIMEOUT) {
                return callback(new Error('Timeout after ' +
                    TIMEOUT + ' seconds'));
            }

            return setTimeout(check, 1000);
        });
    }
    return check();
}


//---- tests

before(function (next) {
    var self = this;
    this.client = new IMGAPI({url: process.env.IMGAPI_URL, agent: false});

    if (!CAN_RUN_TEST) {
        return next();
    }

    var vmapi = this.vmapi = new VMAPI({
        url: process.env.VMAPI_URL,
        agent: false
    });

    // Don't create this VM more than once
    if (VM) {
        return next();
    }

    var napi = new NAPI({url: process.env.NAPI_URL, agent: false});
    var cnapi = new CNAPI({url: process.env.CNAPI_URL, agent: false});

    async.waterfall([
        function ensureImage(cb) {
            self.client.getImage(TEST_IMAGE_UUID, function (err, img) {
                if (err) {
                    console.error('error: the test image %s is not ' +
                        'imported from images.joyent.com', TEST_IMAGE_UUID);
                }
                cb(err);
            });
        },
        function getNetwork(cb) {
            napi.listNetworks({}, function (err, networks) {
                if (err) {
                    return cb(err);
                }
                NETWORK = networks[0].uuid;
                return cb();
            });
        },
        function getServer(cb) {
            cnapi.listServers(function (err, servers) {
                if (err) {
                    return cb(err);
                }
                servers = servers.filter(function (server) {
                    return (server.headnode);
                });
                SERVER = servers[0];
                return cb();
            });
        },
        function createVm(cb) {
            var payload = {
                alias: 'imgapi-test-' + genUuid.create(),
                owner_uuid: process.env.UFDS_ADMIN_UUID,
                image_uuid: TEST_IMAGE_UUID,
                networks: NETWORK,
                brand: 'joyent',
                ram: 128,
                server_uuid: SERVER.uuid
            };
            p('Create test VM (alias=%s)', payload.alias);

            vmapi.createVm(payload, function (err, job) {
                if (err) {
                    return cb(err);
                }
                VM = job.vm_uuid;
                setTimeout(function () {
                    return cb();
                }, 1000);
            });
        },
        function waitForVm(cb) {
            waitForState(vmapi, 'running', function (err) {
                if (err) {
                    return cb(err);
                }
                return cb();
            });
        }
    ], function (err) {
        next(err);
    });
});


if (CAN_RUN_TEST)
test('CreateImageFromVm should not work for an nonexistent VM', function (t) {
    this.client.createImageFromVmAndWait(createManifest(),
        { vm_uuid: genUuid.create() },
      function (err, image) {
        t.ok(err, 'got an error as expected');
        t.end();
    });
});


if (CAN_RUN_TEST)
test('CreateImageFromVm should create the image', function (t) {
    var self = this;

    async.waterfall([
        function createFromVm(cb) {
            self.client.createImageFromVmAndWait(createManifest(),
                { vm_uuid: VM },
              function (err, image) {
                if (err) {
                    return cb(err);
                }
                IMAGE = image;
                t.ok(image, 'got image');
                t.ok(image.files, 'image has files');
                t.ok(image.type, 'image has a type');
                t.ok(image.published_at, 'image is published');
                t.equal(image.state, 'active', 'image is active');
                cb();
            });
        }
    ], function (err) {
            t.ifError(err, 'unexpected error');
            t.end();
        }
    );
});


after(function (next) {
    if (!CAN_RUN_TEST || !IMAGE) {
        return next();
    }

    var vmapi = this.vmapi;
    async.waterfall([
        function deleteVm(cb) {
            p('Destroy test VM %s', VM);
            vmapi.deleteVm({ uuid: VM }, function (err, job) {
                if (err) {
                    return cb(err);
                }
                return cb();
            });
        },
        function waitForVm(cb) {
            waitForState(vmapi, 'destroyed', function (err) {
                if (err) {
                    return cb(err);
                }
                return cb();
            });
        }
    ], function (err) {
            next(err);
        }
    );
});
