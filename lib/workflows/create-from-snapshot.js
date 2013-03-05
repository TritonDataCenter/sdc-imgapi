/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var imgapiUrl;

var VERSION = '7.0.0';


/*
 * This workflow will basically do three things:
 * - Call CNAPI to snapshot a zone and pack the snapshot into a tar
 * - Call imgadm to upload that file for the image
 * - Activate the image if everything went ok
 */
function dummyCreate(job, cb) {
    return cb(null, 'Image created!');
}


function updateWithError(job, cb) {
    if (job.error === undefined) {
        return cb(null, 'Job error object was not passed');
    }

    var imgapi = new sdcClients.IMGAPI({ url: imgapiUrl });
    var image = job.params.image_uuid;
    var error = { message: String(job.error) };

    if (job.error.code || job.error.restCode) {
        error.code =  job.error.code || job.error.restCode;
    }

    var mod = {
        state: 'error',
        error: error
    };

    imgapi.updateImage(image, mod, function (err, img, res) {
        if (err) {
            return cb(err, 'Could not update image with publish error');
        }

        return cb(null, 'Image updated with publish error');
    });
}


var workflow = module.exports = {
    name: 'create-from-snapshot-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'create_from_snapshot',
        timeout: 10,
        retry: 1,
        body: dummyCreate,
        modules: { sdcClients: 'sdc-clients' }
    }],
    timeout: 10,
    onerror: [{
        name: 'update_with_error',
        body: updateWithError,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'On error',
        modules: {},
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
