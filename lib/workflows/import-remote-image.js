/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var async = require('async');
var imgapiUrl;

var VERSION = '7.0.7';



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

function originImportImages(job, cb) {
    if (!job.params.origins) {
        return cb(null, 'No origins (skipping import of origins)');
    }

    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});

    async.mapSeries(job.params.origins, importRemoteImage, afterImports);

    function importRemoteImage(origin, next) {
        async.series([
            function importImg(impNext) {
                var query = { uuid: origin };
                var opts = {
                    skipOwnerCheck: job.params.skip_owner_check,
                    source: job.params.source
                };
                imgapi.adminImportImage(query, opts, function (err, image) {
                    if (err) {
                        job.log.info(err, 'failed to create image %s', origin);
                        return impNext(err);
                    }
                    return impNext();
                });
            },
            function addFile(impNext) {
                var opts = {
                    uuid: origin,
                    source: job.params.source
                };
                imgapi.addImageFile(opts, function (err) {
                    if (err) {
                        job.log.info(err, 'failed to add image file for %s',
                            origin);
                        return impNext(err);
                    }
                    return impNext();
                });
            },
            function activate(impNext) {
                imgapi.activateImage(origin, function (err) {
                    if (err) {
                        job.log.info(err, 'failed to activate image %s',
                            origin);
                        return impNext(err);
                    }
                    return impNext();
                });
            }
        ], next);
    }

    function afterImports(err) {
        if (err) {
            job.log.info(err, 'failed to import image origins');
            return cb(err);
        }
        return cb(null, 'Image origins have been imported');
    }
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


function deleteImage(job, cb) {
    var uuid = job.params.image_uuid;
    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});
    imgapi.deleteImage(uuid, function (err) {
        if (!err) {
            cb(null, 'Image ' + uuid + ' deleted');
        } else if (err.restCode === 'ResourceNotFound') {
            cb(null, 'Image ' + uuid + ' did not exist to be deleted');
        } else {
            job.log.info(err, 'failed to delete image %s', uuid);
            cb(err);
        }
    });
}


function originDeleteImages(job, cb) {
    if (!job.params.origins) {
        return cb(null, 'No origin images to delete');
    }
    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});

    var originsToDelete = job.params.origins.slice().reverse();
    async.mapSeries(originsToDelete, deleteOriginImage, afterDelete);

    function deleteOriginImage(origin, next) {
        imgapi.deleteImage(origin, function (err) {
            if (!err) {
                next();
            } else if (err.restCode === 'ResourceNotFound') {
                // Just means we never got to creating this one.
                next();
            } else {
                job.log.info(err, 'failed to delete image %s', origin);
                next(err);
            }
        });
    }

    function afterDelete(err) {
        if (err) {
            job.log.info(err, 'failed to delete origin images');
            return cb(err);
        }
        return cb(null, 'Origin images have been deleted');
    }
}





var workflow = module.exports = {
    name: 'import-remote-image-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'origin_import_images',
        timeout: 3600,
        retry: 1,
        body: originImportImages,
        modules: {
            sdcClients: 'sdc-clients',
            async: 'async'
        }
    }, {
        name: 'import_image',
        timeout: 60,
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
    timeout: 7250,
    onerror: [ {
        name: 'delete_image',
        timeout: 60,
        retry: 1,
        body: deleteImage,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'origin_delete_images',
        timeout: 60,
        retry: 1,
        body: originDeleteImages,
        modules: {
            sdcClients: 'sdc-clients',
            async: 'async'
        }
    }, {
        name: 'On error',
        modules: {},
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }],
    oncancel: [ {
        name: 'delete_image',
        timeout: 10,
        retry: 1,
        body: deleteImage,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'origin_delete_images',
        timeout: 10,
        retry: 1,
        body: originDeleteImages,
        modules: {
            sdcClients: 'sdc-clients',
            async: 'async'
        }
    }]
};
