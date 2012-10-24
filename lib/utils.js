/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * IMGAPI utilities.
 */

var format = require('util').format;


function objCopy(obj) {
    var copy = {};
    Object.keys(obj).forEach(function (k) {
        copy[k] = obj[k];
    });
    return copy;
}


/**
 * Convert a boolean or string representation (as in redis or UFDS) into a
 * boolean, or raise TypeError trying.
 *
 * @param value {Boolean|String} The input value to convert.
 * @param default_ {Boolean} The default value is `value` is undefined.
 * @param errName {String} The variable name to quote in the possibly
 *      raised TypeError.
 */
function boolFromString(value, default_, errName) {
    if (value === undefined) {
        return default_;
    } else if (value === 'false') {
        return false;
    } else if (value === 'true') {
        return true;
    } else if (typeof (value) === 'boolean') {
        return value;
    } else {
        throw new TypeError(
            format('invalid value for "%s": %j', errName, value));
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



//---- exports

module.exports = {
    objCopy: objCopy,
    boolFromString: boolFromString,
    pauseStream: pauseStream
};
