/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * The IMGAPI app.
 */

var format = require('util').format;
var os = require('os');
var crypto = require('crypto');
var path = require('path');
var fs = require('fs');

var assert = require('assert-plus');
var restify = require('restify');
var Cache = require('expiring-lru-cache');
var async = require('async');
var bunyan = require('bunyan');

var database = require('./database');
var storage = require('./storage');
var utils = require('./utils');
var errors = require('./errors');
var images = require('./images');
var audit = require('./audit');



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
        var faviconPath = path.resolve(__dirname, '..', 'public', 'favicon.ico');
        fs.readFile(faviconPath, function (err, buf) {
            if (err)
                return next(err);

            var hash = crypto.createHash('md5');
            hash.update(buf);
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
        // emit that for an unauthenticate request to a 'public' mode server.
        if (req._app.mode !== 'public' || req.remoteUser) {
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
    assert.equal(config.mode, 'public', 'config.mode');
    assert.object(config.auth, 'config.auth');
    assert.ok(['basic', 'signature'].indexOf(config.auth.type) !== -1,
        'config.auth.type');
    assert.bool(passive, 'passive');

    if (config.auth.type === 'basic') {
        // Adapted from Connect's "lib/middleware/basicAuth.js".
        var bcrypt = require('bcrypt');

        assert.optionalString(config.auth.realm, 'config.auth.realm');
        assert.object(config.auth.users, 'config.auth.users');

        var realm = config.realm || "IMGAPI";
        var users = config.auth.users;
        var salt = bcrypt.genSaltSync(10);

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
                    next(new errors.InternalError( err, 'error authorizing'));
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
                        "bad ssh key");
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
    this.serverName = config.serverName || 'IMGAPI/' + App.version;
    this.db = new database[config.database.type](config.database, log);

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
        }
    });

    // Hack to ensure we don't miss `req` stream events. See comment for
    // `pauseStream`. This also then requires some juggling to get requests
    // requiring `bodyParser` to not hang on a paused req stream.
    server.pre(function pauseReqStream(req, res, next) {
        utils.pauseStream(req);
        next();
    });

    server.use(function setup(req, res, next) {
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
    server.use(restify.queryParser({mapParams: false}));
    server.on('after', audit.auditLogger({
        body: true,
        log: bunyan.createLogger({
            name: 'imgapi',
            component: 'audit',
            streams: [{
                level: log.level(),  // use same level as general log
                stream: process.stdout
            }]
        })
    }));
    server.on('uncaughtException', function (req, res, route, err) {
        req.log.error(err);
        res.send(err);
    });

    var reqAuth = getAuthMiddleware(this, config, false);
    var reqPassiveAuth = getAuthMiddleware(this, config, true);

    // Misc endpoints (often for dev, debugging and testing).
    server.get({path: '/favicon.ico', name: 'Favicon'}, apiFavicon);
    server.get({path: '/ping', name: 'Ping'},
        reqPassiveAuth, apiPing);
    // XXX Kang-ify (https://github.com/davepacheco/kang)
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

    images.mountApi(server, reqAuth, reqPassiveAuth);
}


App.version = require(__dirname + '/../package.json').version;


/**
 * Async prep/setup for an App.
 *
 * @param callback {Function} `function (err)`.
 */
App.prototype.setup = function setup(callback) {
    assert.func(callback, 'callback');
    var self = this;
    var log = this.log;

    this.db.setup(self, function (dbErr) {
        if (dbErr) {
            return callback(dbErr);
        }

        self.storage = {};
        var types = Object.keys(self.config.storage);
        for (var i = 0; i < types.length; i++) {
            var type = types[i];
            var config = self.config.storage[type];
            var StorageClass = storage[type];
            log.info({type: type, config: config}, "create storage handler");
            try {
                self.storage[type] = new StorageClass({log: log, config: config});
            } catch (ctorErr) {
                return callback(ctorErr);
            }
        }

        async.forEach(
            Object.keys(self.storage),
            function setupOneStorage(type, next) {
                log.info({type: type}, "setup storage");
                self.storage[type].setup(next);
            },
            callback
        );
    });
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
        log: { level: this.log.level() }
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
 * Return a write stream to storage for the image file for the given image.
 *
 */
App.prototype.storFromImage = function storFromImage(image, preferredStor) {
    assert.object(image, 'image');

    if (preferredStor === undefined) {
        return this.storage.manta || this.storage.local;
    } else {
        // i.e. we want manta for customer images but this imgapi doesn't have
        // manta setup yet, which translates to this.storage.manta == undefined
        var storage = this.storage[preferredStor];
        if (storage === undefined) storage = this.storage.local;

        return storage;
    }
};

/**
 * Get a storage handler by type.
 *
 * @param type {String} The storage type, e.g. 'local' or 'manta'.
 * @returns {Storage} A storage handler.
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
        log.info('app setup is complete');
        callback(err, app);
    });
}


module.exports = {
    createApp: createApp
};
