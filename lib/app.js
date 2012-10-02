/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * The IMGAPI app.
 */

var assert = require('assert-plus');
var restify = require('restify');
var Cache = require('expiring-lru-cache');
var Pool = require('generic-pool').Pool;
var ldap = require('ldapjs');

var images = require('./images');



//---- globals




//---- internal support stuff

/**
 * "GET /ping"
 */
function apiPing(req, res, next) {
    if (req.query.error !== undefined) {
        var restCode = req.query.error || 'InternalError';
        if (restCode.slice(-5) !== 'Error') {
            restCode += 'Error';
        }
        var errClass;
        try {
            errClass = restify[restCode];
        } catch (err2) {
            return next(409, err2)
        }
        var err = new restify[restCode](req.query.message || 'pong');
        next(err);
    } else {
        var data = {
            ping: 'pong',
            pid: process.pid,  // used by test suite
            version: App.version
        };
        res.send(data);
        next();
    }
}




//---- exports

/**
 * The Image API application.
 *
 * @param config {Object} Contrary to *English* all these are required. :)
 *    - port {Integer} HTTP port on which to listen.
 *    - userCache {Object} with "size" (number of entries) and "expiry"
 *      (milliseconds) keys for a user cache.
 * @param log {Bunyan Logger instance}
 */
function App(config, log) {
    var self = this;
    assert.object(config, 'config');
    assert.number(config.port, 'config.port');
    assert.object(config.userCache, 'config.userCache');
    if (!config.ufds) throw new TypeError('config.ufds (Object) required');

    this.log = log;
    this.port = config.port;
    this._ufdsCaching = (config.ufds.caching === undefined
      ? true : config.ufds.caching);

    // TODO: reduce this whole pool down to ldapjs-internal pooling
    // or beefed up sdc-clients/ufds.js support.
    var ufdsPoolLog = log.child({'ufdsPool': true}, true);
    this.ufdsPool = Pool({
        name: 'ufds',
        max: 10,
        idleTimeoutMillis : 30000,
        reapIntervalMillis: 5000,
        create: function createUfdsClient(callback) {
            // TODO: should change to sdc-clients.UFDS at some point.
            var client = ldap.createClient({
                url: config.ufds.url,
                connectTimeout: 2 * 1000,  // 2 seconds (fail fast)
                log: ufdsPoolLog
            });
            function onFail(failErr) {
                callback(failErr);
            }
            client.once('error', onFail);
            client.once('connectTimeout', onFail);
            client.on('connect', function () {
                client.removeListener('error', onFail);
                client.removeListener('connectTimeout', onFail);
                ufdsPoolLog.debug({rootDn: config.ufds.rootDn}, 'bind to UFDS');
                client.bind(config.ufds.rootDn, config.ufds.password, function (bErr) {
                    if (bErr) {
                        return callback(bErr);
                    }
                    return callback(null, client);
                });
            });
        },
        destroy: function destroyUfdsClient(client) {
            client.unbind(function () {
                log.debug('unbound from UFDS');
            });
        },
        log: function (msg, level) {
            var fn = {
                //'verbose': ufdsPoolLog.trace,  // disable this for prod, little wordy
                'info': ufdsPoolLog.trace,
                'warn': ufdsPoolLog.warn,
                'error': ufdsPoolLog.error
            }[level];
            if (fn) fn.call(ufdsPoolLog, msg);
        }
    });

    // Cache of login/uuid (aka username) -> full user record.
    this.userCache = new Cache({
        size: config.userCache.size,
        expiry: config.userCache.expiry,
        log: this.log,
        name: 'user'
    });
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
        name: 'IMGAPI/' + App.version,
        log: this.log
    });
    server.use(restify.queryParser({mapParams: false}));
    server.use(restify.bodyParser({mapParams: false}));
    server.on('after', restify.auditLogger({log: this.log, body: true}));
    server.on('uncaughtException', function (req, res, route, err) {
        req.log.error(err);
        res.send(err);
    });
    server.use(function setupReq (req, res, next) {
        req._app = self;
        next();
    });

    // Debugging/dev/testing endpoints.
    server.get({path: '/ping', name: 'Ping'}, apiPing);
    // XXX Kang-ify (https://github.com/davepacheco/kang)
    server.get({path: '/state', name: 'GetState'}, function (req, res, next) {
        res.send(self.getStateSnapshot());
        next();
    });
    server.post({path: '/state', name: 'UpdateState'},
        function apiDropCaches(req, res, next) {
            if (req.query.action !== 'dropcaches')
                return next();
            self.userCache.reset();
            self.isOperatorCache.reset();
            self.cnapiServersCache.reset();
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
            return next(new restify.MissingParameterError('"action" is required'));
        }
    );

    //XXX
    //datasets.mountApi(server);  // Backward compatibility layer for SDC 6.5.
    images.mountApi(server);
}


App.version = require(__dirname + '/../package.json').version;


/**
 * Gets Application up and listening.
 *
 * @param callback {Function} `function (err)`.
 */
App.prototype.listen = function (callback) {
  this.server.listen(this.port, '0.0.0.0', callback);
};


App.prototype.cacheGet = function (scope, key) {
  if (! this._ufdsCaching)
    return null;
  var hit = this._cacheFromScope[scope].get(key);
  //this.log.trace('App.cacheGet scope="%s" key="%s": %s', scope, key,
  //  (hit ? 'hit' : "miss"));
  return hit;
};


App.prototype.cacheSet = function (scope, key, value) {
  if (! this._ufdsCaching)
    return;
  //this.log.trace('App.cacheSet scope="%s" key="%s"', scope, key);
  this._cacheFromScope[scope].set(key, value);
};


App.prototype.cacheDel = function (scope, key) {
  if (! this._ufdsCaching)
    return;
  this._cacheFromScope[scope].del(key);
};


/**
 * Invalidate caches as appropriate for the given DB object create/update.
 */
App.prototype.cacheInvalidateWrite = function (modelName, item) {
  if (! this._ufdsCaching)
    return;
  var log = this.log;

  var dn = item.dn;
  assert.ok(dn);
  log.trace('App.cacheInvalidateWrite modelName="%s" dn="%s"',
    modelName, dn);

  // Reset the '${modelName}List' cache.
  // Note: This could be improved by only invalidating the item for this
  // specific user. We are being lazy for starters here.
  var scope = modelName + 'List';
  this._cacheFromScope[scope].reset();

  // Delete the '${modelName}Get' cache item with this dn (possible because
  // we cache error responses).
  this._cacheFromScope[modelName + 'Get'].del(dn);
};


/**
 * Invalidate caches as appropriate for the given DB object delete.
 */
App.prototype.cacheInvalidateDelete = function (modelName, item) {
  if (! this._ufdsCaching)
    return;
  var log = this.log;

  var dn = item.dn;
  assert.ok(dn);
  log.trace('App.cacheInvalidateDelete modelName="%s" dn="%s"',
    modelName, dn);

  // Reset the '${modelName}List' cache.
  // Note: This could be improved by only invalidating the item for this
  // specific user. We are being lazy for starters here.
  var scope = modelName + 'List';
  this._cacheFromScope[scope].reset();

  // Delete the '${modelName}Get' cache item with this dn.
  this._cacheFromScope[modelName + 'Get'].del(dn);
};



/**
 * Gather JSON repr of live state.
 */
App.prototype.getStateSnapshot = function () {
  var snapshot = {
    cache: {
      user: this.userCache.dump(),
    },
    log: { level: this.log.level() }
  };
  return snapshot;
};


/**
 * UFDS search
 *
 * @param base {String}
 * @param opts {String} Search options for `ufdsClient.search()`
 * @param callback {Function} `function (err, items)`
 */
App.prototype.ufdsSearch = function ufdsSearch(base, opts, callback) {
  var log = this.log;
  var pool = this.ufdsPool;
  pool.acquire(function (poolErr, client) {
    if (poolErr) {
      log.warn(poolErr, 'UFDS pool error');
      return callback(new restify.ServiceUnavailableError(
        'service unavailable'));
    }

    log.trace({filter: opts.filter}, 'ldap search');
    client.search(base, opts, function (sErr, result) {
      if (sErr) {
        pool.release(client);
        log.warn(sErr, 'UFDS search error');
        // 503: presuming this is a "can't connect to UFDS" error.
        return callback(new restify.ServiceUnavailableError(
          'service unavailable'));
      }

      var items = [];
      result.on('searchEntry', function (entry) {
        items.push(entry.object);
      });

      result.on('error', function (err) {
        pool.release(client);
        return callback(err);  // XXX xlate err
      });

      result.on('end', function (res) {
        pool.release(client);
        if (res.status !== 0) {
          return callback(new restify.InternalError(
            'non-zero status from LDAP search: ' + res));
        }
        callback(null, items);
      });
    });
  });
};

/**
 * Add an item to UFDS
 *
 * @param dn {String}
 * @param data {Object}
 * @param callback {Function} `function (err)`
 */
App.prototype.ufdsAdd = function ufdsAdd(dn, data, callback) {
  var log = this.log;
  var pool = this.ufdsPool;
  pool.acquire(function (poolErr, client) {
    if (poolErr) {
      log.warn(poolErr, 'UFDS pool error');
      return callback(new restify.ServiceUnavailableError(
        'service unavailable'));
    }
    client.add(dn, data, function (addErr) {
      pool.release(client);
      if (addErr) {
        if (addErr instanceof ldap.EntryAlreadyExistsError) {
          return callback(new restify.InternalError(
            'XXX DN "'+dn+'" already exists. Can\'t nicely update '
            + '(with LDAP modify/replace) until '
            + '<https://github.com/mcavage/node-ldapjs/issues/31> is fixed.'));
          //XXX Also not sure if there is another bug in node-ldapjs if
          //    "objectclass" is specified in here. Guessing it is same bug.
          //var change = new ldap.Change({
          //  operation: 'replace',
          //  modification: item.raw
          //});
          //client.modify(dn, change, function (err) {
          //  if (err) console.warn("client.modify err: %s", err)
          //  client.unbind(function (err) {});
          //});
          //XXX Does replace work if have children?
        }
        return callback(addErr); //XXX xlate error
      }
      callback();
    });
  });
};

/**
 * Delete an item from UFDS
 *
 * @param dn {String}
 * @param callback {Function} `function (err)`
 */
App.prototype.ufdsDelete = function ufdsDelete(dn, callback) {
  var log = this.log;
  var pool = this.ufdsPool;
  pool.acquire(function (poolErr, client) {
    if (poolErr) {
      log.warn(poolErr, 'UFDS pool error');
      return callback(new restify.ServiceUnavailableError(
        'service unavailable'));
    }
    client.del(dn, function (delErr) {
      pool.release(client);
      if (delErr) {
        if (delErr instanceof ldap.NoSuchObjectError) {
          callback(new restify.ResourceNotFoundError());
        } else {
          log.error(delErr, 'Error deleting "%s" from UFDS', dn);
          callback(new restify.InternalError());
        }
      } else {
        callback();
      }
    });
  });
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
 * Create the app.
 *
 * @param config {Object} The amon master config object.
 * @param log {Bunyan Logger instance}
 * @param callback {Function} `function (err, app) {...}`.
 */
function createApp(config, log, callback) {
  if (!config) throw new TypeError('config (Object) required');
  if (!config.ufds) throw new TypeError('config.ufds (Object) required');
  if (!log) throw new TypeError('log (Bunyan Logger) required');
  if (!callback) throw new TypeError('callback (Function) required');

  try {
    var app = new App(config, log);
    return callback(null, app);
  } catch (e) {
    return callback(e);
  }
}


module.exports = {
    createApp: createApp
};
