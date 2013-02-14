/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');

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



var workflow = module.exports = {
    name: 'create-from-snapshot-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'create_from_snapshot',
        timeout: 10,
        retry: 1,
        body: dummyCreate,
        modules: {}
    }],
    timeout: 10,
    onerror: [ {
        name: 'On error',
        modules: {},
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
