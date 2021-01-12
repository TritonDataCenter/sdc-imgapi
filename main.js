#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

/*
 * Main entry-point for the Image API (IMGAPI) for Triton.
 */

var util = require('util');
var path = require('path');
var fs = require('fs');

var EffluentLogger = require('effluent-logger');
var nopt = require('nopt');
var restify = require('restify');
var bunyan = require('bunyan');
var assert = require('assert-plus');
var vasync = require('vasync');

var mod_config = require('./lib/config');
var createApp = require('./lib/app').createApp;
var objCopy = require('./lib/utils').objCopy;
var images = require('./lib/images');



//---- globals

var NAME = 'imgapi';
var VERSION = require('./package.json').version;

var log;



//---- internal support functions

function usage(code, msg) {
    if (msg) {
        console.error('ERROR: ' + msg + '\n');
    }
    printHelp();
    process.exit(code);
}

function printHelp() {
    util.puts('Usage: node main.js [OPTIONS]');
    util.puts('');
    util.puts('The SDC Image API (IMGAPI).');
    util.puts('');
    util.puts('Options:');
    util.puts('  -h, --help     Print this help info and exit.');
    util.puts('  --version      Print version and exit.');
    util.puts('  -d, --debug    Debug level. Once for DEBUG log output.');
    util.puts('                 Twice for TRACE. Thrice to add "src=true"');
    util.puts('                 to Bunyan log records.');
    util.puts('  -f, --file CONFIG-FILE-PATH');
    util.puts('                 Specify config file to load.');
}

function handleArgv() {
    var longOpts = {
        'help': Boolean,
        'version': Boolean,
        'debug': [Boolean, Array],
        'file': path
    };
    var shortOpts = {
        'h': ['--help'],
        'd': ['--debug'],
        'f': ['--file']
    };
    var opts = nopt(longOpts, shortOpts, process.argv, 2);
    if (opts.help) {
        usage(0);
    }
    if (opts.version) {
        util.puts('IMGAPI ' + VERSION);
        process.exit(0);
    }
    var logSrc = false,
        logLevel = 'debug';
    if (opts.debug) {
        logLevel = (opts.debug.length > 1 ? 'trace' : 'debug');
        if (opts.debug.length > 2)
            logSrc = true;
    }
    var serializers = objCopy(restify.bunyan.serializers);
    serializers.image = images.bunyanImageSerializer;
    log = bunyan.createLogger({  // `log` is intentionally global.
        name: NAME,
        level: logLevel,
        src: logSrc,
        serializers: serializers
    });
    log.trace({opts: opts}, 'opts');

    // Die on unknown opts.
    var extraOpts = {};
    Object.keys(opts).forEach(function (o) { extraOpts[o] = true; });
    delete extraOpts.argv;
    Object.keys(longOpts).forEach(function (o) { delete extraOpts[o]; });
    extraOpts = Object.keys(extraOpts);
    if (extraOpts.length) {
        console.error('unknown option%s: -%s\n',
            (extraOpts.length === 1 ? '' : 's'), extraOpts.join(', -'));
        usage(1);
    }

    return opts;
}


function addFluentdHost(log_, host) {
    var evtLogger = new EffluentLogger({
        filter: function _evtFilter(obj) { return (!!obj.evt); },
        host: host,
        log: log_,
        port: 24224,
        tag: 'debug'
    });
    log_.addStream({
        stream: evtLogger,
        type: 'raw'
    });
}


//---- mainline

function main() {
    var app;
    var config;
    var opts = handleArgv();

    vasync.pipeline({funcs: [
        function getConfig(_, next) {
            var loadOpts = {log: log, path: opts.file};
            mod_config.loadConfig(loadOpts, function (err, config_) {
                config = config_;
                next(err);
            });
        },

        function setupWithConfig(_, next) {
            if (!opts.debug && config.logLevel) {
                // log.level(config.logLevel);
                if (log.level() <= bunyan.TRACE) {
                    log.src = true;
                }
            }

            // EXPERIMENTAL
            if (config.fluentd_host) {
                addFluentdHost(log, config.fluentd_host);
            }

            // Log config (but don't put passwords in the log file).
            var censorKeys = {
                'password': '***',
                'authToken': '***',
                'pass': '***'
            };
            function censor(key, value) {
                var censored = censorKeys[key];
                return (censored === undefined ? value : censored);
            }
            log.info({config: JSON.stringify(config, censor, 2)},
                'loaded config');
            next();
        },

        function createAndStartTheApp(_, next) {
            createApp(config, log, function (err, app_) {
                if (err) {
                    next(err);
                    return;
                }
                app = app_;
                app.setupPlaceholderCleanupInterval();
                app.setupRemoteArchiveInterval();
                app.listen(function () {
                    var addr = app.server.address();
                    log.info('Image API listening on <http://%s:%s>.',
                        addr.address, addr.port);
                    next();
                });
            });
        },

        function setupSignalHandlers(_, next) {
            // Try to ensure we clean up properly on exit.
            function closeApp(callback) {
                if (app) {
                    log.info('Closing app.');
                    app.close(callback);
                } else {
                    log.debug('No app to close.');
                    callback();
                }
            }

            process.on('SIGINT', function () {
                log.debug('SIGINT. Cleaning up.');
                closeApp(function () {
                    process.exit(1);
                });
            });
            next();
        }

    ]}, function (err) {
        if (err) {
            log.error(err, 'error starting up');
            process.exit(2);
        }
        log.info('startup complete');
    });
}

main();
