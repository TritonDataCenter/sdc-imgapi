/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var uuid = require('node-uuid');
var format = require('util').format;
var WfClient = require('wf-client');


// Workflows

// Absolute path from the app
var WORKFLOW_PATH = './lib/workflows/';


/*
 * WFAPI Constructor
 */
function Wfapi(options, log) {
    this.log = log.child({ component: 'wfapi' }, true);
    options.path = WORKFLOW_PATH;
    options.log = this.log;

    this.client = new WfClient(options);
    this.connected = false;
}



Wfapi.prototype.connect = function (cb) {
    this.log.debug('Loading the WFAPI workflows...');
    return attemptInitWorkflows.call(this, cb);
};



/*
 * Attemps to init all the workflows and retries until they all have been
 * created.
 */
function attemptInitWorkflows(cb) {
    var self = this;
    var timeout = null;

    this.client.initWorkflows(onInit);

    function onInit(err) {
        if (err) {
            self.log.error('Error loading workflows, retrying');
            self.connected = false;

            if (!timeout) {
                attemptInitWorkflows.call(self, cb);
            }
        } else {
            clearTimeout(timeout);
            timeout = null;
            self.connected = true;
            self.log.info('All workflows have been loaded');
            cb();
        }
    }

    function timeoutCallback() {
        attemptInitWorkflows.call(self);
    }

    timeout = setTimeout(timeoutCallback, 10000);
}



/*
 * Queues a image from snapshot job.
 */
Wfapi.prototype.createImageFromSnapshotJob = function (image, snapshot, cb) {
    var self = this;
    var params = { image_uuid: image, snapshot: snapshot };

    params.task = 'create-from-snapshot';
    params.target =  format('/create-%s-from-snapshot-%s', image, snapshot);

    self.client.createJob('create-from-snapshot', params, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        params.job_uuid = job.uuid;
        self.log.debug(params, 'Image from snapshot job queued for Image');
        cb(null, job.uuid);
    });
};



/*
 * Retrieves a job from WFAPI.
 */
Wfapi.prototype.getJob = function (jobUuid, cb) {
    this.client.getJob(jobUuid, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        cb(null, job);
    });
};



/*
 * Lists jobs from WFAPI.
 */
Wfapi.prototype.listJobs = function (params, cb) {
    var query = {};

    if (params.execution) {
        query.execution = params.execution;
    }

    if (params.task) {
        query.task = params.task;
    }

    if (params.image_uuid) {
        query.image_uuid = params.image_uuid;
    }

    this.client.listJobs(query, function (err, jobs) {
        if (err) {
            cb(err);
            return;
        }

        cb(null, jobs);
    });
};



module.exports = Wfapi;
