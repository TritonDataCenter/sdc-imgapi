/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var restify = require('restify');
var url = require('url');

// node-tap API
if (require.cache[__dirname + '/tap4nodeunit.js']) {
    delete require.cache[__dirname + '/tap4nodeunit.js'];
}

var tap4nodeunit = require('./tap4nodeunit.js');
var after = tap4nodeunit.after;
var before = tap4nodeunit.before;
var test = tap4nodeunit.test;

var metricsClient;

function createMetricsClient(adminIp) {
    var imgapiUrl = adminIp ? 'http://' + adminIp : 'http://localhost';
    var parsedUrl = url.parse(imgapiUrl);
    parsedUrl.port = 8881;
    parsedUrl.host = null;

    var metricsUrl = url.format(parsedUrl);
    var client = restify.createStringClient({
        connectTimeout: 250,
        rejectUnauthorized: false,
        retry: false,
        url: metricsUrl
    });

    return client;
}

before(function (next) {
    metricsClient = createMetricsClient();
    next();
});

test('metrics handler', function (t) {
    metricsClient.get('/metrics', function getMetrics(err, req, res, data) {
       t.ok(err, 'Metrics error');
       t.notOk(data, 'data');
       t.equal(err.code, 'ECONNREFUSED', 'Metrics server not running');
       t.end();
    });
});
