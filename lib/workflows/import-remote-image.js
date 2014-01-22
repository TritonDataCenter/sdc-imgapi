/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var imgapiUrl;

var VERSION = '7.0.1';



function importImage(job, cb) {
    var uuid = job.params.image_uuid;
    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});
    var opts = {
        skipOwnerCheck: job.params.skip_owner_check,
        source: job.params.source
    };
    imgapi.adminImportImage({uuid: uuid}, opts, function (err, image) {
        if (err) {
            job.log.info(err, 'failed to create image %s', uuid);
            return cb(err);
        }
        return cb(null, 'Image ' + uuid + ' created');
    });
}

function originImportImage(job, cb) {
    if (!job.params.origin) {
        return cb(null, 'No origin (skipping origin image import)');
    }
    var uuid = job.params.origin;
    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});
    var opts = {
        skipOwnerCheck: job.params.skip_owner_check,
        source: job.params.source
    };
    imgapi.adminImportImage({uuid: uuid}, opts, function (err, image) {
        if (err) {
            job.log.info(err, 'failed to create image %s', uuid);
            return cb(err);
        }
        return cb(null, 'Image ' + uuid + ' created');
    });
}


function addImageFile(job, cb) {
    var uuid = job.params.image_uuid;
    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});
    var opts = {
        uuid: uuid,
        source: job.params.source
    };
    imgapi.addImageFile(opts, function (err) {
        if (err) {
            job.log.info(err, 'failed to add image file for %s', uuid);
            return cb(err);
        }
        return cb(null, 'Image ' + uuid + ' file added');
    });
}

function originAddImageFile(job, cb) {
    if (!job.params.origin) {
        return cb(null, 'Skipping origin image file add (no origin)');
    }
    var uuid = job.params.origin;
    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});
    var opts = {
        uuid: uuid,
        source: job.params.source
    };
    imgapi.addImageFile(opts, function (err) {
        if (err) {
            job.log.info(err, 'failed to add image file for %s', uuid);
            return cb(err);
        }
        return cb(null, 'Image ' + uuid + ' file added');
    });
}


function activateImage(job, cb) {
    var uuid = job.params.image_uuid;
    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});
    imgapi.activateImage(uuid, function (err) {
        if (err) {
            job.log.info(err, 'failed to activate image %s', uuid);
            return cb(err);
        }
        return cb(null, 'Image ' + uuid + ' activated');
    });
}

function originActivateImage(job, cb) {
    if (!job.params.origin) {
        return cb(null, 'Skipping origin image activate (no origin)');
    }
    var uuid = job.params.origin;
    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});
    imgapi.activateImage(uuid, function (err) {
        if (err) {
            job.log.info(err, 'failed to activate image %s', uuid);
            return cb(err);
        }
        return cb(null, 'Image ' + uuid + ' activated');
    });
}


function deleteImage(job, cb) {
    var uuid = job.params.image_uuid;
    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});
    imgapi.deleteImage(uuid, function (err) {
        if (err) {
            job.log.info(err, 'failed to delete image %s', uuid);
            return cb(err);
        }
        return cb(null, 'Image ' + uuid + ' deleted');
    });
}

function originDeleteImage(job, cb) {
    if (!job.params.origin) {
        return cb(null, 'Skipping origin image delete (no origin)');
    }
    var uuid = job.params.origin;
    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});
    imgapi.deleteImage(uuid, function (err) {
        if (err) {
            job.log.info(err, 'failed to delete image %s', uuid);
            return cb(err);
        }
        return cb(null, 'Image ' + uuid + ' deleted');
    });
}





var workflow = module.exports = {
    name: 'import-remote-image-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'origin_import_image',
        timeout: 10,
        retry: 1,
        body: originImportImage,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'origin_add_image_file',
        timeout: 3600,
        retry: 1,
        body: originAddImageFile,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'origin_activate_image',
        timeout: 10,
        retry: 1,
        body: originActivateImage,
        modules: { sdcClients: 'sdc-clients' }
    }, {
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
    onerror: [ {
        name: 'origin_delete_image',
        timeout: 10,
        retry: 1,
        body: originDeleteImage,
        modules: { sdcClients: 'sdc-clients' }
    }, {
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
