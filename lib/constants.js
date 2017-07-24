/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/*
 * IMGAPI constants.
 *
 * CLI usage:
 *      $ node lib/constants.js
 *      ... emits all the constants as a JSON object ...
 *      $ node lib/constants.js KEY
 *      ... emits the value of KEY (in json-y form, i.e. quotes removed from a
 *      string) ...
 */


// ---- exports

/*
 * All files written locally by IMGAPI (with the exception of logs) are stored
 * under this dir.
 *
 * For *testing* only, we allow override of this dir. Note that for this to
 * work, it relies on test code using `node lib/constants.js ...` to get
 * this path.
 */
var LOCAL_BASE_DIR = '/data/imgapi';
if (process.env.IMGAPITEST_LOCAL_BASE_DIR) {
    LOCAL_BASE_DIR = process.env.IMGAPITEST_LOCAL_BASE_DIR;
}


module.exports = {
    LOCAL_BASE_DIR: LOCAL_BASE_DIR,

    /*
     * Dir used by the 'local' database backend to store manifests.
     */
    DATABASE_LOCAL_DIR: LOCAL_BASE_DIR + '/manifests',

    MAX_ICON_SIZE: 128*1024, // 128KiB
    MAX_ICON_SIZE_STR: '128 KiB',

    MAX_IMAGE_SIZE: 20*1024*1024*1024, // 20GiB
    MAX_IMAGE_SIZE_STR: '20 GiB',

    /*
     * Dir used by the 'local' storage backend to store images and archive
     * files.
     */
    STORAGE_LOCAL_IMAGES_DIR: LOCAL_BASE_DIR + '/images',
    STORAGE_LOCAL_ARCHIVE_DIR: LOCAL_BASE_DIR + '/archive',

    UNSET_OWNER_UUID: '00000000-0000-0000-0000-000000000000',

    // TODO: should use constant from node-imgmanifest
    VALID_FILE_COMPRESSIONS: ['gzip', 'bzip2', 'xz', 'none'],
    VALID_STORAGES: ['local', 'manta'],

    AUTHKEYS_BASE_DIR: LOCAL_BASE_DIR + '/etc/authkeys'
};


// ---- mainline

function main(argv) {
    var assert = require('assert-plus');
    var dashdash = require('dashdash');

    assert.arrayOfString(argv, 'argv');

    var options = [
        {
            names: ['help', 'h'],
            type: 'bool',
            help: 'Print this help and exit.'
        }
    ];
    var parser = dashdash.createParser({options: options});
    try {
        var opts = parser.parse(argv);
    } catch (e) {
        console.error('lib/constants.js: error: %s', e.message);
        process.exit(1);
    }

    if (opts.help) {
        console.log([
            'usage: node .../lib/constants.js [OPTIONS] [KEY]',
            'options:',
            parser.help().trimRight()
        ].join('\n'));
        process.exit(0);
    }

    var key;
    if (opts._args.length === 1) {
        key = opts._args[0];
    } else if (opts._args.length === 0) {
        key = null;
    } else {
        console.error('lib/constants.js: error: too many args: %s',
            opts._args.join(' '));
        process.exit(1);
    }

    if (key) {
        var val = module.exports[key];
        if (typeof (val) === 'string') {
            console.log(val);
        } else {
            console.log(JSON.stringify(val, null, 4));
        }
    } else {
        console.log(JSON.stringify(module.exports, null, 4));
    }
}

if (require.main === module) {
    main(process.argv);
}
