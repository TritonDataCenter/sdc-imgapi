#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/*
 * Config loading and validation for IMGAPI.
 * See the "Configuration" section of the operator-guide.md for details.
 *
 * Module usage:
 *      var mod_config = require('./config');
 *      mod_config.loadConfig({...}, function (err, config) {
 *          // ...
 *      });
 *
 * CLI usage:
 *      $ node lib/config.js
 *      ... emits the full merged and computed config ...
 *      $ node lib/config.js KEY
 *      ... emits the value of KEY (in json-y form, i.e. quotes removed from a
 *      string) ...
 */

var assert = require('assert-plus');
var dashdash = require('dashdash');
var format = require('util').format;
var fs = require('fs');
var mod_path = require('path');
var vasync = require('vasync');
var VError = require('verror').VError;


// ---- globals

var DEFAULT_PATH = '/data/imgapi/etc/imgapi.config.json';


// ---- internal support

/*
 * lookup the property "str" (given in dot-notation) in the object "obj".
 * "c" is optional and may be set to any delimiter (defaults to dot: ".")
 *
 * Note: lifted from node-tabula.
 */
function dottedLookup(obj, str, c) {
    if (c === undefined)
        c = '.';
    var o = obj;
    var dots = str.split(c);
    var s = [];
    for (var i = 0; i < dots.length; i++) {
        var dot = dots[i];
        s.push(dot);
        if (!o.hasOwnProperty(dot))
            throw new Error('no property ' + s.join(c) + ' found');
        o = o[dot];
    }
    return o;
}


function validateConfigSync(config) {
    assert.finite(config.port, 'config.port');
    assert.string(config.address, 'config.address');
    assert.finite(config.maxSockets, 'config.maxSockets');
    assert.optionalString(config.serverName, 'config.serverName');

    assert.string(config.mode, 'config.mode');
    var validModes = ['public', 'private', 'dc'];
    assert.ok(validModes.indexOf(config.mode) !== -1,
        'invalid config.mode: ' + config.mode);

    if (config.mode === 'dc') {
        assert.string(config.datacenterName, 'config.datacenterName');

        assert.object(config.ufds, 'config.ufds');
        assert.string(config.ufds.url, 'config.ufds.url');
        assert.string(config.ufds.bindDN, 'config.ufds.bindDN');
        assert.string(config.ufds.bindPassword, 'config.ufds.bindPassword');

        assert.object(config.moray, 'config.moray');
        assert.string(config.moray.host, 'config.moray.host');
        assert.finite(config.moray.port, 'config.moray.port');

        assert.object(config.wfapi, 'config.wfapi');
        assert.string(config.wfapi.url, 'config.wfapi.url');
        assert.arrayOfString(config.wfapi.workflows, 'config.wfapi.workflows');
    }

    assert.string(config.authType, 'config.authType');
    var validAuthTypes = ['none', 'signature'];
    assert.ok(validAuthTypes.indexOf(config.authType) !== -1,
        'invalid config.authType: ' + config.authType);

    assert.arrayOfString(config.storageTypes, 'config.storageTypes');
    var validStorageTypes = ['local', 'manta'];
    config.storageTypes.forEach(function (st) {
        assert.ok(validStorageTypes.indexOf(st) !== -1,
            'invalid storage type: ' + st);
    });
    if (config.storageTypes.indexOf('manta') !== -1) {
        assert.object(config.manta, 'config.manta');
    }

    if (config.manta) {
        assert.string(config.manta.url, 'config.manta.url');
        assert.string(config.manta.user, 'config.manta.user');
        assert.string(config.manta.key, 'config.manta.key');
        assert.string(config.manta.keyId, 'config.manta.keyId');
        assert.string(config.manta.baseDir, 'config.manta.baseDir');
        assert.string(config.manta.rootDir, 'config.manta.rootDir'); // computed
    }

    assert.string(config.databaseType, 'config.databaseType');
    var validDatabaseTypes = ['local', 'moray'];
    assert.ok(validDatabaseTypes.indexOf(config.databaseType) !== -1,
        'invalid config.databaseType: ' + config.databaseType);

    assert.optionalNumber(config.placeholderImageLifespanDays,
        'config.placeholderImageLifespanDays');
    assert.optionalBool(config.allowLocalCreateImageFromVm,
        'config.allowLocalCreateImageFromVm');

    if (config.imgapiUrlFromDatacenter) {
        /**
         * Example object:
         *  {
         *      "us-east-1": "http://192.168.2.21"
         *  }
         */
        assert.object(config.imgapiUrlFromDatacenter,
            'config.imgapiUrlFromDatacenter');
        Object.keys(config.imgapiUrlFromDatacenter).forEach(
            function (name) {
                assert.string(name, 'config.imgapiUrlFromDatacenter name');
                assert.string(config.imgapiUrlFromDatacenter[name],
                    'config.imgapiUrlFromDatacenter["' + name + '"] value');
            }
        );
    }
}


// ---- config loading

/**
 * Load config.
 *
 * This loads factory settings (etc/defaults.json) and any given `configPath`.
 *
 * @param opts.log {Bunyan Logger} Optional.
 * @param opts.path {String} Optional. Path to JSON config file to load.
 *      If not given, then the default config path (DEFAULT_PATH) is used.
 * @param cb {Function} `function (err, config)`
 */
function loadConfig(opts, cb) {
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');
    assert.optionalObject(opts.log, 'opts.log');
    assert.optionalString(opts.path, 'opts.path');

    var configPath = opts.path || DEFAULT_PATH;
    var config;

    vasync.pipeline({funcs: [
        function loadDefaults(_, next) {
            var defaultsPath = mod_path.resolve(__dirname, '..', 'etc',
                'defaults.json');
            if (opts.log) {
                opts.log.info({defaultsPath: defaultsPath},
                    'load config defaults');
            }
            fs.readFile(defaultsPath, {encoding: 'utf8'}, function (err, data) {
                if (err) {
                    next(err);
                } else {
                    try {
                        config = JSON.parse(data);
                    } catch (parseErr) {
                        next(VError(parseErr,
                            'could not parse ' + defaultsPath));
                        return;
                    }
                    next();
                }
            });
        },

        function loadConfigPath(_, next) {
            if (opts.log) {
                opts.log.info({configPath: configPath},
                    'load config path');
            }
            fs.readFile(configPath, {encoding: 'utf8'}, function (err, data) {
                if (err) {
                    next(err);
                } else {
                    try {
                        var extraConfig = JSON.parse(data);
                    } catch (parseErr) {
                        next(VError(parseErr,
                            'could not parse ' + configPath));
                        return;
                    }
                    for (var key in extraConfig) {
                        config[key] = extraConfig[key];
                    }
                    next();
                }
            });
        },

        /*
         * There is some "computed" config: i.e. values that fully defined
         * by other config values, but are useful to have processed in one
         * place (here) and added to the config for IMGAPI code to use.
         *
         * We also use this to squeeze in defaults that are nested. Normally
         * we'd put these in "defaults.json", but if the given config sets
         * `manta`, then a `manta.baseDir === "imgapi"` default gets lost.
         */
        function computeConfig(_, next) {
            // default: manta.baseDir
            if (config.manta && !config.manta.baseDir) {
                config.manta.baseDir = 'imgapi';
            }

            // compute: manta.rootDir
            if (config.manta) {
                assert.string(config.mode, 'config.mode');
                assert.string(config.manta.user, 'config.manta.user');
                assert.string(config.manta.baseDir, 'config.manta.baseDir');
                var rootDir = format('/%s/stor/%s', config.manta.user,
                    config.manta.baseDir);
                if (config.mode === 'dc') {
                    assert.string(config.datacenterName,
                        'config.datacenterName');
                    rootDir += '/' + config.datacenterName;
                }
                config.manta.rootDir = rootDir;
            }
            next();
        },

        function validate(_, next) {
            try {
                validateConfigSync(config);
            } catch (err) {
                next(VError(err, 'invalid IMGAPI config'));
                return;
            }
            next();
        }

    ]}, function (err) {
        cb(err, config);
    });
}



// ---- mainline

function main(argv) {
    assert.arrayOfString(argv, 'argv');

    var options = [
        {
            names: ['help', 'h'],
            type: 'bool',
            help: 'Print this help and exit.'
        },
        {
            names: ['file', 'f'],
            type: 'string',
            help: 'Config file path.',
            helpArg: 'CONFIG-PATH'
        }
    ];
    var parser = dashdash.createParser({options: options});
    try {
        var opts = parser.parse(argv);
    } catch (e) {
        console.error('lib/config.js: error: %s', e.message);
        process.exit(1);
    }

    if (opts.help) {
        console.log([
            'usage: node .../lib/config.js [OPTIONS] [KEY]',
            'options:',
            parser.help().trimRight()
        ].join('\n'));
        process.exit(0);
    }

    var key;
    if (opts._args.length === 1) {
        key = opts._args[0];
    } else if (opts._args.length === 0) {
        key = null;
    } else {
        console.error('lib/config.js: error: too many args: %s',
            opts._args.join(' '));
        process.exit(1);
    }

    loadConfig({path: opts.file}, function (err, config) {
        if (err) {
            console.error('lib/config.js: error: %s', err.stack);
            process.exit(1);
        }
        if (key) {
            var val = dottedLookup(config, key);
            if (typeof (val) === 'string') {
                console.log(val);
            } else {
                console.log(JSON.stringify(val, null, 4));
            }
        } else {
            console.log(JSON.stringify(config, null, 4));
        }
    });
}

if (require.main === module) {
    main(process.argv);
}


// ---- exports

module.exports = {
    DEFAULT_PATH: DEFAULT_PATH,
    loadConfig: loadConfig
};
