/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * IMGAPI utilities.
 */

var assert = require('assert-plus');
var child_process = require('child_process');
var format = require('util').format;
var semver = require('semver');
var url = require('url');

var errors = require('./errors');



/**
 * Return a restify handler to redirect to the given location.
 *
 * @param location {String} Path to with to redirect.
 * @param permanent {Boolean} Optional. If true, then uses "301" (Moved
 *      Permanently), else uses "302" (Found). Default is false.
 */
function redir(location, permanent) {
    assert.string(location, 'location');
    assert.optionalBool(permanent, permanent);
    var code = (permanent ? 301 : 302);

    return function redirect(req, res, next) {
        res.set('Content-Length', 0);
        res.set('Connection', 'keep-alive');
        res.set('Date', new Date());
        res.set('Location', location);
        res.send(code);
        next();
    };
}



function objCopy(obj, target) {
    if (!target) {
        target = {};
    }
    Object.keys(obj).forEach(function (k) {
        target[k] = obj[k];
    });
    return target;
}


/**
 * Convert a boolean or string representation (as in redis or UFDS or a
 * query param) into a boolean, or raise InvalidParameterError trying.
 *
 * @param value {Boolean|String} The input value to convert.
 * @param default_ {Boolean} The default value if `value` is undefined.
 * @param field {String} The field name to quote in the possibly
 *      raised error.
 */
function boolFromString(value, default_, field) {
    assert.bool(default_, 'default_');
    assert.string(field, 'field');

    if (value === undefined) {
        return default_;
    } else if (value === 'false') {
        return false;
    } else if (value === 'true') {
        return true;
    } else if (typeof (value) === 'boolean') {
        return value;
    } else {
        throw new errors.InvalidParameterError(
            format('invalid value for "%s" param: %j is not a boolean',
                field, value),
            [ { field: field, code: 'Invalid' } ]);
    }
}


/**
 * Note: Borrowed from muskie.git/lib/common.js. The hope is that this hack
 * will no longer be necessary in node 0.10.x.
 *
 * This is so shitty...
 * Node makes no guarantees it won't emit. Even if you call pause.
 * So basically, we buffer whatever chunks it decides it wanted to
 * throw at us. Later we go ahead and remove the listener we setup
 * to buffer, and then re-emit.
 */
function pauseStream(stream) {
    function _buffer(chunk) {
        stream.__buffered.push(chunk);
    }

    function _catchEnd(chunk) {
        stream.__imgapi_ended = true;
    }

    stream.__imgapi_ended = false;
    stream.__imgapi_paused = true;
    stream.__buffered = [];
    stream.on('data', _buffer);
    stream.once('end', _catchEnd);
    stream.pause();

    stream._resume = stream.resume;
    stream.resume = function _imgapi_resume() {
        if (!stream.__imgapi_paused)
            return;

        stream.removeListener('data', _buffer);
        stream.removeListener('end', _catchEnd);

        stream.__buffered.forEach(stream.emit.bind(stream, 'data'));
        stream.__buffered.length = 0;

        stream._resume();
        stream.resume = stream._resume;

        if (stream.__imgapi_ended)
            stream.emit('end');
    };
}


function isPositiveInteger(n) {
    return typeof (n) === 'number' && n % 1 === 0;
}



/**
 * Validates that a platform string has the following format:
 *
 * YYYYMMDDTHHMMSSZ
 */
function validPlatformVersion(string) {
    var MIN_YEAR = 2012;

    // 20130308T102805Z
    if (string.length !== 16) {
        return false;
    // 2013
    } else if (Number(string.substr(0, 4)) < MIN_YEAR) {
        return false;
    // 03
    } else if (Number(string.substr(4, 2)) > 12 ||
        Number(string.substr(4, 2)) === 0) {
        return false;
    // 08
    } else if (Number(string.substr(6, 2)) > 31 ||
        Number(string.substr(6, 2)) === 0) {
        return false;
    // T
    } else if (string.substr(8, 1) !== 'T') {
        return false;
    // 10
    } else if (Number(string.substr(9, 2)) > 23) {
        return false;
    // 28
    } else if (Number(string.substr(11, 2)) > 59) {
        return false;
    // 05
    } else if (Number(string.substr(13, 2)) > 59) {
        return false;
    // Z
    } else if (string.substr(15, 1) !== 'Z') {
        return false;
    }

    return true;
}



/**
 * Before IMGAPI-452 we didn't have 'tagsObj' stored in the database. For
 * images with 'tags' (i.e. the tagsSearchArray), we recover 'tagsObj' as
 * best we can ('tags' doesn't have full fidelity).
 */
function tagsObjFromSearchArray(tagsSearchArray) {
    assert.arrayOfString(tagsSearchArray, 'tagsSearchArray');

    var tagsObj = {};
    tagsSearchArray.forEach(function (kv) {
        var equalIdx = kv.indexOf('=');
        if (equalIdx === -1) {
            throw new TypeError(format(
                'invalid key=value, "%s", in tagsSearchArray, "%s"',
                kv, tagsSearchArray));
        }
        tagsObj[kv.slice(0, equalIdx)] = kv.slice(equalIdx + 1);
    });

    return tagsObj;
}


/**
 * Convert an image "tags" object of key/value pairs to an array of
 *      key=value
 * strings to be indexed in the database and used for searching.
 *
 * Two limitations here (see IMGAPI-452):
 *
 * 1. IMGAPI searching by tag *values* doesn't support values that are complex
 *    objects so those are normalized to the empty string (allowing one to
 *    test for presence, but not the value).
 * 2. A tag value string greater than 100 chars will also be normalized to
 *    the empty string.
 */
function tagsSearchArrayFromObj(tagsObj) {
    assert.object(tagsObj, 'tagsObj');

    var MAX_VALUE_LENGTH = 100;

    var tagsSearchArray = [];
    var keys = Object.keys(tagsObj);
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = tagsObj[k];
        switch (typeof (v)) {
        case 'string':
            if (v.length > MAX_VALUE_LENGTH) {
                v = '';
            }
            break;
        case 'number':
        case 'boolean':
            v = v.toString();
            break;
        default:
            v = '';
            break;
        }
        tagsSearchArray.push(k + '=' + v);
    }

    return tagsSearchArray;
}


/**
 * Extract the calling imgadm version from the User-Agent of the given
 * request object, if possible. Returns `null` if could not determine.
 */
function imgadmVersionFromReq(req) {
    var ua = req.headers['user-agent'];
    if (!ua) {
        return null;
    }
    var match = /^imgadm\/([\d\.]+) /.exec(ua);
    if (!match) {
        return null;
    }
    return match[1];
}



/**
 * Check that the given owner (uuid) exists.
 * Note: The check is skipped if `app.mode !== "dc"`, e.g. if this IMGAPI is
 * running outside of an SDC install.
 *
 * @param opts {Object} Required.
 *      - app {App}
 *      - owner {UUID} Owner UUID to check.
 * @param cb {Function} `function (err)`
 * @throws {OwnerDoesNotExistError} if the owner does not exist.
 */
function checkOwnerExists(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.uuid(opts.owner, 'opts.owner');
    assert.func(cb, 'cb');

    if (opts.app.mode === 'dc') {
        opts.app.log.debug('ensure owner "%s" exists in UFDS', opts.owner);
        opts.app.ufdsClient.getUser(opts.owner, function (err, user) {
            if (err) {
                return cb(new errors.OwnerDoesNotExistError(
                    err, opts.owner));
            } else if (user.uuid !== opts.owner) {
                // Necessary guard for `user.login === opts.owner`.
                // TODO: This check would not be necessary if we had a UFD
                // client lookup of users *by UUID only*.
                return cb(new errors.OwnerDoesNotExistError(opts.owner));
            }
            cb();
        });
    } else {
        cb();
    }
}


/**
 * Is the given semver range (e.g. from Accept-Version header)
 * greater than or equal to the given `ver` (e.g. a set starting version
 * for an IMGAPI feature).
 */
function semverGter(range, ver) {
    return (range === '*' ||
        semver.satisfies(ver, range) ||
        semver.ltr(ver, range));
}


/*
 * Returns an object with sort options for moray
 * Default sorting order is published_at ASC
 */
function parseSortOptions(params) {
    var sort = {
        attribute: 'published_at',
        order: 'ASC'
    };

    if (params.sort) {
        var splitted = params.sort.split('.');

        sort.attribute = splitted[0];
        if (splitted[1]) {
            sort.order = splitted[1];
        }
    }

    return sort;
}


/**
 * Run a command via `spawn` and callback with the results a la `execFile`.
 *
 * @param args {Object}
 *      - argv {Array} Required.
 *      - log {Bunyan Logger} Required. Use to log details at trace level.
 *      - opts {Object} Optional `child_process.spawn` options.
 * @param cb {Function} `function (err, stdout, stderr)` where `err` here is
 *      an `errors.InternalError` wrapper around the child_process error.
 */
function spawnRun(args, cb) {
    assert.object(args, 'args');
    assert.arrayOfString(args.argv, 'args.argv');
    assert.ok(args.argv.length > 0, 'argv has at least one arg');
    assert.object(args.log, 'args.log');
    assert.func(cb);

    args.log.trace({exec: true, argv: args.argv}, 'exec start');
    var child = child_process.spawn(
        args.argv[0], args.argv.slice(1), args.opts);

    var stdout = [];
    var stderr = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (chunk) { stdout.push(chunk); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', function (chunk) { stderr.push(chunk); });

    child.on('close', function spawnClose(code, signal) {
        stdout = stdout.join('');
        stderr = stderr.join('');
        args.log.trace({exec: true, argv: args.argv, code: code,
            signal: signal, stdout: stdout, stderr: stderr}, 'exec done');
        if (code || signal) {
            var msg = format(
                'spawn error:\n'
                + '\targv: %j\n'
                + '\texit code: %s\n'
                + '\texit signal: %s\n'
                + '\tstdout:\n%s\n'
                + '\tstderr:\n%s',
                args.argv, code, signal, stdout.trim(), stderr.trim());
            cb(new errors.InternalError({message: msg}),
               stdout, stderr);
        } else {
            cb(null, stdout, stderr);
        }
    });
}


/*
 * Add common (restify) HTTP client options to the given `clientOpts`.
 * Existing fields in `clientOpts` win. E.g. this function typically sets
 * `userAgent`, but will not if it already exists in clientOpts.
 */
function commonHttpClientOpts(clientOpts, req) {
    assert.object(clientOpts, 'clientOpts');
    assert.object(req, 'req');
    var app = req._app;

    // userAgent
    if (clientOpts.userAgent === undefined) {
        clientOpts.userAgent = app.serverName;
    }

    // proxy
    if (clientOpts.proxy === undefined && app.config.httpProxy) {
        // Normalize: host:port -> http://host:port
        var normUrl = app.config.httpProxy;
        if (! /^[a-z0-9]+:\/\//.test(normUrl)) {
            normUrl = 'http://' + normUrl;
        }

        clientOpts.proxy = url.parse(normUrl);
    }

    // headers.request-id
    if (req && req.getId()) {
        var req_id = (clientOpts.headers
            ? clientOpts.headers['request-id'] ||
                clientOpts.headers['x-request-id']
            : undefined);
        if (!req_id) {
            if (!clientOpts.headers) {
                clientOpts.headers = {};
            }
            clientOpts.headers['request-id'] = req.getId();
        }
    }

    return clientOpts;
}



//---- exports

module.exports = {
    redir: redir,
    objCopy: objCopy,
    boolFromString: boolFromString,
    pauseStream: pauseStream,
    isPositiveInteger: isPositiveInteger,
    validPlatformVersion: validPlatformVersion,
    tagsObjFromSearchArray: tagsObjFromSearchArray,
    tagsSearchArrayFromObj: tagsSearchArrayFromObj,
    imgadmVersionFromReq: imgadmVersionFromReq,
    checkOwnerExists: checkOwnerExists,
    semverGter: semverGter,
    parseSortOptions: parseSortOptions,
    spawnRun: spawnRun,
    commonHttpClientOpts: commonHttpClientOpts
};
