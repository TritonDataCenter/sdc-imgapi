/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Note: This was copied from smartos-live.git:src/img/lib/magic.js. Ideally
 * it should be in a separate node module.
 *
 * Magic number sniffing of compression type of files.
 */

var assert = require('assert-plus');
var format = require('util').format;
var fs = require('fs');



// ---- compression type sniffing

var magicNumbers = {
    // <compression type> : <magic number>
    bzip2: new Buffer([0x42, 0x5A, 0x68]),
    gzip:  new Buffer([0x1F, 0x8B, 0x08]),
    xz:    new Buffer([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00])
};
var maxMagicLen = 0;
Object.keys(magicNumbers).forEach(function (type) {
    maxMagicLen = Math.max(maxMagicLen, magicNumbers[type].length);
});

function bufNEquals(a, b, n) {
    assert.ok(a.length >= n, format(
        'buffer "a" length (%d) is shorter than "n" (%d)', a.length, n));
    assert.ok(b.length >= n, format(
        'buffer "b" length (%d) is shorter than "n" (%d)', b.length, n));

    for (var i = 0; i < n; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

function compressionTypeFromBufSync(buf) {
    var types = Object.keys(magicNumbers);
    for (var i = 0; i < types.length; i++) {
        var type = types[i];
        var magic = magicNumbers[type];
        if (bufNEquals(buf, magic, magic.length)) {
            return type;
        }
    }
    return null;
}

function compressionTypeFromPath(path, cb) {
    fs.open(path, 'r', function (oErr, fd) {
        if (oErr) {
            cb(oErr);
            return;
        }
        var buf = new Buffer(maxMagicLen);
        fs.read(fd, buf, 0, buf.length, 0, function (rErr, bytesRead, buffer) {
            if (rErr) {
                cb(rErr);
                return;
            }
            fs.close(fd, function (cErr) {
                if (cErr) {
                    cb(cErr);
                    return;
                }
                cb(null, compressionTypeFromBufSync(buf));
            });
        });
    });
}


// ---- exports

module.exports = {
    maxMagicLen: maxMagicLen,  // Min number of bytes needed for detection.
    compressionTypeFromBufSync: compressionTypeFromBufSync,
    compressionTypeFromPath: compressionTypeFromPath
};
