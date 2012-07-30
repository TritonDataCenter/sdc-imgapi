/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * The IMGAPI app.
 */

var assert = require('assert-plus');
var restify = require('restify');
var Cache = require('expiring-lru-cache');



//---- globals




//---- internal support stuff

/**
 * "GET /ping"
 */
function ping(req, res, next) {
  if (req.query.error !== undefined) {
    var restCode = req.query.error || 'InternalError';
    if (restCode.slice(-5) !== 'Error') {
      restCode += 'Error';
    }
    var err = new restify[restCode](req.params.message || 'pong');
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
 * @param options {Object} Contrary to *English* all these are required. :)
 *    - log {Bunyan Logger instance}
 *    - port {Integer} HTTP port on which to listen.
 *    - userCache {Object} with "size" (number of entries) and "expiry"
 *      (milliseconds) keys for a user cache.
 */
function App(options) {
  var self = this;
  assert.object(options, 'options');
  assert.object(options.log, 'options.log');
  assert.number(options.port, 'options.port');
  assert.object(options.userCache, 'options.userCache');

  this.log = options.log;
  this.port = options.port;

  // Cache of login/uuid (aka username) -> full user record.
  this.userCache = new Cache({
    size: options.userCache.size,
    expiry: options.userCache.expiry,
    log: this.log,
    name: 'user'
  });

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
  server.get({path: '/ping', name: 'Ping'}, ping);
  //// XXX Kang-ify (https://github.com/davepacheco/kang)
  //server.get({path: '/state', name: 'GetState'}, function (req, res, next) {
  //  res.send(self.getStateSnapshot());
  //  next();
  //});
  //server.post({path: '/state', name: 'UpdateState'},
  //  function apiDropCaches(req, res, next) {
  //    if (req.query.action !== 'dropcaches')
  //      return next();
  //    self.userCache.reset();
  //    self.isOperatorCache.reset();
  //    self.cnapiServersCache.reset();
  //    Object.keys(self._cacheFromScope).forEach(function (scope) {
  //      self._cacheFromScope[scope].reset();
  //    });
  //    res.send(202);
  //    next(false);
  //  },
  //  function invalidAction(req, res, next) {
  //    if (req.query.action)
  //      return next(new restify.InvalidArgumentError(
  //        '"%s" is not a valid action', req.query.action));
  //    return next(new restify.MissingParameterError('"action" is required'));
  //  }
  //);

  //datasets.mountApi(server);  // Backward compatibility layer for SDC 6.5.
  //images.mountApi(server);
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



module.exports = App;
