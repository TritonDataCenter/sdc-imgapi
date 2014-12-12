/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * The IMGAPI app.
 */

var p = console.log;
var format = require('util').format;
var os = require('os');
var crypto = require('crypto');
var path = require('path');
var fs = require('fs');
var http = require('http');
var https = require('https');

var assert = require('assert-plus');
var restify = require('restify');
var Cache = require('expiring-lru-cache');
var async = require('async');
var MemoryStream = require('memorystream');
var UFDS = require('ufds');
var moray = require('moray');

var channels = require('./channels');
var database = require('./database');
var storage = require('./storage');
var utils = require('./utils');
var errors = require('./errors');
var images = require('./images');
var datasets = require('./datasets');
var wfapi = require('./wfapi');



//---- globals

var HOSTNAME = os.hostname();

var faviconCache;



//---- internal support stuff

/**
 * GET /favicon.ico
 */
function apiFavicon(req, res, next) {
    var maxAge = 86400000;
    if (faviconCache) {
        res.writeHead(200, faviconCache.headers);
        res.end(faviconCache.body);
    } else {
        var faviconPath = path.resolve(__dirname, '..', 'public',
            'favicon.ico');
        fs.readFile(faviconPath, function (err, buf) {
            if (err)
                return next(err);

            var hash = crypto.createHash('md5');
            hash.update(buf, 'binary');
            faviconCache = {
                headers: {
                    'Content-Type': 'image/x-icon',
                    'Content-Length': buf.length,
                    'ETag': '"' + hash.digest('base64') + '"',
                    'Cache-Control': 'public, max-age=' + (maxAge / 1000)
                },
                body: buf
            };
            res.writeHead(200, faviconCache.headers);
            res.end(faviconCache.body);
        });
    }
}

/**
 * "GET /ping"
 */
function apiPing(req, res, next) {
    if (req.query.error !== undefined) {
        var name = req.query.error || 'InternalError';
        if (name.slice(-5) !== 'Error') {
            name += 'Error';
        }
        var err;
        if (!errors[name]) {
            err = new errors.InvalidParameterError('unknown error: '+name,
                [ {field: 'error', code: 'Missing'} ]);
        } else {
            err = errors.samples[name] || new errors.InternalError(
                format('do not have a sample "%s" error', name));
        }
        next(err);
    //} else if (req.query.delay !== undefined) {
    //    var delay = Number(req.query.delay);  // number of seconds
    //    if (isNaN(delay)) {
    //        delay = 10;
    //    }
    //    // Disable the default 2 minute timeout from node's "http.js".
    //    req.connection.setTimeout(0);
    //    req.connection.on('timeout', function () {
    //        console.log('ping timeout');
    //    })
    //    setTimeout(function () {
    //        var data = {
    //            ping: 'pong',
    //            pid: process.pid,  // used by test suite
    //            version: App.version,
    //            delay: delay
    //        };
    //        res.send(data);
    //        next();
    //    }, delay * 1000);
    } else {
        var data = {
            ping: 'pong',
            version: App.version,
            // This is used by `imgadm` to distinguish reliably from the old
            // DSAPI which just had `{"ping": "pong"}` for its "GET /ping"
            // response.
            imgapi: true
        };
        // The `pid` argument is used by the test suite. However, don't
        // emit that for an unauthenticate request to a public server.
        if (req._app.mode === 'dc' || req.remoteUser) {
            data.pid = process.pid;
        }
        res.send(data);
        next();
    }
}


/**
 * Return a restify middleware function for handling authentication:
 *
 * @param app {App}
 * @param config {Object} The app config.
 * @param passive {Boolean} Whether to be "strict" or "passive".
 *      "Passive" here means, pass through if there is no Authorization
 *      header.
 */
function getAuthMiddleware(app, config, passive) {
    if (config.mode === 'dc') {
        // No auth when using in 'dc' mode. Security is via only being
        // on a private network (the 'admin' network in SDC parlance).
        return function reqNoAuth(req, res, next) {
            next();
        };
    }
    assert.ok(~['public', 'private'].indexOf(config.mode), 'config.mode');
    assert.object(config.auth, 'config.auth');
    assert.ok(['basic', 'signature'].indexOf(config.auth.type) !== -1,
        'config.auth.type');
    assert.bool(passive, 'passive');

    if (config.auth.type === 'basic') {
        // Adapted from Connect's "lib/middleware/basicAuth.js".
        var bcrypt = require('bcrypt');

        assert.optionalString(config.auth.realm, 'config.auth.realm');
        assert.object(config.auth.users, 'config.auth.users');

        var realm = config.realm || 'IMGAPI';
        var users = config.auth.users;
        // var salt = bcrypt.genSaltSync(10);

        return function reqBasicAuth(req, res, next) {
            var authorization = req.headers.authorization;
            req.log.trace({authorization: authorization}, 'basicAuth');

            if (req.remoteUser) {
                return next();
            }
            if (!authorization) {
                if (passive) {
                    //XXX
                    return next();
                } else {
                    res.setHeader('WWW-Authenticate',
                        'Basic realm="' + realm + '"');
                    return next(new errors.UnauthorizedError('Unauthorized'));
                }
            }

            var parts = authorization.split(' ');
            var scheme = parts[0];
            var creds = new Buffer(parts[1], 'base64').toString().split(':');

            if (scheme != 'Basic') {
                return next(new errors.BadRequestError(
                    'Unsupported Authorization scheme: "%s"', scheme));
            }

            var expectedPassHash = users[creds[0]];
            if (expectedPassHash === undefined) {
                return next(new errors.UnauthorizedError('Unauthorized'));
            }
            bcrypt.compare(creds[1], expectedPassHash, function (err, ok) {
                if (err) {
                    next(new errors.InternalError(err, 'error authorizing'));
                } else if (ok) {
                    req.remoteUser = creds[0];
                    next();
                } else {
                    next(new errors.UnauthorizedError('Unauthorized'));
                }
            });
        };
    } else if (config.auth.type === 'signature') {
        var httpSig = require('http-signature');
        assert.object(config.auth.keys, 'config.auth.keys');
        var keys = config.auth.keys;
        return function reqSignatureAuth(req, res, next) {
            var authorization = req.headers.authorization;
            req.log.trace({authorization: authorization}, 'signatureAuth');

            if (req.remoteUser) {
                return next();
            }
            if (!authorization) {
                if (passive) {
                    return next();
                } else {
                    return next(new errors.UnauthorizedError('Unauthorized'));
                }
            }
            try {
                var sigInfo = httpSig.parseRequest(req);
            } catch (parseErr) {
                return next(new errors.UnauthorizedError(
                    parseErr, parseErr.message));
            }
            var sshKeys = keys[sigInfo.keyId];
            if (sshKeys === undefined) {
                return next(new errors.UnauthorizedError('Unauthorized'));
            }
            assert.arrayOfString(sshKeys, 'config.auth.keys.'+sigInfo.keyId);
            // TODO: improve caching here: sshKeyToPEM, preferred key first
            for (var i = 0; i < sshKeys.length; i++) {
                try {
                    var pem = httpSig.sshKeyToPEM(sshKeys[i]);
                } catch (err) {
                    req.log.warn({sshKey: sshKeys[i], username: sigInfo.keyId},
                        'bad ssh key');
                    continue;
                }
                if (httpSig.verifySignature(sigInfo, pem)) {
                    req.remoteUser = sigInfo.keyId;
                    return next();
                }
            }
            return next(new errors.UnauthorizedError('Unauthorized'));
        };
    }
}


/**
 * Modified restify.formatters.json.formatJSON to indent-2 JSON from IMGAPI.
 */
function formatJSON(req, res, body) {
    if (body instanceof Error) {
        // snoop for RestError or HttpError, but don't rely on
        // instanceof
        res.statusCode = body.statusCode || 500;
        if (body.body) {
            body = body.body;
        } else {
            body = {
                message: body.message
            };
        }
    } else if (Buffer.isBuffer(body)) {
        body = body.toString('base64');
    }

    var data = JSON.stringify(body, null, 2);
    res.setHeader('Content-Length', Buffer.byteLength(data));
    return (data);
}



//---- exports

/**
 * The Image API application.
 *
 * @param config {Object} The IMGAPI config. See
 *      <https://mo.joyent.com/docs/imgapi/master/#configuration>.
 * @param log {Bunyan Logger instance}
 */
function App(config, log) {
    var self = this;
    assert.object(config, 'config');
    assert.string(config.mode, 'config.mode');
    assert.object(log, 'log');

    this.config = config;
    this.mode = config.mode;
    this.log = log;
    this.port = config.port;
    this.serverName = config.serverName || 'imgapi/' + App.version;
    this.db = new database[config.database.type](this, config.database, log);
    // Allow tuning the max number of sockets for external API calls
    http.globalAgent.maxSockets = this.config.maxSockets;
    https.globalAgent.maxSockets = this.config.maxSockets;
    // Do not enforce it yet
    if (config.wfapi) {
        this.wfapi = new wfapi(config.wfapi, log);
    }
    var info = channels.channelInfoFromConfig(config);
    if (info) {
        this.defaultChannel = info[0];
        this.channelFromName = info[1];
    }

    // Server response caches. This is centralized on the app
    // because it allows the interdependant cache-invalidation to be
    // centralized.
    this._cacheFromScope = {
        ImageGet: new Cache({
            size: 100,
            expiry: 300000, /* 5 minutes */
            log: this.log,
            name: 'ImageGet'
        }),
        ImageList: new Cache({
            size: 100,
            expiry: 300000, /* 5 minutes */
            log: this.log,
            name: 'ImageList'
        })
    };

    var server = this.server = restify.createServer({
        name: this.serverName,
        log: this.log,
        formatters: {
            'application/json': formatJSON
        },
        version: ['1.0.0', '2.0.0']
    });

    server.pre(function pauseReqStreamEtc(req, res, next) {
        /**
         * If the client does not set Accept-Version, then we assume old clients
         * of IMGAPI v1.x vintage and default to "~1".
         *
         * *Could* do:
         *    req.headers['accept-version'] = '~1'
         * but that lies in the audit log. Would like a `req.setVersion()`
         * in restify instead of hacking private `req._version`.
         */
        if (req.headers['accept-version'] === undefined) {
            req._version = '~1';
        }

        /*
         * Hack to ensure we don't miss `req` stream events. See comment for
         * `pauseStream`. This also then requires some juggling to get requests
         * requiring `bodyParser` to not hang on a paused req stream.
         */
        utils.pauseStream(req);

        next();
    });

    server.use(function (req, res, next) {
        /*
         * Headers we want for all IMGAPI responses.
         */
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('Server', server.name);
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
            res.header('x-server-name', HOSTNAME);
        });

        req._app = self;

        next();
    });

    server.use(restify.requestLogger());
    server.use(restify.queryParser({mapParams: false}));
    server.on('after', function (req, res, route, err) {
        // Skip logging some high frequency or unimportant endpoints to key
        // log noise down.
        var method = req.method;
        var pth = req.path();
        if (method === 'GET' || method === 'HEAD') {
            if (pth === '/ping' || pth.slice(0, 6) === '/docs/') {
                return;
            }
        }
        // Successful GET res bodies are uninteresting and *big*.
        var body = !(method === 'GET' &&
            Math.floor(res.statusCode / 100) === 2);

        restify.auditLogger({
            log: req.log.child(
                {route: route && route.name, action: req.query.action},
                true),
            body: body
        })(req, res, route, err);
    });
    server.on('uncaughtException', function (req, res, route, err) {
        req.log.error(err);
        // TODO: a la fwapi: res.send(new verror.WError(err, 'Internal error'));
        res.send(err);
    });

    var reqAuth = getAuthMiddleware(this, config, false);
    var reqPassiveAuth = getAuthMiddleware(this, config, true);

    // Misc endpoints (often for dev, debugging and testing).
    server.get({path: '/favicon.ico', name: 'Favicon'}, apiFavicon);

    /**
     * The current restify static plugin assumes that the leading URL part,
     * here "/docs/", is on the file system as well. We don't have that.
     * I'm hesitant to change away from IMGAPI's "build/docs/public/..."
     * because that's what most SDC components use. Instead we'll satisfy the
     * static plugin with a symlink "docs/ -> ./" in the docs root.
     */
    server.get('/', utils.redir('/docs/', true));
    server.get('/docs', utils.redir('/docs/', true));
    server.get({name: 'PublicDocs', path: /^\/docs\/(.+)?/},
        restify.serveStatic({
            default: 'index.html',
            directory: path.resolve(__dirname + '/../build/docs/public')
        }));

    server.get({path: '/ping', name: 'Ping'},
        reqPassiveAuth, apiPing);
    // TODO Kang-ify (https://github.com/davepacheco/kang)
    server.get({path: '/state', name: 'GetState'},
        reqAuth,
        function (req, res, next) {
            res.send(self.getStateSnapshot());
            next();
        }
    );
    server.post({path: '/state', name: 'UpdateState'},
        reqAuth,
        function apiDropCaches(req, res, next) {
            if (req.query.action !== 'dropcaches')
                return next();
            Object.keys(self._cacheFromScope).forEach(function (scope) {
                self._cacheFromScope[scope].reset();
            });
            res.send(202);
            next(false);
        },
        function invalidAction(req, res, next) {
            if (req.query.action)
                return next(new restify.InvalidArgumentError(
                    '"%s" is not a valid action', req.query.action));
            return next(
                new restify.MissingParameterError('"action" is required'));
        }
    );

    channels.mountApi(server, self, reqAuth, reqPassiveAuth);
    images.mountApi(server, reqAuth, reqPassiveAuth);
    datasets.mountApi(server);
}


App.version = require(__dirname + '/../package.json').version;


/**
 * Async prep/setup for an App.
 *
 * TODO: guard against multiple callbacks from this on some errors.
 *
 * @param callback {Function} `function (err)`.
 */
App.prototype.setup = function (callback) {
    assert.func(callback, 'callback');
    var self = this;
    var log = this.log;

    // ufdsClient is still needed for app.ufdsClient.getUser
    if (self.config.ufds) {
        var ufdsConfig = utils.objCopy(self.config.ufds);
        ufdsConfig.log = self.log.child({'ufdsClient': true}, true);
        ufdsConfig.cache = false;  // for now, no caching in the client
        ufdsConfig.failFast = true;
        var ufdsClient = self.ufdsClient = new UFDS(ufdsConfig);

        ufdsClient.once('connect', function () {
            ufdsClient.removeAllListeners('error');
            ufdsClient.on('error', function (err) {
                log.warn(err, 'UFDS: unexpected error occurred');
            });

            ufdsClient.on('close', function () {
                log.warn('UFDS: disconnected');
            });

            ufdsClient.on('connect', function () {
                log.info('UFDS: reconnected');
            });

            log.info('UFDS: connected');
        });

        ufdsClient.once('error', function (err) {
            log.fatal(err, 'UFDS: unable to connect and/or bind');
            return callback(err);
        });
    }

    if (self.config.database.type === 'moray' && self.config.moray) {
        var retry = self.config.moray.retry || {};
        log.debug('Connecting to moray...');

        var morayClient = self.morayClient = moray.createClient({
            connectTimeout: self.config.moray.connectTimeout || 200,
            log: log.child({'morayClient': true}, true),
            host: self.config.moray.host,
            port: self.config.moray.port,
            reconnect: true,
            retry: (self.config.moray.retry === false ? false : {
                retries: Infinity,
                minTimeout: retry.minTimeout || 1000,
                maxTimeout: retry.maxTimeout || 16000
            })
        });

        morayClient.on('connect', function () {
            log.info({ moray: morayClient.toString() }, 'moray: connected');
            morayClient.on('error', function (err) {
                // not much more to do because the moray client should take
                // care of reconnecting, etc.
                log.error(err, 'moray client error');
            });
            self.db._setupBucket(function (err) {
                if (err) {
                    log.error({ err: err }, 'Bucket was not loaded');
                } else {
                    log.info('Bucket has been loaded');
                }
            });
        });
    }

    this.db.setup(self, function (dbErr) {
        if (dbErr) {
            return callback(dbErr);
        }

        self.storage = {};
        var types = Object.keys(self.config.storage);
        for (var i = 0; i < types.length; i++) {
            var type = types[i];
            var config = self.config.storage[type];
            config.datacenterName = self.config.datacenterName;
            var StorageClass = storage[type];
            log.info({type: type, config: config}, 'create storage handler');
            try {
                self.storage[type] = new StorageClass({
                    log: log,
                    config: config
                });
            } catch (ctorErr) {
                return callback(ctorErr);
            }
        }

        async.forEach(
            Object.keys(self.storage),
            function setupOneStorage(aType, next) {
                log.info({type: aType}, 'setup storage');
                self.storage[aType].setup(next);
            },
            callback
        );
    });

    // NOTE Do not enforce it yet
    // Separate to db.setup
    // - We want to keep trying to create the workflows on init but we don't
    //   wan't to prevent imgapi from working.
    // - Ideally people would get a 503 if wfapi is not up by the time a user
    //   wants to create and image from a snapshot
    // - Do we want unlimited tries or have a cap on number of retries before
    //   giving up on wfapi?
    if (this.wfapi) {
        this.wfapi.connect(function () {
            log.info('wfapi is ready');
        });
    }
};


App.prototype.setupPlaceholderCleanupInterval = function () {
    // 30 minutes
    var CHECK_INTERVAL = 1800000;
    var app = this;
    var log = app.log;
    var now = new Date().toISOString();

    function deleteImage(image) {
        app.db.del(image.uuid, function (delErr) {
            if (delErr) {
                log.error({err: delErr}, 'Could delete expired placeholder ' +
                    'image %s', image.uuid);
                return;
            }
            app.cacheInvalidateDelete('Image', image);
            log.info('Expired placeholder image deleted %s', image.uuid);
        });
    }

    setInterval(function () {
        // expires <= now
        app.db.search({ filter: {expires_at: now} }, function (err, rawItems) {
            if (err) {
                log.error({err: err}, 'Could not retrieve list of expired ' +
                    'placeholder images');
                return;
            }
            var image;
            for (var i = 0; i < rawItems.length; i++) {
                image = rawItems[i];
                if (image.state === 'creating' || image.state === 'failed') {
                    deleteImage(image);
                }
            }
        });

    }, CHECK_INTERVAL);
};


App.prototype.setupRemoteArchiveInterval = function () {
    // 5 minutes
    var CHECK_INTERVAL = 300000;
    var MANIFEST_FILE_REGEX =
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.json$/;
    var self = this;
    var log = self.log;

    if (!self.storage.manta) {
        self.log.info('Remote archiving support not available');
        return;
    }

    var localDir = self.storage.local.archiveDir;
    function sync() {
        setTimeout(syncManifests, CHECK_INTERVAL);
    }
    sync();

    function syncManifests() {
        // First loop through directories and then through files
        fs.readdir(localDir, function (dirErr, dirs) {
            if (dirErr) {
                self.log.warn(dirErr, 'Error reading local archive' +
                    'directories');
                sync();
                return;
            }
            dirs.sort();
            async.forEachSeries(dirs, syncDir, function (syncDirErr) {
                if (syncDirErr) {
                    self.log.error(syncDirErr, 'Error archiving ' +
                        'manifests to remote');
                } else {
                    self.log.debug('Manifests successfully archived to remote');
                }
                sync();
            });
        });
    }

    function syncDir(dir, nextDir) {
        var isDir = fs.lstatSync(path.join(localDir, dir)).isDirectory();
        if (!isDir) {
            log.info('Non directory file %s found in archive path', dir);
            return nextDir();
        }

        // Now loop through every file in the directory
        fs.readdir(path.join(localDir, dir), function (dirErr, files) {
            if (dirErr) {
                return nextDir(dirErr);
            }

            files.sort();
            async.forEachSeries(files, oneFile, cleanupDir);

            function oneFile(filename, nextFile) {
                if (! MANIFEST_FILE_REGEX.test(filename)) {
                    log.warn('"%s" file does not belong in archive', filename);
                    return nextFile();
                }
                var filepath = path.join(localDir, dir, filename);
                log.trace({ filepath: filepath }, 'load manifest file');

                fs.readFile(filepath, 'utf8', function (readErr, content) {
                    if (readErr) {
                        return nextFile(readErr);
                    }
                    var manifest;
                    try {
                        manifest = JSON.parse(content);
                    } catch (syntaxErr) {
                        log.warn(syntaxErr, 'could not parse "%s" in archive',
                            filepath);
                        return nextFile();
                    }

                    self.storage.manta.archiveImageManifest(manifest,
                    function (archErr) {
                        if (archErr) {
                            return nextFile(archErr);
                        }

                        // Proceed to remove locally when it's archived to Manta
                        self.log.trace({ filepath: filepath },
                            'unlink from local archive');
                        fs.unlink(filepath, function (fErr) {
                            if (fErr) {
                                return nextFile(fErr);
                            }
                            nextFile();
                        });
                    });
                });
            }
        });

        function cleanupDir(syncErr) {
            if (syncErr) {
                return nextDir(syncErr);
            }
            // Recheck if empty
            fs.readdir(path.join(localDir, dir), function (dirErr, files) {
                if (dirErr) {
                    return nextDir(dirErr);
                }
                if (files.length === 0) {
                    fs.rmdir(path.join(localDir, dir), nextDir);
                } else {
                    return nextDir();
                }
            });
        }
    }
};



/**
 * Gets Application up and listening.
 *
 * @param callback {Function} `function (err)`.
 */
App.prototype.listen = function (callback) {
    this.server.listen(this.port, '0.0.0.0', callback);
};


App.prototype.cacheGet = function (scope, key) {
    var hit = this._cacheFromScope[scope].get(key);
    //this.log.trace('App.cacheGet scope="%s" key="%s": %s', scope, key,
    //  (hit ? 'hit' : "miss"));
    return hit;
};


App.prototype.cacheSet = function (scope, key, value) {
    //this.log.trace('App.cacheSet scope="%s" key="%s"', scope, key);
    this._cacheFromScope[scope].set(key, value);
};


App.prototype.cacheDel = function (scope, key) {
    this._cacheFromScope[scope].del(key);
};


/**
 * Invalidate caches as appropriate for the given DB object create/update.
 *
 * XXX This should move into images.js#Image class.
 */
App.prototype.cacheInvalidateWrite = function (modelName, item) {
    var log = this.log;

    var key = item.uuid;
    assert.string(key, 'key');
    log.trace('App.cacheInvalidateWrite modelName="%s" key="%s"',
        modelName, key);

    // Reset the '${modelName}List' cache.
    // Note: This could be improved by only invalidating the item for this
    // specific user. We are being lazy for starters here.
    var scope = modelName + 'List';
    this._cacheFromScope[scope].reset();

    // Delete the '${modelName}Get' cache item with this id (possible because
    // we cache error responses).
    this._cacheFromScope[modelName + 'Get'].del(key);
};


/**
 * Invalidate caches as appropriate for the given DB object delete.
 *
 * XXX This should move into images.js#Image class.
 */
App.prototype.cacheInvalidateDelete = function (modelName, item) {
    var log = this.log;

    var key = item.uuid;
    assert.string(key, 'key');
    log.trace('App.cacheInvalidateDelete modelName="%s" key="%s"',
        modelName, key);

    // Reset the '${modelName}List' cache.
    // Note: This could be improved by only invalidating the item for this
    // specific user. We are being lazy for starters here.
    var scope = modelName + 'List';
    this._cacheFromScope[scope].reset();

    // Delete the '${modelName}Get' cache item with this id.
    this._cacheFromScope[modelName + 'Get'].del(key);
};



/**
 * Gather JSON repr of live state.
 */
App.prototype.getStateSnapshot = function () {
    var self = this;
    var snapshot = {
        cache: {},
        log: { level: this.log.level() },
        storageTypes: Object.keys(this.config.storage)
    };
    Object.keys(this._cacheFromScope).forEach(function (scope) {
        snapshot.cache[scope] = self._cacheFromScope[scope].dump();
    });
    if (this.config.database.type === 'local') {
        snapshot.db = {};
        snapshot.db.manifestFromUuid = this.db.manifestFromUuid;
    }
    return snapshot;
};


/**
 * Choose a storage (e.g. MantaStorage or LocalStorage) for use in storing
 * something (i.e. an image file or icon).
 *
 * @param image {Object} The image for which we are choosing file/icon storage.
 * @param preferredStor {String} The preferred storage type, e.g. 'manta', if
 *      any. Passing 'manta' here effectively means, "use Manta, even if it
 *      is remote (i.e. across the WAN)".
 */
App.prototype.chooseStor = function chooseStor(image, preferredStor) {
    assert.object(image, 'image');
    assert.optionalString(preferredStor, 'preferredStor');

    // If we have *remote* Manta storage, then we only want to use it where
    // we "have" to. We "have" to for customer-created custom images (because
    // billing, HA, image export, etc.). We *don't* want to use a remote Manta
    // for admin-added full images. The way we distinguish is if the image owner
    // is the admin user.
    //
    // We will allow remote-manta storage for admin-owned images if it is
    // explicitly requested via 'preferredStor' (which only someone with
    // admin access to the API is allowed to do).
    var remoteMantaOk = (image.owner !== this.config.adminUuid ||
        preferredStor === 'manta');

    var stor;
    if (preferredStor === undefined) {
        stor = this.storage.manta || this.storage.local;
    } else {
        stor = this.storage[preferredStor];
        if (stor === undefined)
            stor = this.storage.local;
    }
    if (!remoteMantaOk && stor.type === 'manta') {
        stor = this.storage.local;
    }
    return stor;
};

/**
 * Get a storage handler by type.
 *
 * @param type {String} The storage type, e.g. 'local' or 'manta'.
 * @returns {Storage} A storage handler, or undefined if don't have that
 *      storage type.
 */
App.prototype.getStor = function getStor(type) {
    assert.string(type, 'type');
    return this.storage[type];
};


/**
 * Close this app.
 *
 * @param {Function} callback called when closed. Takes no arguments.
 */
App.prototype.close = function (callback) {
    this.server.on('close', function () {
        callback();
    });
    this.server.close();
};



//---- exports

/**
 * Create and setup the app.
 *
 * @param config {Object} The amon master config object.
 * @param log {Bunyan Logger instance}
 * @param callback {Function} `function (err, app) {...}`.
 */
function createApp(config, log, callback) {
    if (!config) throw new TypeError('config (Object) required');
    if (!log) throw new TypeError('log (Bunyan Logger) required');
    if (!callback) throw new TypeError('callback (Function) required');

    var app;
    try {
        app = new App(config, log);
    } catch (e) {
        return callback(e);
    }
    app.setup(function (err) {
        log.info('app setup is complete: err=%s', err);
        callback(err, app);
    });
}


module.exports = {
    createApp: createApp
};
