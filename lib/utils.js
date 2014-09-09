/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * IMGAPI utilities.
 */

var assert = require('assert-plus');
var format = require('util').format;
var semver = require('semver');

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



function objCopy(obj) {
    var copy = {};
    Object.keys(obj).forEach(function (k) {
        copy[k] = obj[k];
    });
    return copy;
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
 * Converts a key=value to a javascript literal (Moray->Image)
 *
 * foo=bar
 * => { foo: 'bar' }
 */
function keyValueToObject(array) {
    if (!array) {
        throw new TypeError('Array of key/values required');
    } else if (typeof (array) === 'string') {
        array = [array];
    }

    var obj = {};
    array.forEach(function (keyvalue) {
        var kv = keyvalue.split('=');

        if (kv.length != 2) {
            throw new TypeError('Key/value string expected');
        }

        obj[kv[0]] = kv[1];
    });

    return obj;
}


/*
 * Converts a javascript literal to a key=value. The literal is expected to have
 * simple string/numeric values for its properties. (Image->UFDS)
 *
 * { foo: 'bar' }
 * => foo=bar
 */
function objectToKeyValue(obj) {
    var MAX_VALUE_LENGTH = 100;

    if (!obj || typeof (obj) !== 'object') {
        throw new TypeError('Object required');
    }

    var value, values = [];

    Object.keys(obj).forEach(function (key) {
        value = obj[key];
        // Don't do this for big values and don't do it for object values. This
        // doesn't affect image.tags because image.tag are only the indexed
        // values. It means that you can't search on big/object values
        if (typeof (value) === 'object' ||
            value.toString().length > MAX_VALUE_LENGTH) {
            value = '';
        }
        values.push(key + '=' + value);
    });

    return values;
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



//---- exports

module.exports = {
    redir: redir,
    objCopy: objCopy,
    boolFromString: boolFromString,
    pauseStream: pauseStream,
    isPositiveInteger: isPositiveInteger,
    validPlatformVersion: validPlatformVersion,
    keyValueToObject: keyValueToObject,
    objectToKeyValue: objectToKeyValue,
    imgadmVersionFromReq: imgadmVersionFromReq,
    checkOwnerExists: checkOwnerExists,
    semverGter: semverGter
};
