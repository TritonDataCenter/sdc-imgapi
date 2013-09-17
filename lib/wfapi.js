/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var format = require('util').format;

var assert = require('assert-plus');
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

    this.tasks = options.workflows;
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
        attemptInitWorkflows.call(self, cb);
    }

    timeout = setTimeout(timeoutCallback, 10000);
}



/*
 * Takes care of figuring out if clients are passing request-id or x-request-id.
 */
function getRequestHeaders(req) {
    if (req.headers['x-request-id']) {
        return { 'x-request-id': req.headers['x-request-id'] };
    } else {
        return {};
    }
}



/*
 * Queues an 'create image from VM' job.
 *
 * @param options {Object} Required.
 *      - req {Object} Required.
 *      - vmUuid {String} Required.
 *      - manifest {Object} Required.
 *      - incremental {Boolean} Required.
 * @param cb {Function} `function (err, jobUuid)`
 */
Wfapi.prototype.createImageFromVmJob = function (options, cb) {
    var self = this;
    assert.object(options, 'options');
    assert.object(options.req, 'options.req');
    assert.string(options.vmUuid, 'options.vmUuid');
    assert.object(options.manifest, 'options.manifest');
    assert.bool(options.incremental, 'options.incremental');

    var params = {
        image_uuid: options.manifest.uuid,
        vm_uuid: options.vmUuid,
        compression: 'gzip',   // Yah, we hardcode gzip here for now.
        incremental: options.incremental,
        manifest: options.manifest,
        task: 'create-from-vm',
        target: format('/create-from-vm-%s', options.vmUuid)
    };
    var jobOpts = { headers: getRequestHeaders(options.req) };

    self.client.createJob(params.task, params, jobOpts, function (err, job) {
        if (err) {
            return cb(err);
        }
        params.job_uuid = job.uuid;
        self.log.debug(params, 'Create from VM job params');
        return cb(null, job.uuid);
    });
};



/*
 * Queues an 'import remote image' job.
 */
Wfapi.prototype.createImportRemoteImageJob = function (options, cb) {
    assert.object(options, 'options');
    assert.object(options.req, 'options.req');
    assert.string(options.uuid, 'options.uuid');
    assert.optionalString(options.origin, 'options.origin');
    assert.string(options.source, 'options.source');
    assert.object(options.manifest, 'options.manifest');
    assert.bool(options.skipOwnerCheck, 'options.skipOwnerCheck');
    assert.func(cb, 'cb');

    var self = this;
    var params = {
        origin: options.origin,
        image_uuid: options.uuid,
        source: options.source,
        manifest: options.manifest,
        skip_owner_check: options.skipOwnerCheck,
        task: 'import-remote-image',
        target: format('/import-remote-%s', options.uuid)
    };
    var jobOpts = { headers: getRequestHeaders(options.req) };

    self.client.createJob(params.task, params, jobOpts, function (err, job) {
        if (err) {
            return cb(err);
        }

        params.job_uuid = job.uuid;
        self.log.debug({params: params}, 'Import remote image job params');
        return cb(null, job.uuid);
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
Wfapi.prototype.listImageJobs = function (uuid, params, cb) {
    var self = this;
    var tasks;
    var query = { image_uuid: uuid };

    if (params.execution) {
        query.execution = params.execution;
    }
    if (params.task) {
        tasks = [ params.task ];
    } else {
        tasks = this.tasks;
    }

    var filtered = [];
    var done = 0;
    tasks.forEach(function (task) {
        query.task = task;
        self.client.listJobs(query, function (err, jobs) {
            if (err) {
                cb(err);
                return;
            }

            filtered = filtered.concat(jobs);
            done++;
            if (done == tasks.length) {
                cb(null, filtered);
            }
        });
    });
};



module.exports = Wfapi;
