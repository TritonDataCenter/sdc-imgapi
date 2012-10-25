/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Helpers for modeling data in UFDS, i.e. handling list/get/create/delete.
 * (Based on same file from amon.git.)
 *
 * In all the functions below `Model` is expected to be a model constructor
 * function with the following interface (see comments in the model
 * implementations for details):
 *
 *       function Foo(app, data) {...}
 *       Foo.create = function (app, data, callback) {...}
 *       Foo.objectclass = "sdcfoo";
 *       Foo.validate = function (raw) {...}
 *       Foo.dnFromRequest = function (req) {...}
 *       Foo.parentDnFromRequest = function (req) {...}
 *       Foo.prototype.serialize = function () {...}    # output JSON
 *       Foo.prototype.authorizeWrite = function (app, callback)
 *       Foo.prototype.authorizeDelete = function (app, callback)
 *       <instance>.raw         # the raw UFDS data
 *       <instance>.dn          # the UFDS DN for this object
 */

var debug = console.warn;

var assert = require('assert-plus');
var uuid = require('node-uuid');
var ldap = require('ldapjs');
var restify = require('restify');
var errors = require('./errors');



//---- generic list/create/get/delete model helpers

/**
 * Get a list of `Model` instances under the given `parentDn`.
 *
 * @param app {App} The IMGAPI app.
 * @param Model {object} The Model "class" object.
 * @param parentDn {object} Parent LDAP DN (distinguished name).
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err, items)` where `err` is a
 *      restify.RestError instance on error, otherwise `items` is an array of
 *      Model instances.
 */
function modelList(app, Model, parentDn, log, callback) {
    log.info({parentDn: parentDn}, 'modelList');

    // Check cache. "cached" is `{err: <error>, data: <data>}`.
    var cacheScope = Model.name + 'List';
    // XXX:TODO: this cacheKey needs to be based on input filter params
    var cacheKey = parentDn;
    var cached = app.cacheGet(cacheScope, cacheKey);
    if (cached) {
        log.trace('<%s> modelList: parentDn=\'%s\': cache hit: %s', Model.name,
            parentDn, cached);
        if (cached.err) {
            return callback(cached.err);
        }
        try {
            var items = cached.data.map(
                function (d) { return new Model(app, d); });
            return callback(null, items);
        } catch (e) {
            // Drop from the cache and carry on.
            log.warn('error in cached data (cacheScope=\'%s\', '
                + 'cacheKey=\'%s\'): %s', cacheScope, cacheKey, e);
            app.cacheDel(cacheScope, cacheKey);
        }
    }

    function cacheAndCallback(cErr, cItems) {
        var data = cItems && cItems.map(function (i) { return i.raw; });
        app.cacheSet(cacheScope, cacheKey, {err: cErr, data: data});
        callback(cErr, cItems);
    }

    var opts = {
        filter: '(objectclass=' + Model.objectclass + ')',
        scope: 'one'
    };
    log.trace({searchOpts: opts},
        '<%s> modelList: ufds search: parentDn=\'%s\'', Model.name, parentDn);
    app.ufdsSearch(parentDn, opts, function (err, rawItems) {
        if (err) {
            if (err.httpCode === 503) {
                return callback(err);  // don't cache 503
            } else {
                return cacheAndCallback(err);
            }
        }
        var instances = [];
        for (var i = 0; i < rawItems.length; i++) {
            try {
                instances.push(new Model(app, rawItems[i]));
            } catch (err2) {
                if (err2 instanceof restify.RestError) {
                    log.warn('Ignoring invalid %s (dn=\'%s\'): %s', Model.name,
                        rawItems[i].dn, err2);
                } else {
                    log.error(err2, 'Unknown error with %s entry:', Model.name,
                        rawItems[i]);
                }
            }
        }
        log.trace('%s instances:', Model.name, instances);
        cacheAndCallback(null, instances);
    });
}


/**
 * Create an instance of this model.
 *
 * @param app {App} The IMGAPI app.
 * @param Model {object} The Model "class" object.
 * @param data {object} The model instance data.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err, item)` where `err` is a
 *      restify.RestError instance on error, otherwise `item` is the created
 *      Model instance.
 */
function modelCreate(app, Model, data, log, callback) {
    log.info({data: data, modelName: Model.name}, 'modelCreate');

    // 1. Create the object (this handles validation).
    Model.create(app, data, function (cErr, item) {
        if (cErr) {
            return callback(cErr); //XXX wrap this error?
        }

        // 2. Access control check.
        item.authorizeWrite(app, function (err) {
            if (err) {
                log.debug({err: err, modelName: Model.name, dn: item.dn},
                    'authorizeWrite err');
                return callback(err);
            }
            log.debug({modelName: Model.name, dn: item.dn},
                'authorizeWrite: authorized');

            // 3. Add it.
            var dn = item.dn;
            app.ufdsAdd(dn, item.raw, function (addErr) {
                if (addErr) {
                    log.error(addErr, 'Error saving to UFDS (dn="%s")', dn);
                    callback(addErr);
                } else {
                    log.trace('<%s> create item:', Model.name, item);
                    app.cacheInvalidateWrite(Model.name, item);
                    callback(null, item);
                }
            });
        });
    });
}


/**
 * Put an instance of this model to the db.
 *
 * @param app {App} The IMGAPI app.
 * @param Model {object} The Model "class" object.
 * @param rawData {object} The model instance data in "raw" db form.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err, item)` where `err` is a
 *      restify.RestError instance on error, otherwise `item` is the put Model
 *      instance.
function modelPut(app, Model, rawData, log, callback) {
    log.info({rawData: rawData, modelName: Model.name}, 'modelPut');

    var item;
    try {
        item = new Model(app, rawData);
    } catch (e) {
        return callback(e);
    }

    // Access control check.
    item.authorizeWrite(app, function (err) {
        if (err) {
            log.debug({err: err, modelName: Model.name, dn: item.dn},
                'authorizeWrite err');
            return callback(err);
        }
        log.debug({modelName: Model.name, dn: item.dn},
            'authorizeWrite: authorized');

        // Add it.
        var dn = item.dn;
        app.ufdsAdd(dn, item.raw, function (addErr) {
            if (addErr) {
                log.error(addErr, 'Error saving to UFDS (dn="%s")', dn);
                callback(addErr);
            } else {
                log.trace('<%s> put item:', Model.name, item);
                app.cacheInvalidateWrite(Model.name, item);
                callback(null, item);
            }
        });
    });
}
*/

/**
 * Update the given model instance.
 *
 * @param app {App}
 * @param instance {Model} An instance of the model.
 * @param changes {Object|Array} An array of or a single LDAP change as per
 *      <http://ldapjs.org/client.html#modify>
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err)`
 */
function modelUpdate(app, instance, changes, log, callback) {
    assert.object(app, 'app');
    assert.object(instance, 'instance');
    assert.object(changes, 'changes');
    assert.object(log, 'log');
    assert.func(callback, 'callback');

    var dn = instance.dn;
    log.info({dn: dn, changes: changes}, 'modelUpdate');
    app.ufdsModify(dn, changes, function (err) {
        if (err) {
            log.error({err: err, dn: dn}, 'error updating model');
            callback(err);
        } else {
            log.trace({dn: dn, modelName: instance.constructor.name},
                'updated item');
            app.cacheInvalidateWrite(instance.constructor.name, instance);
            callback();
        }
    });
}


/**
 * Get an instance of `Model` with the given `dn`.
 *
 * @param app {App} The IMGAPI app.
 * @param Model {object} The Model "class" object.
 * @param dn {object} The LDAP dn (distinguished name).
 * @param log {Bunyan Logger}
 * @param skipCache {Boolean} Optional. Default false. Set to true to skip
 *      looking up in the cache.
 * @param callback {Function} `function (err, item)` where `err` is a
 *      restify.RestError instance on error, otherwise `item` is the Model
 *      instance.
 */
function modelGet(app, Model, dn, log, skipCache, callback) {
    log.info({dn: dn, modelName: Model.name}, 'modelGet');

    if (callback === undefined) {
        callback = skipCache;
        skipCache = false;
    }

    // Check cache. "cached" is `{err: <error>, data: <data>}`.
    if (!skipCache) {
        var cacheScope = Model.name + 'Get';
        var cached = app.cacheGet(cacheScope, dn);
        if (cached) {
            if (cached.err) {
                return callback(cached.err);
            } else {
                try {
                    return callback(null, new Model(app, cached.data));
                } catch (e) {
                    // Drop from the cache and carry on.
                    log.warn(e,
                        'error in cached data (cacheScope="%s", dn="%s")',
                        cacheScope, dn);
                    app.cacheDel(cacheScope, dn);
                }
            }
        }
    }

    function cacheAndCallback(err, item) {
        if (!skipCache) {
            app.cacheSet(cacheScope, dn, {err: err, data: item && item.raw});
        }
        callback(err, item);
    }

    var opts = {scope: 'base'};
    app.ufdsSearch(dn, opts, function (err, entries) {
        if (err) {
            if (err.httpCode === 503) {
                return callback(err);  // don't cache 503
            } else if (err instanceof ldap.NoSuchObjectError) {
                return cacheAndCallback(new errors.ResourceNotFoundError(
                    '%s not found', Model.name.toLowerCase()));
            } else {
                return cacheAndCallback(err);
            }
        }
        if (entries.length === 1) {
            var entry = entries[0];
            try {
                var item = new Model(app, entry);
            } catch (err2) {
                log.warn({err: err2, entry: entry, model: Model.name},
                    'invalid entry');
                return callback(new errors.ResourceNotFoundError('not found'));
            }
            return cacheAndCallback(null, item);
        } else {
            log.error({entries: entries, dn: dn},
                'multiple hits in UFDS for one dn');
            return callback(new errors.InternalError('conflicting entries'));
        }
    });
}


/**
 * Delete a `Model` with the given `dn`.
 *
 * @param app {App} The IMGAPI app.
 * @param Model {object} The Model "class" object.
 * @param dn {object} The LDAP dn (distinguished name).
 * @param log {Bunyan Logger}
 * @param skipCache {Boolean} Optional. Default false. Set to true to skip
 *      looking up in the cache.
 * @param callback {Function} `function (err)` where `err` is a
 *      restify.RestError instance on error.
 */
function modelDelete(app, Model, dn, log, callback) {
    log.info({dn: dn, modelName: Model.name}, 'modelDelete');
    //TODO: could validate the 'dn'

    // We need to first get the item (we'll need it for proper cache
    // invalidation).
    modelGet(app, Model, dn, log, true, function (getErr, item) {
        if (getErr) {
            return callback(getErr);
        }
        app.ufdsDelete(dn, function (delErr) {
            if (delErr) {
                callback(delErr);
            } else {
                app.cacheInvalidateDelete(Model.name, item);
                callback();
            }
        });
    });
}



//---- request/response wrappers around the above helpers

function requestList(req, res, next, Model) {
    req.log.trace({params: req.params}, '<%s> list entered', Model.name);
    var parentDn = Model.parentDnFromRequest(req);
    modelList(req._app, Model, parentDn, req.log, function (err, items) {
        if (err) {
            next(err);
        } else {
            var data = items.map(function (i) { return i.serialize(); });
            req.log.trace({data: data}, 'items from modelList:', items);
            res.send(data);
            next();
        }
    });
}


function requestCreate(req, res, next, Model) {
    req.log.trace({params: req.params, body: req.body},
        '<%s> create entered', Model.name);

    // Note this means that the *route variable names* need to match the
    // expected `data` key names in the models (e.g. `probes.Probe`).
    var data = {};
    Object.keys(req.params).forEach(function (k) {
        data[k] = req.params[k];
    });
    if (req.body) {
        Object.keys(req.body).forEach(function (k) {
            data[k] = req.body[k];
        });
    }

    modelCreate(req._app, Model, data, req.log, function (err, item) {
        if (err) {
            next(err);
        } else {
            var d = item.serialize();
            req.log.trace({data: d}, 'item from modelCreate:', item);
            res.send(d);
            next();
        }
    });
}


/* XXX consider s/Create/Put/
function requestPut(req, res, next, Model) {
    req.log.trace({params: req.params, body: req.body},
        '<%s> put entered', Model.name);

    // Note this means that the *route variable names* need to match the
    // expected `data` key names in the models (e.g. `monitors.Monitor`).
    var data = {};
    Object.keys(req.params).forEach(function (k) {
        data[k] = req.params[k];
    });
    if (req.body) {
        Object.keys(req.body).forEach(function (k) {
            data[k] = req.body[k];
        });
    }

    modelPut(req._app, Model, data, req.log, function (err, item) {
        if (err) {
            next(err);
        } else {
            var d = item.serialize();
            req.log.trace({data: d}, 'item from modelPut:', item);
            res.send(d);
            next();
        }
    });
}
*/


function requestGet(req, res, next, Model) {
    req.log.trace({params: req.params}, '<%s> get entered', Model.name);
    var dn;
    try {
        dn = Model.dnFromRequest(req);
    } catch (err) {
        return next(err);
    }

    modelGet(req._app, Model, dn, req.log, function (err, item) {
        if (err) {
            next(err);
        } else {
            var data = item.serialize();
            req.log.trace({data: data}, 'item from modelGet:', item);
            res.send(data);
            next();
        }
    });
}


function requestDelete(req, res, next, Model) {
    req.log.trace({params: req.params}, '<%s> delete entered', Model.name);
    var dn = Model.dnFromRequest(req);
    modelDelete(req._app, Model, dn, req.log, function (err) {
        if (err) {
            next(err);
        } else {
            res.send(204);
            return next();
        }
    });
}



//---- exports

module.exports = {
    modelList: modelList,
    modelCreate: modelCreate,
    //modelPut: modelPut,
    modelUpdate: modelUpdate,
    modelGet: modelGet,
    modelDelete: modelDelete,
    requestList: requestList,
    requestCreate: requestCreate,
    //requestPut: requestPut,
    requestGet: requestGet,
    requestDelete: requestDelete
};
