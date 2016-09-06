/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/*
 * Handling for "auth keys" for HTTP Signature auth (if `config.authType ===
 * "signature"`). "Auth keys" is a mapping of username to an array of SSH
 * public keys. This file includes the restify endpoints for working with
 * auth keys, and a background `AuthKeysLoader` that handles setting
 * `app.authKeys` (used in the auth middleware).
 *
 * Auth keys can come from a few places:
 *
 * 1. From `config.authKeys`.
 * 2. Loaded from "/data/imgapi/etc/authkeys/local/$username.keys".
 *    This is loaded once on startup and when `AdminReloadAuthKeys` is
 *    called.
 * 3. If setup with Manta (via `config.manta`), then keys
 *    are sync'd from "/${manta.rootDir}/authkeys/$username.keys"
 *    to "/data/imgapi/etc/authkeys/manta/$username.keys" and loaded from
 *    there. These are loaded (a) at startup, (b) periodically, and
 *    (c) when `AdminReloadAuthKeys` is called.
 *
 * The format for a "$username.keys" file is a subset of a
 * "~/.ssh/authorized_keys" file:
 * - one SSH public key per line
 * - blank lines and lines beginning with a '#' are ignored (comment lines)
 */

var assert = require('assert-plus');
var fs = require('fs');
var glob = require('glob');
var MantaDirWatcher = require('manta-dir-watcher');
var mod_path = require('path');
var util = require('util');
var vasync = require('vasync');

var constants = require('./constants');
var errors = require('./errors');


//---- globals

/*
 * Every *hour*. We don't expect this to change frequently, so why bother
 * with logs of polling. The desperate can call the AdminReloadAuthKeys
 * endpoint.
 */
var POLL_INTERVAL = 60 * 60;


// ---- internal helpers

/*
 * Load a "$username.keys" file from the given local path.
 *
 * @param {String} keysFile: Existing local path to the keys file to load.
 *      The path basename will be "$username.keys".
 * @param {Function} cb: `function (err, username, keys)`.
 */
function loadKeysFile(keysFile, cb) {
    assert.string(keysFile, 'keysFile');
    assert.func(cb, 'cb');

    var base = mod_path.basename(keysFile);
    var username = base.slice(0, base.lastIndexOf('.'));

    /*
     * Dev Note: when base node ver is 0.12, use 'readline' to stream
     * read line-by-line:
     * https://nodejs.org/docs/latest/api/all.html#readline_readline
     */
    fs.readFile(keysFile, {encoding: 'utf8'}, function (err, text) {
        if (err) {
            cb(err);
            return;
        }
        var keys = [];
        var lines = text.split(/\r?\n/g);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var trimmed = line.trim();
            if (!trimmed) {
                continue;
            } else if (trimmed[0] === '#') {
                continue; // comment line
            }
            keys.push(trimmed);
        }
        cb(null, username, keys);
    });
}


//---- endpoints

/**
 * AdminReloadAuthKeys
 */
function apiAdminReloadAuthKeys(req, res, cb) {
    if (req._app.authKeysLoader) {
        req._app.authKeysLoader.reload();
    }
    res.send({});
    cb();
}


/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 * @param reqAuth {Function} A request middleware for strict
 *      authentication of some endpoints (typically those that can make
 *      changes) of the IMGAPI.
 */
function mountApi(server, reqAuth) {
    server.post(
        // TODO: would like to move this to '/authkeys/...'
        {path: '/keys/reload', name: 'AdminReloadAuthKeys'},
        reqAuth,
        apiAdminReloadAuthKeys);
}


//---- AuthKeysLoader

function AuthKeysLoader(app) {
    assert.object(app, 'app');
    assert.optionalObject(app.config.authKeys, 'app.config.authKeys');

    this.app = app;
    this.configAuthKeys = app.config.authKeys;
    this.log = app.log.child({component: 'authkeys'}, true);
    this.mantaConfig = null;
    this.loadDirs = [
        mod_path.join(constants.AUTHKEYS_BASE_DIR, 'local')
    ];
    if (app.config.manta) {
        this.mantaConfig = app.config.manta;
        this.mantaDir = mod_path.resolve(this.mantaConfig.rootDir, 'keys');
        this.mantaSyncDir = mod_path.join(constants.AUTHKEYS_BASE_DIR, 'manta');
        this.loadDirs.push(this.mantaSyncDir);
    }
    this.mantaWatcher = null;
}

AuthKeysLoader.prototype.start = function start() {
    var self = this;

    if (this.mantaConfig) {
        this.mantaWatcher = new MantaDirWatcher({
            clientOpts: {
                url: this.mantaConfig.url,
                user: this.mantaConfig.user,
                sign: {
                    keyId: this.mantaConfig.keyId,
                    key: this.mantaConfig.key
                },
                insecure: this.mantaConfig.insecure
            },
            log: this.log,

            dir: this.mantaDir,
            interval: POLL_INTERVAL,
            filter: {
                type: 'object',
                name: '*.keys'
            },
            syncDir: this.mantaSyncDir,
            syncDelete: true
        });
        this.mantaWatcher.on('data', function onMantaKeysUpdate(group) {
            self.log.debug({group: group, mantaDir: self.mantaDir},
                'manta keys update');
            self._load();
        });
        this.mantaWatcher.on('error', function onMantaKeysErr(err) {
            self.log.warn({err: err, mantaDir: self.mantaDir},
                'error polling manta for auth keys');
        });
    }

    // First load of keys.
    this._load();
};

AuthKeysLoader.prototype.close = function close() {
    if (this.mantaWatcher) {
        this.mantaWatcher.close();
    }
};

AuthKeysLoader.prototype.reload = function reload() {
    /*
     * Reload keys now. Here we will poke the Manta watcher, if any, and
     * also load locally. If there is a Manta key dir change, then we'll
     * end up loading the local keys files twice, which is a bit wasteful.
     */
    if (this.mantaWatcher) {
        this.mantaWatcher.poke();
    }
    this._load();
};

AuthKeysLoader.prototype._load = function _load(cb) {
    assert.optionalFunc(cb, 'cb');

    var self = this;
    var log = this.log;

    var context = {
        keysFiles: [],
        authKeys: {}
    };

    vasync.pipeline({arg: context, funcs: [
        function authKeysFromConfig(arg, next) {
            if (self.configAuthKeys) {
                Object.keys(self.configAuthKeys).forEach(function (u) {
                    arg.authKeys[u] = self.configAuthKeys[u].slice();
                });
            }
            next();
        },
        function getKeysFiles(arg, next) {
            vasync.forEachPipeline({
                inputs: self.loadDirs,
                func: function readLoadDir(dir, nextDir) {
                    glob(mod_path.join(dir, '*.keys'), function (err, files) {
                        log.trace({err: err, files: files, dir: dir},
                            'readLoadDir');
                        if (err) {
                            nextDir(err);
                            return;
                        }
                        arg.keysFiles = arg.keysFiles.concat(files);
                        nextDir();
                    });
                }
            }, next);
        },
        function getAuthKeys(arg, next) {
            // Sort input files so we have a stable `app.authKeys`.
            arg.keysFiles.sort();
            vasync.forEachPipeline({
                inputs: arg.keysFiles,
                func: function loadOneKeysFile(keysFile, nextKeysFile) {
                    loadKeysFile(keysFile, function (err, u, keys) {
                        if (err) {
                            nextKeysFile(err);
                            return;
                        }
                        if (!arg.authKeys[u]) {
                            arg.authKeys[u] = keys;
                        } else {
                            arg.authKeys[u] = arg.authKeys[u].concat(keys);
                        }
                        nextKeysFile();
                    });
                }
            }, next);
        },
        function setIt(arg, next) {
            /*
             * Only log.info if there is a change in the keys.
             */
            var oldSerial = JSON.stringify(self.app.authKeys);
            var newSerial = JSON.stringify(arg.authKeys);
            var isDiff = Boolean(oldSerial !== newSerial);

            self.app.authKeys = arg.authKeys;

            if (isDiff) {
                log.info({authKeys: self.app.authKeys}, 'updated app.authKeys');
            } else {
                log.trace({authKeys: arg.authKeys}, 'loaded authKeys');
            }

            next();
        }
    ]}, function doneLoad(err) {
        if (cb) {
            cb(err);
        }
    });
};


//---- exports

module.exports = {
    mountApi: mountApi,
    AuthKeysLoader: AuthKeysLoader
};
