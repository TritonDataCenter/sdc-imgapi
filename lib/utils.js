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
};


/**
 * Convert a boolean or string representation (as in redis or UFDS) into a
 * boolean, or raise TypeError trying.
 *
 * @param value {Boolean|String} The input value to convert.
 * @param default_ {Boolean} The default value is `value` is undefined.
 * @param errName {String} The variable name to quote in the possibly
 *    raised TypeError.
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



//---- exports

module.exports = {
  objCopy: objCopy,
  boolFromString: boolFromString
};
