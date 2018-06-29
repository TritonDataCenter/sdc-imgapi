/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Test cross-DC image copying.
 */

var path = require('path');
var util = require('util');

var sdcClients = require('sdc-clients');
var uuid = require('uuid');
var vasync = require('vasync');

var mockImgapi = require('./mock/imgapi');

/* Globals */

var CAN_RUN_TEST = process.env.IMGAPI_XDC_ENABLED === 'true';
if (!CAN_RUN_TEST) {
    console.warn('WARNING: skipping xdc tests (IMGAPI_XDC_ENABLED!=true)');
}

var ACCOUNT_ADMIN = 'ba28f844-8cb4-f141-882d-46d6251e6a9f';
var ACCOUNT_VADER = '86055c40-2547-11e2-8a6b-4bb37edc84ba';

/* Public image in remote DC which must be owned by admin */
var ADMIN_IMAGE = '7a1b1967-6ecf-1e4c-8f09-f49094cc36ad';

/* Existing private image that must exist in both DCs */
var EXISTING_IMAGE = '9f819499-8298-9842-8cc5-1c2838196ab4';

/* Private image in the remote DC, owned by Vader */
var PRIVATE_IMAGE = 'f3078f0c-a53b-4140-b7af-fbb6308a8e35';

/* Private incremental image in the remote DC, owned by Vader. */
var PRIVATE_INC_IMAGE = '649d6948-4f1d-11e8-8249-1b9928638559';

/* Origin chain for PRIVATE_INC_IMAGE, the first one is the base image. */
var PRIVATE_INC_IMAGE_ORIGIN_CHAIN = [
    'c58161c0-2547-11e2-a75e-9fdca1940570', /* base - public and admin owned */
    '900cffef-55e3-4e7d-b7ec-ccf439a159e3', /* vader owned inc image */
    '15963d90-61d7-4664-87a6-f56b16492d5a', /* vader owned inc image */
    PRIVATE_INC_IMAGE                       /* vader owned inc image */
];

var IMGAPI_URL = process.env.IMGAPI_URL || 'http://localhost';
var MOCK_IMGAPI_PORT = 8082;
var TEST_DC_NAME = 'TestDc';

var imgapi;
var mockServer;

/* Helpers */

function deleteOneImage(imageUuid, t, callback) {
    imgapi.deleteImage(imageUuid, ACCOUNT_VADER,
            function _delIncrementalImgCb(err) {
        // Allow a 404 error.
        if (!err || err.statusCode !== 404) {
            t.ok(!err, 'should be no error deleting image');
        }
        callback();
    });
}

function deleteIncrementalImages(t, callback) {
    vasync.forEachPipeline({
        inputs: PRIVATE_INC_IMAGE_ORIGIN_CHAIN.slice(1).reverse(),
        func: function deleteLayerN(imageUuid, next) {
            deleteOneImage(imageUuid, t, next);
        }
    }, callback);
}

function removeTestImages(t, callback) {
    vasync.pipeline({funcs: [
        function deletePrivateImage(_, next) {
            deleteOneImage(PRIVATE_IMAGE, t, next);
        },
        function deleteIncImages(_, next) {
            deleteIncrementalImages(t, next);
        }
    ]}, callback);
}

/* Tests */

if (CAN_RUN_TEST)
exports['x-DC'] = {

    setup: function _testModuleSetup(t) {
        imgapi = new sdcClients.IMGAPI({
            url: IMGAPI_URL,
            agent: false
        });
        t.ok(imgapi, 'setup imgapi client');

        var mockOpts = {
            adminAccount: ACCOUNT_ADMIN,
            imagesDir: path.join(__dirname, 'data/xdc'),
            port: MOCK_IMGAPI_PORT
        };
        mockImgapi.setupServer(mockOpts, function (err, server) {
            if (err) {
                t.done(err);
                return;
            }
            mockServer = server;
            t.ok(mockServer, 'setup imock server');

            removeTestImages(t, function _onRemoveTestImgCb(err2) {
                t.ok(!err2, 'removeTestImages should not fail');
                t.done();
            });
        });
    },

    'invalid account test': function (t) {
        var unknownAccount = uuid.v4();
        imgapi.importImageFromDatacenterAndWait(PRIVATE_IMAGE,
                unknownAccount, {datacenter: TEST_DC_NAME},
                function _invalidAccountCb(err) {
            t.ok(err, 'expected import image to return an error');
            if (err) {
                t.equal(err.statusCode, 404, 'err.statusCode should be 404');
                t.ok(err.body, 'err.body');
                if (err.body) {
                    t.equal(err.body.code, 'NotFoundError',
                        'err.body should be a NotFoundError error');
                }
            }
            t.done();
        });
    },

    'unknown DC test': function (t) {
        imgapi.importImageFromDatacenter(EXISTING_IMAGE, ACCOUNT_VADER,
                {datacenter: 'unknown'}, function _unknownDcCb(err) {
            t.ok(err, 'expected import to have an error');
            if (err) {
                t.equal(err.statusCode, 422, 'err.statusCode should be 422');
                t.ok(err.body, 'err.body');
                if (err.body) {
                    t.equal(err.body.code, 'ValidationFailed',
                        'err.body should be a ValidationFailed error');
                    var msg = err.body.message || '';
                    var containsTestDc = msg.indexOf(TEST_DC_NAME) > 0;
                    t.ok(containsTestDc, 'error message contains test dc name');
                }
            }
            t.done();
        });
    },

    'image already exists': function (t) {
        imgapi.importImageFromDatacenter(EXISTING_IMAGE, ACCOUNT_VADER,
                {datacenter: TEST_DC_NAME},
                function _alreadyExistsCb(err) {
            t.ok(err, 'expected import to have an error');
            if (err) {
                t.equal(err.statusCode, 409, 'err.statusCode should be 409');
                t.ok(err.body, 'err.body');
                if (err.body) {
                    t.equal(err.body.code, 'ImageUuidAlreadyExists',
                        'err.body should be a ImageUuidAlreadyExists error');
                }
            }
            t.done();
        });
    },

    'user cannot import an admin image': function (t) {
        imgapi.importImageFromDatacenter(ADMIN_IMAGE, ACCOUNT_VADER,
                {datacenter: TEST_DC_NAME},
                function _importAdminCb(err) {
            t.ok(err, 'expected import to have an error');
            if (err) {
                t.equal(err.statusCode, 401, 'err.statusCode should be 401');
                t.ok(err.body, 'err.body');
                if (err.body) {
                    t.equal(err.body.code, 'UnauthorizedError',
                        'err.body should be a UnauthorizedError error');
                }
            }
            t.done();
        });
    },

    'user cannot import into the same DC': function (t) {
        if (!process.env.IMGAPI_DC_NAME) {
            console.warn('Warning: skipping same DC import test - ' +
                'no process.env.IMGAPI_DC_NAME set');
            t.done();
            return;
        }
        imgapi.importImageFromDatacenter(EXISTING_IMAGE, ACCOUNT_VADER,
                {datacenter: process.env.IMGAPI_DC_NAME},
                function _importSameDcCb(err) {
            t.ok(err, 'expected import to have an error');
            if (err) {
                t.equal(err.statusCode, 422, 'err.statusCode should be 422');
                t.ok(err.body, 'err.body');
                if (err.body) {
                    t.equal(err.body.code, 'ValidationFailed',
                        'err.body should be a ValidationFailed error');
                }
            }
            t.done();
        });
    },

    /**
     * Import a private (owned by vader) single layer image.
     *
     * Result: This should import one new image.
     */
    'import image': function (t) {
        imgapi.importImageFromDatacenterAndWait(PRIVATE_IMAGE, ACCOUNT_VADER,
                {datacenter: TEST_DC_NAME},
                function _importIncCb(err, img) {
            t.ok(!err, 'import should not fail');
            t.ok(img, 'img');
            imgapi.getImage(PRIVATE_IMAGE, ACCOUNT_VADER,
                    function _incImportImageCb(err2, img2) {
                t.ok(!err2, 'getImage for imported image should not fail');
                t.ok(img2, 'img2');
                t.done();
            });
        });
    },

    /**
     * Import a private (owned by vader) multi-layer image, with the base image
     * layer being owned by the admin (i.e. operator image).
     *
     * Result: This should import three new images (2 intermediate layers).
     */
    'import incremental image': function (t) {
        imgapi.importImageFromDatacenterAndWait(PRIVATE_INC_IMAGE,
                ACCOUNT_VADER,
                {datacenter: TEST_DC_NAME},
                function _importIncCb(err, img) {
            t.ok(!err, 'import incremental image should not fail');
            t.ok(img, 'img');
            imgapi.getImage(PRIVATE_INC_IMAGE, ACCOUNT_VADER,
                    function _incImportImageCb(err2, img2) {
                t.ok(!err2, 'getImage for imported inc image should not fail');
                t.ok(img2, 'img2');
                t.done();
            });
        });
    },

    'delete incremental image layers': function (t) {
        deleteIncrementalImages(t, t.done.bind(t));
    },

    /**
     * Import a private (owned by vader) multi-layer image one layer at a time.
     * This is meant to test importing an image when a number of images in the
     * origin chain have already been imported.
     *
     * Result: This should import three new images.
     */
    'import incremental image in steps': function (t) {
        vasync.forEachPipeline({
            inputs: PRIVATE_INC_IMAGE_ORIGIN_CHAIN.slice(1),
            func: function importLayerN(imageUuid, next) {
                imgapi.importImageFromDatacenterAndWait(imageUuid,
                        ACCOUNT_VADER,
                        {datacenter: TEST_DC_NAME},
                        function _importIncNCb(err, img) {
                    t.ok(!err, 'import layer-n image should not fail');
                    t.ok(img, 'img');
                    imgapi.getImage(imageUuid, ACCOUNT_VADER,
                            function _importLayerNImageCb(err2, img2) {
                        t.ok(!err2,
                            'getImage for layer-n image should not fail');
                        t.ok(img2, 'img2');
                        next(err || err2);
                    });
                });
            }
        }, t.done.bind(t));
    },

    teardown: function _testModuleTeardown(t) {
        removeTestImages(t, function _teardownRemoveImagesCb(err) {
            t.ok(!err, 'removeTestImages should not fail');
            imgapi.close();

            if (mockServer) {
                mockServer.close();
            }

            t.done();
        });
    }
};
