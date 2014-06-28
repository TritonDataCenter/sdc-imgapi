/*
 * Copyright 2014 Joyent, Inc.  All rights reserved.
 *
 * IMGAPI channels endpoints and utils.
 */

var p = console.log;
var assert = require('assert-plus');
var util = require('util'),
    format = util.format;

var utils = require('./utils');
var errors = require('./errors');



//---- globals

var CHANNEL_NAME_RE = /^[a-z][a-z0-9_-]*$/;



//---- endpoint handlers

/**
 * ListChannels
 */
function apiListChannels(req, res, cb) {
    var channelFromName = req._app.channelFromName;
    var channels = [];
    Object.keys(channelFromName).forEach(function (name) {
        channels.push(channelFromName[name]);
    });
    res.send(channels);
    cb();
}



//---- exports



/**
 * Load channels info from the config, validate it and return it.
 *
 * @param config {Object}
 * @returns {Array} [<defaultChannel>, <channelFromName>]
 * @throws {AssertionError} on error
 */
function channelInfoFromConfig(config) {
    if (!config.channels) {
        return null;
    }
    assert.arrayOfObject(config.channels, 'config.channels');
    if (config.channels.length === 0) {
        assert.ok(false, 'empty "config.channels" array');
    }
    var channelFromName = {};
    var defaultChannel = null;
    for (var i = 0; i < config.channels.length; i++) {
        var chan = utils.objCopy(config.channels[i]);
        assert.string(chan.name, 'config.channels['+i+'].name');
        assert.ok(CHANNEL_NAME_RE.test(chan.name),
            format('invalid channel name: %j, must match %s',
                chan.name, CHANNEL_NAME_RE));
        assert.string(chan.description, 'config.channels['+i+'].description');
        if (chan.hasOwnProperty('default')) {
            assert.bool(chan.default, 'config.channels['+i+'].default');
            if (defaultChannel) {
                assert.ok(false,
                    format('cannot have multiple *default* channel: %j and %j',
                        defaultChannel, chan));
            }
            defaultChannel = chan;
        }
        channelFromName[chan.name] = chan;
    }
    return [defaultChannel, channelFromName];
}


/**
 * Set `req.channel` if this app is configured for channels, or error if
 * invalid.
 */
function reqChannel(req, res, next) {
    var channelFromName = req._app.channelFromName;
    var name = req.query.channel;
    if (!channelFromName) {
        /* jsl: pass */
    } else if (!name) {
        if (req._app.defaultChannel) {
            req.channel = req._app.defaultChannel;
        } else {
            return next(new errors.ValidationFailedError(
                'channel not specified and no default channel',
                [ { field: 'channel', code: 'MissingParameter' } ]));
        }
    } else if (name === '*') {
        /* jsl: pass */
    } else if (!channelFromName[name]) {
        return next(new errors.ValidationFailedError(
            'unknown channel: ' + name,
            [ { field: 'channel', code: 'Invalid' } ]));
    } else {
        req.channel = channelFromName[name];
    }
    next();
}


/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 * @param app {App} The IMGAPI app object.
 * @param reqAuth {Function} A request middleware for strict
 *      authentication of some endpoints (typically those that can make
 *      changes) of the IMGAPI.
 * @param reqPassiveAuth {Function} A request middleware for "passive"
 *      authentication. Here "passive" means that a request with the
 *      "authorization" header will be strictly enforced (i.e. 401 on
 *      auth failure), but a request with no "authorization" will be
 *      passed through. Typically the relevant endpoint will behave slightly
 *      differently for authed vs unauthed.
 */
function mountApi(server, app, reqAuth, reqPassiveAuth) {
    if (!app.channelFromName) {
        // Not using channels.
        app.log.info('Not configured for channels. Skipping channel mounts.');
        return;
    }
    app.log.info({channels: app.channelFromName}, 'mount channel endpoints');

    server.get(
        {path: '/channels', name: 'ListChannels'},
        reqPassiveAuth,
        apiListChannels);
}



//---- exports

module.exports = {
    channelInfoFromConfig: channelInfoFromConfig,
    reqChannel: reqChannel,
    mountApi: mountApi
};
