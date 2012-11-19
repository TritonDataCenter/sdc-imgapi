/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * The IMGAPI database API (and supported implementations). The IMGAPI
 * "database" is the part that stores image manifest data. The (large)
 * image *files* are put in a particular "storage" (e.g. Manta).
 */

var util = require('util'),
    format = util.format;

var assert = require('assert-plus');
var Pool = require('generic-pool').Pool;
var ldap = require('ldapjs');

var errors = require('./errors');




//---- globals



//---- Database vitual base

/**
 * Create a Database handler.
 *
 * @params config {Object} The 'database' section of the IMGAPI config.
 * @params log {Bunyan Logger}
 */
function Database(config, log) {
    this.type = null;
}

/**
 * Prepare database for usage, if necessary.
 *
 * @param callback {Function} `function (err)`
 */
Database.prototype.setup = function setup(callback) {
    callback();
};

/**
 * Get one manifest from the database.
 *
 * @param dn {String} Manifest dn.
 * @param callback {Function} `function (err, items)`
 */
Database.prototype.get = function get(dn, callback) {};

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
 * @param dn {String}
 * @param data {Object}
 * @param callback {Function} `function (err)`
 */
Database.prototype.add = function add(dn, data, callback) {};

/**
 * Modify a manifest in the database.
 *
 * @param dn {String}
 * @param changes {Object} As required for [ldapjs
 *      modify](http://ldapjs.org/client.html#modify)
 * @param callback {Function} `function (err)`
 */
Database.prototype.modify = function modify(dn, changes, callback) {};

/**
 * Delete a manifest from the database.
 *
 * @param dn {String}
 * @param callback {Function} `function (err)`
 */
Database.prototype.del = function del(dn, callback) {};



//---- 'ufds' Database

function UfdsDatabase(config, log) {
    assert.object(config, 'config');
    assert.string(config.url, 'config.url');
    assert.string(config.rootDn, 'config.rootDn');
    assert.string(config.password, 'config.password');
    assert.object(log, 'log');

    this.type = 'ufds';
    this.log = log.child({db: true}, true);
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


UfdsDatabase.prototype.get = function get(dn, callback) {
    var log = this.log;
    var pool = this.pool;
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
                return callback(err);
            });

            result.on('end', function (res) {
                pool.release(client);
                if (res.status !== 0) {
                    return callback(new errors.InternalError(
                        'non-zero status from LDAP search: ' + res));
                }
                if (items.length === 1) {
                    return callback(null, items[0]);
                } else {
                    log.error({items: items, dn: dn},
                        'multiple hits in UFDS for one dn');
                    return callback(new errors.InternalError('conflicting items'));
                }

            });
        });
    });
};


UfdsDatabase.prototype.search = function search(ldapFilter, callback) {
    var log = this.log;
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

UfdsDatabase.prototype.add = function add(dn, data, callback) {
    var log = this.log;
    var pool = this.pool;
    pool.acquire(function (poolErr, client) {
        if (poolErr) {
            return callback(new errors.ServiceUnavailableError(poolErr,
                'service unavailable'));
        }
        try {
            client.add(dn, data, function (addErr) {
                pool.release(client);
                if (addErr) {
                    if (addErr instanceof ldap.EntryAlreadyExistsError) {
                        return callback(new errors.InternalError(
                            'XXX DN "'+dn+'" already exists. Can\'t nicely update '
                            + '(with LDAP modify/replace) until '
                            + '<https://github.com/mcavage/node-ldapjs/issues/31> '
                            + 'is fixed.'));
                        //XXX Also not sure if there is another bug in node-ldapjs
                        //    if "objectclass" is specified in here. Guessing
                        //    it is same bug.
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
        } catch (ex) {
            callback(new errors.InternalError(ex, 'error saving'));
        }
    });
};

UfdsDatabase.prototype.modify = function modify(dn, changes, callback) {
    var log = this.log;
    var pool = this.pool;
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

UfdsDatabase.prototype.del = function del(dn, callback) {
    var log = this.log;
    var pool = this.pool;
    pool.acquire(function (poolErr, client) {
        if (poolErr) {
            return callback(new errors.ServiceUnavailableError(poolErr,
                'service unavailable'));
        }
        client.del(dn, function (delErr) {
            pool.release(client);
            if (delErr) {
                if (delErr instanceof ldap.NoSuchObjectError) {
                    callback(new errors.ResourceNotFoundError());
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
    assert.object(config.dir, 'config.dir');
    assert.object(log, 'log');

    this.type = 'local';
    this.log = log.child({db: true}, true);
    this.config = config;
}
util.inherits(LocalDatabase, Database);

LocalDatabase.prototype.setup = function setup(callback) {
    //XXX
    callback()
};

LocalDatabase.prototype.get = function get(dn, callback) {};

LocalDatabase.prototype.search = function search(ldapFilter, callback) {};

LocalDatabase.prototype.add = function add(dn, data, callback) {};

LocalDatabase.prototype.modify = function modify(dn, changes, callback) {};

LocalDatabase.prototype.del = function del(dn, callback) {};



//---- exports

module.exports = {
    ufds: UfdsDatabase,
    local: LocalDatabase
};
