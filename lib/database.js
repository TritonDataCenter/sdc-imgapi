/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * The IMGAPI database API (and supported implementations). The IMGAPI
 * "database" is the part that stores image manifest data. The (large)
 * image *files* are put in a particular "storage" (e.g. Manta).
 */

var util = require('util'),
    format = util.format;
var path = require('path');
var fs = require('fs');

var assert = require('assert-plus');
var Pool = require('generic-pool').Pool;
var ldap = require('ldapjs'),
    filters = ldap.filters;
var async = require('async');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');

var errors = require('./errors');
var Image = require('./images').Image;
var objCopy = require('./utils').objCopy;




//---- globals

var MANIFEST_FILE_REGEX =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.raw$/;

var SEARCH_TYPE_FROM_FIELD = {
    owner: 'str',
    activated: 'bool',
    disabled: 'bool',
    public: 'bool',
    name: '~str',
    version: 'str',
    os: 'str',
    type: 'str',
    acl: 'array'
};



//---- Database vitual base

/**
 * Create a Database handler.
 *
 * @param app {App}
 * @params config {Object} The 'database' section of the IMGAPI config.
 * @params log {Bunyan Logger}
 */
function Database(config, log) {
    this.type = null;
}

/**
 * Prepare database for usage, if necessary.
 *
 * @param app {App}
 * @param callback {Function} `function (err)`
 */
Database.prototype.setup = function setup(app, callback) {
    callback();
};

/**
 * Get one manifest from the database.
 *
 * @param uuid {String} Image uuid.
 * @param callback {Function} `function (err, items)`
 */
Database.prototype.get = function get(uuid, callback) {};

/**
 * Database search
 *
 * @param ldapFilter {String} LDAP filter string or object for UFDS search.
 * @param callback {Function} `function (err, items)`
 */
Database.prototype.search = function search(ldapFilter, callback) {};

/**
 * Add a manifest to the database.
 *
 * @param uuid {String} Image uuid.
 * @param data {Object}
 * @param callback {Function} `function (err)`
 */
Database.prototype.add = function add(uuid, data, callback) {};

/**
 * Modify a manifest in the database.
 *
 * @param uuid {String} Image uuid.
 * @param changes {Object} The plain JS object describe a change as required
 *      for [ldapjs modify](http://ldapjs.org/client.html#modify). Note that
 *      this must NOT be an actual `ldap.Change` instance to allow non-LDAP
 *      database backends. E.g.:
 *          {
 *            operation: 'add',     // 'add', 'replace' or 'delete'
 *            modification: {
 *              pets: ['cat', 'dog']
 *            }
 *          }
 *      You can pass in a single change object, or an array of them.
 * @param callback {Function} `function (err)`
 */
Database.prototype.modify = function modify(uuid, changes, callback) {};

/**
 * Delete a manifest from the database.
 *
 * @param uuid {String} Image uuid.
 * @param callback {Function} `function (err)`
 */
Database.prototype.del = function del(uuid, callback) {};



//---- 'ufds' Database

function UfdsDatabase(config, log) {
    assert.object(config, 'config');
    assert.string(config.url, 'config.url');
    assert.string(config.rootDn, 'config.rootDn');
    assert.string(config.password, 'config.password');
    assert.object(log, 'log');

    this.type = 'ufds';
    this.log = log.child({component: 'db'}, true);
    this.config = config;

    this.pool = this._createUfdsPool(this.config, this.log);
}
util.inherits(UfdsDatabase, Database);


UfdsDatabase.prototype._createUfdsPool = function _createUfdsPool(config, log) {
    // TODO: reduce this whole pool down to ldapjs-internal pooling
    // or beefed up sdc-clients/ufds.js support.
    var ufdsPoolLog = log.child({'ufdsPool': true}, true);
    return Pool({
        name: 'ufds',
        max: 10,
        idleTimeoutMillis : 30000,
        reapIntervalMillis: 5000,
        create: function createUfdsClient(callback) {
            // TODO: should change to sdc-clients.UFDS at some point.
            var client = ldap.createClient({
                url: config.url,
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
                ufdsPoolLog.debug({rootDn: config.rootDn}, 'bind to UFDS');
                client.bind(config.rootDn, config.password,
                    function (bErr) {
                        if (bErr) {
                            return callback(bErr);
                        }
                        return callback(null, client);
                    }
                );
            });
        },
        destroy: function destroyUfdsClient(client) {
            client.unbind(function () {
                log.debug('unbound from UFDS');
            });
        },
        log: function (msg, level) {
            var fn = {
                //'verbose': ufdsPoolLog.trace,  // disable for prod, too wordy
                'info': ufdsPoolLog.trace,
                'warn': ufdsPoolLog.warn,
                'error': ufdsPoolLog.error
            }[level];
            if (fn) fn.call(ufdsPoolLog, msg);
        }
    });
}


UfdsDatabase.prototype.get = function get(uuid, callback) {
    var log = this.log;
    var pool = this.pool;
    var dn = Image.dn(uuid);
    pool.acquire(function (poolErr, client) {
        if (poolErr) {
            return callback(new errors.ServiceUnavailableError(poolErr,
                'service unavailable'));
        }
        log.trace({dn: dn}, 'ldap get');
        client.search(dn, {scope: 'base'}, function (sErr, result) {
            if (sErr) {
                pool.release(client);
                log.warn(sErr, 'UFDS search error');
                // 503: presuming this is a "can't connect to UFDS" error.
                return callback(new errors.ServiceUnavailableError(sErr,
                    'service unavailable'));
            }

            var items = [];
            result.on('searchEntry', function (entry) {
                items.push(entry.object);
            });

            result.on('error', function (err) {
                pool.release(client);
                if (err instanceof ldap.NoSuchObjectError) {
                    callback(new errors.ResourceNotFoundError(
                        err, 'image not found'));
                } else {
                    callback(err);
                }
            });

            result.on('end', function (res) {
                pool.release(client);
                if (res.status !== 0) {
                    log.error({status: res.status, res: res},
                        'non-zero status from LDAP search');
                    return callback(new errors.InternalError(
                        'error searching database'));
                }
                if (items.length !== 1) {
                    log.error({items: items, dn: dn},
                        'multiple hits in UFDS for one dn');
                    return callback(
                        new errors.InternalError('conflicting items'));
                }
                callback(null, items[0]);
            });
        });
    });
};


UfdsDatabase.prototype.search = function search(options, callback) {
    assert.object(options, 'options');
    assert.func(callback, 'callback');
    var log = this.log;
    log.trace({options: options}, 'UfdsDatabase.search');

    // Build the ldapjs filter.
    var ldapFilter = null;
    var fields = Object.keys(options);
    if (fields.length === 0) {
        ldapFilter = new filters.EqualityFilter(
            {attribute: 'objectclass', value: 'sdcimage'})
    } else {
        ldapFilter = new filters.AndFilter();
        ldapFilter.addFilter(new filters.EqualityFilter(
            {attribute: 'objectclass', value: 'sdcimage'}));
        for (var i = 0; i < fields.length; i++) {
            var field = fields[i];
            var value = options[field];
            if (value === undefined)
                continue;
            switch (SEARCH_TYPE_FROM_FIELD[field]) {
            case 'str':
            case 'array':
                ldapFilter.addFilter(new filters.EqualityFilter(
                    {attribute: field, value: value}));
                break;
            case 'bool':
                ldapFilter.addFilter(new filters.EqualityFilter(
                    {attribute: field, value: value.toString()}));
                break;
            case '~str':
                if (value[0] === '~') {
                    ldapFilter.addFilter(new filters.SubstringFilter(
                        {attribute: field, initial: '',
                         any: [value.slice(1)]}));
                } else {
                    ldapFilter.addFilter(new filters.EqualityFilter(
                        {attribute: field, value: value}));
                }
                break;
            default:
                throw new TypeError(format('unknown filter field type: "%s"',
                    SEARCH_TYPE_FROM_FIELD[field]));
            }
        }
    }

    // Do the search.
    var pool = this.pool;
    var base = 'ou=images, o=smartdc';
    var opts = {
        filter: ldapFilter,
        scope: 'one'
    };
    pool.acquire(function (poolErr, client) {
        if (poolErr) {
            return callback(new errors.ServiceUnavailableError(poolErr,
                'service unavailable'));
        }
        log.trace({filter: opts.filter}, 'ldap search');
        client.search(base, opts, function (sErr, result) {
            if (sErr) {
                pool.release(client);
                log.warn(sErr, 'UFDS search error');
                // 503: presuming this is a "can't connect to UFDS" error.
                return callback(new errors.ServiceUnavailableError(sErr,
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
                    return callback(new errors.InternalError(
                        'non-zero status from LDAP search: ' + res));
                }
                callback(null, items);
            });
        });
    });
};

UfdsDatabase.prototype.add = function add(uuid, data, callback) {
    var log = this.log;
    var pool = this.pool;
    var dn = Image.dn(uuid);
    pool.acquire(function (poolErr, client) {
        if (poolErr) {
            return callback(new errors.ServiceUnavailableError(poolErr,
                'service unavailable'));
        }
        try {
            client.add(dn, data, function (addErr) {
                pool.release(client);
                if (addErr) {
                    return callback(new errors.InternalError(addErr,
                        'error saving: ' + addErr));
                }
                callback();
            });
        } catch (ex) {
            callback(new errors.InternalError(ex, 'error saving'));
        }
    });
};

UfdsDatabase.prototype.modify = function modify(uuid, changes, callback) {
    var log = this.log;
    var pool = this.pool;
    var dn = Image.dn(uuid);
    pool.acquire(function (poolErr, client) {
        if (poolErr) {
            return callback(new errors.ServiceUnavailableError(poolErr,
                'service unavailable'));
        }
        client.modify(dn, changes, function (modErr) {
            pool.release(client);
            if (modErr) {
                return callback(modErr);
            }
            callback();
        });
    });
};

UfdsDatabase.prototype.del = function del(uuid, callback) {
    var log = this.log;
    var pool = this.pool;
    var dn = Image.dn(uuid);
    pool.acquire(function (poolErr, client) {
        if (poolErr) {
            return callback(new errors.ServiceUnavailableError(poolErr,
                'service unavailable'));
        }
        client.del(dn, function (delErr) {
            pool.release(client);
            if (delErr) {
                if (delErr instanceof ldap.NoSuchObjectError) {
                    callback(new errors.ResourceNotFoundError(
                        'image not found'));
                } else {
                    callback(new errors.InternalError(delErr,
                        'could not delete item'));
                }
            } else {
                callback();
            }
        });
    });
};



//---- 'local' Database
// This is a quick impl that (currently) does no indexing. All manifest data
// is stored in memory. Therefore this is only appropriate for small numbers
// of images (e.g. dev, testing and limited IMGAPI deployments).

function LocalDatabase(config, log) {
    assert.object(config, 'config');
    assert.string(config.dir, 'config.dir');
    assert.object(log, 'log');

    this.type = 'local';
    this.log = log.child({component: 'db'}, true);
    this.dir = config.dir;
}
util.inherits(LocalDatabase, Database);

LocalDatabase.prototype.setup = function setup(app, callback) {
    assert.object(app, 'app');
    assert.func(callback, 'callback');
    var self = this;

    // Assumption for now: it is writable for us.
    this.log.info('mkdir -p %s', this.dir);
    mkdirp(this.dir, function (dirErr) {
        if (dirErr) {
            return callback(dirErr)
        }
        self._reload(app, callback);
    });
};


/**
 * Reload database from manifest files.
 *
 * @param app {App}
 * @param callback {Function} `function (err)`
 */
LocalDatabase.prototype._reload = function _reload(app, callback) {
    assert.func(callback, 'callback');
    var self = this;
    var log = this.log;

    this.manifests = []
    this.manifestFromUuid = {};

    fs.readdir(this.dir, function (dirErr, filenames) {
        if (dirErr) {
            return callback(dirErr);
        }

        var raw;
        filenames.sort();  // Consistent order helps testability.
        log.info('reloading %d raw manifest files', filenames.length);
        async.forEachSeries(filenames,
            function oneFile(filename, next) {
                if (! MANIFEST_FILE_REGEX.test(filename)) {
                    log.warn('"%s" file does not belong in db dir', filename);
                    return next();
                }
                var uuid = filename.slice(0, filename.lastIndexOf('.'));
                var filepath = path.join(self.dir, filename);
                log.trace({filepath: filepath}, 'load manifest file');
                fs.readFile(filepath, 'utf8', function (err, content) {
                    if (err) return next(err);
                    try {
                        raw = JSON.parse(content);
                    } catch (syntaxErr) {
                        log.warn(syntaxErr, 'could not parse "%s" in database',
                            filepath);
                        return next();
                    }
                    if (raw.uuid !== uuid) {
                        log.warn('filename "%s" uuid does not match '
                            + 'content uuid, "%s"', uuid, raw.uuid);
                        return next();
                    }
                    try {
                        Image.validate(app, raw);
                    } catch (validErr) {
                        log.warn(validErr, 'invalid manifest "%s" in database',
                            filepath);
                        return next();
                    }
                    self.manifests.push(raw);
                    self.manifestFromUuid[uuid] = raw;
                    next();
                });
            },
            callback
        );
    });
}


/**
 * Add/update the given raw manifest to the indeces.
 */
LocalDatabase.prototype._addManifest = function _addManifest(raw) {
    var existing = this.manifestFromUuid[raw.uuid];
    if (existing === undefined) {
        this.manifests.push(raw);
    } else {
        for (var i = 0; i < this.manifests.length; i++) {
            if (this.manifests[i].uuid === raw.uuid) {
                this.manifests[i] = raw;
                break;
            }
        }
    }
    this.manifestFromUuid[raw.uuid] = raw;
}

/**
 * Write raw manifest to disk, then call `_addManifest` to add it to the
 * in-memory database.
 */
LocalDatabase.prototype._writeManifest = function (manifest, callback) {
    var self = this;
    var manifestPath = path.join(this.dir, manifest.uuid + '.raw');
    var serialized = JSON.stringify(manifest, null, 2);
    fs.writeFile(manifestPath, serialized, 'utf8', function (err) {
        if (err) {
            return callback(err);
        }
        self._addManifest(manifest);
        callback();
    });
}


LocalDatabase.prototype.get = function get(uuid, callback) {
    var log = this.log;
    log.trace({uuid: uuid}, 'LocalDatabase.get');
    assert.string(uuid, 'uuid');
    assert.func(callback, 'callback');

    var manifest = this.manifestFromUuid[uuid];
    if (manifest === undefined) {
        return callback(new errors.ResourceNotFoundError('image not found'));
    }
    callback(null, manifest);
};


LocalDatabase.prototype.search = function search(options, callback) {
    assert.object(options, 'options');
    assert.func(callback, 'callback');
    var log = this.log;
    log.trace({options: options}, 'LocalDatabase.search');

    // Normalize bools in the filter options for comparison below.
    var rawOptions = objCopy(options);
    Object.keys(SEARCH_TYPE_FROM_FIELD).forEach(function (field) {
        if (SEARCH_TYPE_FROM_FIELD[field] === 'bool' &&
            rawOptions[field] !== undefined) {
            rawOptions[field] = String(rawOptions[field]);
        }
    })

    var hits = [];
    var fields = Object.keys(rawOptions)
        .filter(function (f) { return rawOptions[f] !== undefined });
    var nFields = fields.length;
    var manifests = this.manifests;
    var nManifests = manifests.length;

    // Note: We could be a lot smarter here with caching if necessary.
    for (var m = 0; m < nManifests; m++) {
        var manifest = manifests[m];
        var match = true;
        //console.log('-- search: manifest %s (%s)', manifest.uuid, manifest.name);
        //console.log('manifest:', manifest)
        for (var f = 0; f < nFields; f++) {
            var field = fields[f];
            var type = SEARCH_TYPE_FROM_FIELD[field];
            if (type === '~str' && rawOptions[field][0] === '~') {
                var substr = rawOptions[field].slice(1);
                if (manifest[field].indexOf(substr) === -1) {
                    match = false;
                    break;
                }
            } else if (type === '~str' || type === 'str' || type === 'bool') {
                if (String(manifest[field]) !== rawOptions[field]) {
                    //console.log("    field %s: %s (%s) !== %s (%s)", field,
                    //    manifest[field], typeof(manifest[field]),
                    //    rawOptions[field], typeof(rawOptions[field]))
                    match = false;
                    break;
                }
            } else if (type === 'array') {
                if (manifest[field].indexOf(rawOptions[field]) === -1) {
                    //console.log("    field %s: %s not in %j", field,
                    //    rawOptions[field], manifest[field]);
                    match = false;
                    break;
                }
            } else {
                throw TypeError(format(
                    'unknown filter field type: "%s"', type));
            }
        }
        if (match)
            hits.push(manifest);
    }

    callback(null, hits);
};


LocalDatabase.prototype.add = function add(uuid, raw, callback) {
    var log = this.log;
    assert.string(uuid, 'uuid');
    assert.object(raw, 'raw');
    assert.func(callback, 'callback');

    log.trace({uuid: uuid, raw: raw}, 'LocalDatabase.add');
    this._writeManifest(raw, callback);
};


LocalDatabase.prototype.modify = function modify(uuid, changes, callback) {
    var log = this.log;
    log.trace({uuid: uuid, changes: changes}, 'LocalDatabase.modify');
    assert.string(uuid, 'uuid');
    if (!Array.isArray(changes)) {
        changes = [changes];
    }
    assert.arrayOfObject(changes, 'changes');
    assert.func(callback, 'callback');

    // Ensure this image manifest exists.
    var manifest = this.manifestFromUuid[uuid];
    if (manifest === undefined) {
        return callback(new errors.ResourceNotFoundError('image not found'));
    }

    // Make the changes.
    // Note: This all goes wrong if there is a modification to 'uuid'. :)
    for (var i = 0; i < changes.length; i++) {
        var change = changes[i];
        var op = change.operation;
        if (op === 'add' || op === 'replace') {
            Object.keys(change.modification).forEach(function (field) {
                var value = change.modification[field];
                // TODO: error out if field already exists for 'add', a la LDAP?
                // Serialize as LDAP does.
                manifest[field] = (Array.isArray(value)
                    ? value : String(value));
            });
        } else if (op === 'delete') {
            Object.keys(change.modification).forEach(function (field) {
                delete manifest[field];
            });
        }
    }

    // Resave.
    this._writeManifest(manifest, callback);
};


LocalDatabase.prototype.del = function del(uuid, callback) {
    var log = this.log;
    log.trace({uuid: uuid}, 'LocalDatabase.del');
    assert.string(uuid, 'uuid');
    assert.func(callback, 'callback');

    var manifest = this.manifestFromUuid[uuid];
    if (manifest === undefined) {
        return callback(new errors.ResourceNotFoundError('image not found'));
    }

    delete this.manifestFromUuid[uuid];
    this.manifests = this.manifests.filter(
        function (i) { return i.uuid !== uuid; });
    var manifestPath = path.join(this.dir, uuid + '.raw');
    rimraf(manifestPath, callback);
};



//---- exports

module.exports = {
    ufds: UfdsDatabase,
    local: LocalDatabase
};
