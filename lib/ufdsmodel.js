/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Helpers for modeling data in UFDS, i.e. handling list/get/create/delete.
 * (Originally from amon.git.)
 *
 * In all the functions below `Model` is expected to be a model constructor
 * function with the following interface (see comments in the model
 * implementations for details):
 *
 *       function Foo(app, data) {...}
 *       Foo.create = function (app, data, callback) {...}
 *       Foo.objectclass = "amonfoo";
 *       Foo.validate = function (raw) {...}
 *       Foo.dnFromRequest = function (req) {...}
 *       Foo.parentDnFromRequest = function (req) {...}
 *       Foo.prototype.serialize = function () {...}    # output JSON
 *       Foo.prototype.authorizeWrite = function (app, callback)
 *       Foo.prototype.authorizeDelete = function (app, callback)
 *       <instance>.raw         # the raw UFDS data
 *       <instance>.dn          s# the UFDS DN for this object
 */

var debug = console.warn;

var uuid = require('node-uuid');
var ldap = require('ldapjs');
var restify = require('restify');



//---- generic list/create/get/delete model helpers

/**
 * Get a list of `Model` instances under the given `parentDn`.
 *
 * @param app {App} The Amon Master app.
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
 * @param app {App} The Amon Master app.
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
 * Put (create or update) an instance of this model.
 *
 * @param app {App} The Amon Master app.
 * @param Model {object} The Model "class" object.
 * @param data {object} The model instance data.
 * @param log {Bunyan Logger}
 * @param callback {Function} `function (err, item)` where `err` is a
 *      restify.RestError instance on error, otherwise `item` is the put Model
 *      instance.
 */
function modelPut(app, Model, data, log, callback) {
    log.info({data: data, modelName: Model.name}, 'modelPut');

    var item;
    try {
        item = new Model(app, data);
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
                log.trace('<%s> create item:', Model.name, item);
                app.cacheInvalidatePut(Model.name, item);
                callback(null, item);
            }
        });
    });
}


/**
 * Get an instance of `Model` with the given `dn`.
 *
 * @param app {App} The Amon Master app.
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
                return cacheAndCallback(
                    new restify.ResourceNotFoundError('not found'));
            } else {
                return cacheAndCallback(err);
            }
        }
        if (entries.length === 1) {
            var entry = entries[0];
            try {
                var item = new Model(app, entry);
            } catch (err2) {
                if (err2 instanceof restify.RestError) {
                    log.warn('Ignoring invalid %s (dn=\'%s\'): %s', Model.name,
                        entry.dn, err2);
                } else {
                    log.error(err2, 'Unknown error with %s entry:', Model.name,
                        entry);
                }
                return callback(new restify.InternalError('invalid entry'));
            }
            return cacheAndCallback(null, item);
        } else {
            log.error({entries: entries, dn: dn},
                'multiple hits in UFDS for one dn');
            return callback(new restify.InternalError('conflicting entries'));
        }
    });
}


/**
 * Delete a `Model` with the given `dn`.
 *
 * @param app {App} The Amon Master app.
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


function requestPut(req, res, next, Model) {
    req.log.trace({params: req.params, body: req.body},
        '<%s> put entered', Model.name);

    // Note this means that the *route variable names* need to match the
    // expected `data` key names in the models (e.g. `monitors.Monitor`).
    var data = {};
    Object.keys(req.params).forEach(function (k) {
        data[k] = req.params[k];
    });
    Object.keys(req.body).forEach(function (k) {
        data[k] = req.body[k];
    });
    data.user = req._user.uuid;

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
    modelPut: modelPut,
    modelGet: modelGet,
    modelDelete: modelDelete,
    requestList: requestList,
    requestCreate: requestCreate,
    requestPut: requestPut,
    requestGet: requestGet,
    requestDelete: requestDelete
};
