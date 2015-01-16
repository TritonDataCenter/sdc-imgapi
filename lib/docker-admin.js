/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Docker Admin client
 */

var assert = require('assert-plus');
var restify = require('restify');
var vasync = require('vasync');


function DockerAdmin(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.string(options.url, 'options.url');

    this.log = options.log;
    this.url = options.url;

    this.client = restify.createJsonClient({ url: this.url });
    this.queue = vasync.queue(this._writeProgress.bind(this), 5);
}

DockerAdmin.prototype._writeProgress = function (args, callback) {
    assert.object(args, 'args');
    assert.object(args.payload, 'args.payload');
    assert.string(args.repo, 'args.repo');

    var log = this.log;
    var payload = args.payload;

    payload.id = payload.id.substr(0, 12);

    if (!payload.progressDetail) {
        payload.progressDetail = {};
    }
    var data = {
        id: args.repo,
        payload: payload
    };

    this.client.post('/admin/progress', data, function (err, req, res) {
        if (err) {
            log.warn(err, 'Could not post progress for %s', args.repo);
            callback(err);
        } else {
            log.debug('Posted progress for %s %j', args.repo, data);
            callback();
        }
    });
};

DockerAdmin.prototype.sendProgress = function (args) {
    assert.object(args, 'args');
    assert.object(args.payload, 'args.payload');
    assert.string(args.repo, 'args.repo');

    this.queue.push(args);
};

DockerAdmin.prototype.closeQueue = function () {
    this.queue.close();
};


module.exports = DockerAdmin;