/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var imgapiUrl;

var VERSION = '7.0.0';


function importImage(job, cb) {
    var log = job.log;
    var imgapi = new sdcClients.IMGAPI({ url: imgapiUrl });
    var uuid = job.params.image_uuid;
    var opts = {
        skipOwnerCheck: job.params.skip_owner_check,
        source: job.params.source
    };

    imgapi.adminImportImage({ uuid: uuid }, opts, function (err, image) {
        if (err) {
            log.info(err, 'failed to create image %s',
                job.params.image_uuid);
            return cb(err);
        }

        return cb(null, 'Image created');
    });
}



function addImageFile(job, cb) {
    var log = job.log;
    var imgapi = new sdcClients.IMGAPI({ url: imgapiUrl });

    var opts = {
        uuid: job.params.image_uuid,
        source: job.params.source
    };

    imgapi.addImageFile(opts, function (err) {
        if (err) {
            log.info(err, 'failed to add image file for %s',
                job.params.image_uuid);
            return cb(err);
        }
        return cb(null, 'Image file added');
    });
}



function activateImage(job, cb) {
    var log = job.log;
    var imgapi = new sdcClients.IMGAPI({ url: imgapiUrl });

    imgapi.activateImage(job.params.image_uuid, function (err) {
        if (err) {
            log.info(err, 'failed to activate image %s',
                job.params.image_uuid);
            return cb(err);
        }

        return cb(null, 'Image activated');
    });
}



function deleteImage(job, cb) {
    var log = job.log;
    var imgapi = new sdcClients.IMGAPI({ url: imgapiUrl });

    imgapi.deleteImage(job.params.image_uuid, function (err) {
        if (err) {
            log.info(err, 'failed to delete image %s',
                job.params.image_uuid);
            return cb(err);
        }

        return cb(null, 'Image deleted');
    });
}



var workflow = module.exports = {
    name: 'import-remote-image-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'import_image',
        timeout: 10,
        retry: 1,
        body: importImage,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'add_image_file',
        timeout: 3600,
        retry: 1,
        body: addImageFile,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'activate_image',
        timeout: 10,
        retry: 1,
        body: activateImage,
        modules: { sdcClients: 'sdc-clients' }
    }],
    timeout: 3630,
    onerror: [{
        name: 'delete_image',
        timeout: 10,
        retry: 1,
        body: deleteImage,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'On error',
        modules: {},
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
