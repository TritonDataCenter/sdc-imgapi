/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var loadConfig = require('../lib/config').loadConfig;
var format = require('util').format;
var imgapi = require('sdc-clients/lib/imgapi');
var restify = require('restify');
var url = require('url');
var vasync = require('vasync');

// node-tap API
if (require.cache[__dirname + '/tap4nodeunit.js']) {
    delete require.cache[__dirname + '/tap4nodeunit.js'];
}

var tap4nodeunit = require('./tap4nodeunit.js');
var after = tap4nodeunit.after;
var before = tap4nodeunit.before;
var test = tap4nodeunit.test;

function ifError(t, err) {
    t.ok(!err, err ? ('error: ' + err.message) : 'no error');
}

var config;
var imgapiClient;
var metricsClient;
var promLabels;

function createMetricsClient(adminIp) {
    var metricsUrl = format('http://%s:%d', adminIp, 8881);
    var client = restify.createStringClient({
        connectTimeout: 250,
        rejectUnauthorized: false,
        retry: false,
        url: metricsUrl
    });

    return client;
}

/*
 * The metrics endpoint returns metrics in the Prometheus v0.0.4 format.
 * This function takes the metrics response and a metric to match the metric
 * line you want to match as input and returns the count of that metric.
 */
function getMetricCount(metricsRes, metricsLabels) {
    var labels = promLabels.concat(metricsLabels);
    var metricsLines = metricsRes.split('\n');
    var metricLine = metricsLines.filter(function (line) {
        var match = true;
        labels.forEach(function (label) {
            var lineMatch = line.indexOf(label);
            if (lineMatch === -1) {
                match = false;
            }
        });

        return match;
    });
    var count = Number(metricLine[0].split('} ')[1]);
    return count;
}

function fetchMetricCount(metricsLabels, callback) {
    metricsClient.get('/metrics', function getMetrics(err, req, res, data) {
        var count = getMetricCount(data, metricsLabels);
        callback(err, count);
    });
}

function incrementPingCount(_, callback) {
    imgapiClient.ping(callback);
}

before(function (next) {
    var options = { url: process.env.IMGAPI_URL };
    if (process.env.IMGAPI_URL === 'https://images.joyent.com') {
        assert.ok(process.env.JOYENT_IMGADM_USER,
            'JOYENT_IMGADM_USER envvar is not set');
        assert.ok(process.env.JOYENT_IMGADM_IDENTITY,
            'JOYENT_IMGADM_IDENTITY envvar is not set');
        options.user = process.env.JOYENT_IMGADM_USER;
        options.sign = imgapi.cliSigner({
            keyId: process.env.JOYENT_IMGADM_IDENTITY,
            user: process.env.JOYENT_IMGADM_USER
        });
    }

    imgapiClient = imgapi.createClient(options);

    loadConfig({}, function (err, _config) {
        assert.ifError(err);
        assert.equal(_config.mode, 'dc', 'DC Mode');
        config = _config;

        metricsClient = createMetricsClient(config.adminIp);

        var shortUserAgent = imgapiClient.client.headers['user-agent']
            .split(' ')[0];
        promLabels = [
            format('datacenter="%s"', config.datacenterName),
            format('instance="%s"', config.instanceUuid),
            format('route="%s"', 'ping'),
            format('server="%s"', config.serverUuid),
            format('service="%s"', config.serviceName),
            format('status_code="%d"', 200),
            format('user_agent="%s"', shortUserAgent)
        ];
        next();
    });
});

test('metrics handler', function (t) {
    metricsClient.get('/metrics', function getMetrics(err, req, res, data) {
        ifError(t, err);
        t.ok(res, 'The response should exist');
        t.equal(res.statusCode, 200, 'The status code should be 200');
        t.ok(data, 'The data should exist');
        t.end();
    });
});

test('metrics counter', function (t) {
    var pingCount;
    var updatedPingCount;

    var metricsLabels = [ 'http_requests_completed' ];

    vasync.pipeline({
        funcs: [
            incrementPingCount,
            function getPingCount(ctx, next) {
                fetchMetricCount(metricsLabels, function (err, count) {
                    pingCount = count;
                    next();
                });
            },
            incrementPingCount,
            function getPingVmCount(ctx, next) {
                fetchMetricCount(metricsLabels, function (err, count) {
                    updatedPingCount = count;
                    next();
                });
            }
        ]
    }, function (err, results) {
        ifError(t, err);
        t.ok(updatedPingCount, 'updated ping count');
        t.ok(pingCount < updatedPingCount,
                'ping count should increase');
        t.end();
    });
});

test('metrics histogram counter', function (t) {
    var pingDurationCount;
    var updatedPingDurationCount;

    var metricsLabels = [
        format('le="%s"', '+Inf'),
        'http_request_duration_seconds'
    ];

    vasync.pipeline({
        funcs: [
            incrementPingCount,
            function getPingDurationCount(ctx, next) {
                fetchMetricCount(metricsLabels, function (err, count) {
                    pingDurationCount = count;
                    next();
                });
            },
            incrementPingCount,
            function getUpdatedPingDurationCount(ctx, next) {
                fetchMetricCount(metricsLabels, function (err, count) {
                    updatedPingDurationCount = count;
                    next();
                });
            }
        ]
    }, function (err, results) {
        ifError(t, err);
        t.ok(pingDurationCount, 'ping duration count');
        t.ok(updatedPingDurationCount, 'updated ping duration count');
        t.ok(pingDurationCount < updatedPingDurationCount,
                'ping duration count should increase');
        t.end();
    });
});
