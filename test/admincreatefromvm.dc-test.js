/*
 * Copyright (c) 2012 Joyent Inc. All rights reserved.
 *
 * Test CreateImageFromVm endpoint.
 */

var format = require('util').format;
var exec = require('child_process').exec;
var crypto = require('crypto');
var fs = require('fs');
var dns = require('dns');
var https = require('https');
var async = require('async');
var restify = require('restify');
var genUuid = require('node-uuid');

//var IMGAPI = require('sdc-clients').IMGAPI;   // temp broken by TOOLS-211
var IMGAPI = require('sdc-clients/lib/imgapi');
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
function skiptest() {} // quick hack to comment out a test



//---- globals

var vader = '86055c40-2547-11e2-8a6b-4bb37edc84ba';
var luke = '91ba0e64-2547-11e2-a972-df579e5fddb3';
var sdc = 'ba28f844-8cb4-f141-882d-46d6251e6a9f';
var SMARTOS = '01b2c898-945f-11e1-a523-af1afbe22822';
var IMAGES_JOYENT_COM_IP = null;
var DATASETS_JOYENT_COM_IP = null;
var NETWORK = null;
var SERVER = null;
var VM = null;
var IMAGE = null;

var CAN_RUN_TEST = (process.env.VMAPI_URL !== undefined &&
                    process.env.NAPI_URL !== undefined &&
                    process.env.CNAPI_URL !== undefined &&
                    process.env.UFDS_ADMIN_UUID !== undefined);

var MANIFEST = {
    name: 'custom-image',
    version: '1.0.0',
    uuid: genUuid(),
    owner: process.env.UFDS_ADMIN_UUID
};

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
                alias: 'imgapi-test-' + genUuid(),
                owner_uuid: process.env.UFDS_ADMIN_UUID,
                image_uuid: SMARTOS,
                networks: NETWORK,
                brand: 'joyent-minimal',
                ram: 64,
                server_uuid: SERVER.uuid
            };

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
        }
    );
});


if (CAN_RUN_TEST)
test('CreateFromVm should not work for an inexistent VM', function (t) {
    this.client.createFromVmAndWait(MANIFEST, { vm_uuid: genUuid() },
      function (err, image) {
        t.ok(err, 'got expected error');
        t.end();
    });
});


if (CAN_RUN_TEST)
test('CreateFromVm should not work for a running VM', function (t) {
    this.client.createFromVmAndWait(MANIFEST, { vm_uuid: VM },
      function (err, image) {
        t.ok(err, 'got expected error');
        t.end();
    });
});


if (CAN_RUN_TEST)
test('CreateFromVm should create the image', function (t) {
    var vmapi = this.vmapi;
    var self = this;

    async.waterfall([
        function stopVm(cb) {
            vmapi.stopVm({ uuid: VM }, function (err, job) {
                if (err) {
                    return cb(err);
                }
                return cb();
            });
        },
        function waitForVm(cb) {
            waitForState(vmapi, 'stopped', function (err) {
                if (err) {
                    return cb(err);
                }
                return cb();
            });
        },
        function createFromVm(cb) {
            self.client.createFromVmAndWait(MANIFEST, { vm_uuid: VM },
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