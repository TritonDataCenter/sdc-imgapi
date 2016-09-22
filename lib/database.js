/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * The IMGAPI database API (and supported implementations). The IMGAPI
 * "database" is the part that stores image manifest data. The (large)
 * image *files* are put in a particular "storage" (e.g. Manta).
 */

var p = console.log;
var util = require('util'),
    format = util.format;
var path = require('path');
var fs = require('fs');

var assert = require('assert-plus');
var filters = require('ldapjs').filters;
var async = require('async');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');

var errors = require('./errors');
var Image = require('./images').Image;
var objCopy = require('./utils').objCopy;




//---- globals

var MANIFEST_FILE_REGEX =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.raw$/;

// Note: These types should be kept in sync with
// `images.filter.supportedFields`.
//
// *WARNING*: To add a new '~str' it must be a field name that is indexed in
// UFDS (per the UFDS config.json).
var SEARCH_TYPE_FROM_FIELD = {
    owner: 'str',
    state: 'str',
    activated: 'bool',
    disabled: 'bool',
    public: 'bool',
    name: '~str',
    version: '~str',
    origin: 'str',
    os: 'str',
    type: '!str',
    acl: 'array',
    tags: 'array',
    billingtag: 'array',  // TODO: why doesn't this match `supportedFields`?
    channels: 'array'
};



//---- Database vitual base

/**
 * Create a Database handler.
 *
 * @param app {App}
 * @params log {Bunyan Logger}
 */
function Database(log) {
    this.type = null;
}

/**
 * Prepare database for usage, if necessary.
 *
 * @param app {App}
 * @param callback {Function} `function (err)`
 */
Database.prototype.setup = function (app, callback) {
    callback();
};

/**
 * Get one manifest from the database.
 *
 * @param uuid {String} Image uuid.
 * @param callback {Function} `function (err, manifest, published_at)`
 *      where 'published_at' is the manifest published_at field, a string.
 */
Database.prototype.get = function (uuid, callback) {};

/**
 * Database search
 *
 * @param options {Object} Search options.
 * @param options.filter {Object} Fields conditions filter.
 * @param options.limit {Number} Optional. Return at most `limit` number of
 *      images.
 * @param options.marker {String} Optional. Return images with a `published_at`
 *      greater than or equal to the marker. This should be an ISO-format
 *      datetime string, e.g. '2015-05-07T14:42:22.106Z'.
 * @param callback {Function} `function (err, items)`
 */
Database.prototype.search = function (options, callback) {};

/**
 * Add a manifest to the database.
 *
 * @param uuid {String} Image uuid.
 * @param data {Object}
 * @param callback {Function} `function (err)`
 */
Database.prototype.add = function (uuid, data, callback) {};

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
Database.prototype.modify = function (uuid, changes, callback) {};

/**
 * Delete a manifest from the database.
 *
 * @param uuid {String} Image uuid.
 * @param callback {Function} `function (err)`
 */
Database.prototype.del = function (uuid, callback) {};



//---- 'local' Database
// This is a quick impl that (currently) does no indexing. All manifest data
// is stored in memory. Therefore this is only appropriate for small numbers
// of images (e.g. dev, testing and limited IMGAPI deployments).

function LocalDatabase(app, log) {
    assert.object(app, 'app');
    assert.object(log, 'log');

    this.type = 'local';
    this.app = app;
    this.log = log.child({component: 'db'}, true);
    this.dir = '/data/imgapi/manifests';
}
util.inherits(LocalDatabase, Database);

LocalDatabase.prototype.setup = function (app, callback) {
    assert.object(app, 'app');
    assert.func(callback, 'callback');
    var self = this;

    // Assumption for now: it is writable for us.
    this.log.info('mkdir -p %s', this.dir);
    mkdirp(this.dir, function (dirErr) {
        if (dirErr) {
            return callback(dirErr);
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

    // These hold *raw* manifests.
    this.manifests = [];
    this.manifestFromUuid = {};

    fs.readdir(this.dir, function (dirErr, filenames) {
        if (dirErr) {
            return callback(dirErr);
        }

        var raw;
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

                fs.stat(filepath, onFileStats);

                function onFileStats(statErr, stats) {
                    if (statErr) {
                        return next(statErr);
                    }

                    fs.readFile(filepath, 'utf8', function (err, content) {
                        if (err) {
                            return next(err);
                        }
                        try {
                            raw = JSON.parse(content);
                        } catch (syntaxErr) {
                            log.warn(syntaxErr,
                                'could not parse "%s" in database', filepath);
                            return next();
                        }
                        if (raw.uuid !== uuid) {
                            log.warn('filename "%s" uuid does not match ' +
                                'content uuid, "%s"', uuid, raw.uuid);
                            return next();
                        }
                        try {
                            Image.validateAndNormalize(app, raw);
                        } catch (validErr) {
                            log.warn(validErr,
                                'invalid manifest "%s" in database', filepath);
                            return next();
                        }
                        self.manifests.push({ value: raw,
                            published_at: raw.published_at });
                        self.manifestFromUuid[uuid] = { value: raw,
                            published_at: raw.published_at};
                        next();
                    });
                }
            },
            function (asyncErr) {
                if (asyncErr) {
                    return callback(asyncErr);
                }
                // Sort resulting collection so manifests are returned by mtime
                self.manifests.sort(function (a, b) {
                    var timeA = (a.published_at === undefined ? 0 :
                        new Date(a.published_at).getTime());
                    var timeB = (b.published_at === undefined ? 0 :
                        new Date(b.published_at).getTime());
                    return timeA - timeB;
                });
                return callback();
            }
        );
    });
};


/**
 * Add/update the given raw manifest to the indeces.
 */
LocalDatabase.prototype._addManifest = function _addManifest(raw) {
    var existing = this.manifestFromUuid[raw.uuid];
    if (existing === undefined) {
        this.manifests.push({ value: raw, published_at: raw.published_at });
    } else {
        // TODO(perf): do this in reverse, updated images tend to be the
        //      ones at the end.
        for (var i = 0; i < this.manifests.length; i++) {
            if (this.manifests[i].value.uuid === raw.uuid) {
                this.manifests[i] = { value: raw,
                    published_at: raw.published_at };
                break;
            }
        }
    }
    this.manifestFromUuid[raw.uuid] = { value: raw,
        published_at: raw.published_at };
};

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
};


/**
 * Get one manifest from the database.
 *
 * @param uuid {String} Image uuid.
 * @param callback {Function} `function (err, manifest, published_at)`
 *      where 'published_at' is the manifest published_at field, a string.
 */
LocalDatabase.prototype.get = function (uuid, callback) {
    var log = this.log;
    log.trace({uuid: uuid}, 'LocalDatabase.get');
    assert.string(uuid, 'uuid');
    assert.func(callback, 'callback');

    var manifest = this.manifestFromUuid[uuid];
    if (manifest === undefined) {
        return callback(new errors.ResourceNotFoundError(
            format('image %s not found', uuid)));
    }
    callback(null, manifest.value, manifest.published_at);
};


/**
 * LocalDatabase search
 *
 * @param options {Object} Search options.
 * @param options.filter {Object} Fields conditions filter.
 * @param options.limit {Number} Optional. Return at most `limit` number of
 *      images.
 * @param options.marker {String} Optional. Return images with a `published_at`
 *      greater than or equal to the marker. This should be an ISO-format
 *      datetime string, e.g. '2015-05-07T14:42:22.106Z'.
 * @param options.sort {Object} Required iff `options.marker` is provided.
 *      TODO: describe structure
 * @param callback {Function} `function (err, items)`
 */
LocalDatabase.prototype.search = function localSearch(options, callback) {
    assert.object(options, 'options');
    assert.object(options.filter, 'options.filter');
    assert.optionalNumber(options.limit, 'options.limit');
    assert.optionalString(options.marker, 'options.marker');
    assert.func(callback, 'callback');
    var filter = options.filter;
    var log = this.log;
    log.trace({ options: options }, 'LocalDatabase.search options');

    // Normalize bools in the filter options for comparison below.
    var sFilter = objCopy(filter);
    Object.keys(SEARCH_TYPE_FROM_FIELD).forEach(function (aField) {
        if (SEARCH_TYPE_FROM_FIELD[aField] === 'bool' &&
            sFilter[aField] !== undefined)
        {
            sFilter[aField] = String(sFilter[aField]);
        }
    });

    var hits = [];
    var fields = Object.keys(sFilter)
        .filter(function (fn) { return sFilter[fn] !== undefined; });
    var nFields = fields.length;
    var manifests = this.manifests;
    var nManifests = manifests.length;

    // Note: We could be a lot smarter here with caching if necessary.
    for (var m = 0; m < nManifests; m++) {
        var manifest = manifests[m].value;
        var published_at = manifests[m].published_at;
        var match = true;
        //console.log('-- search: %s (%s)', manifest.uuid, manifest.name);
        //console.log('sFilter:', sFilter);
        //console.log('manifest:', manifest);
        for (var f = 0; f < nFields; f++) {
            var field = fields[f];
            var type = SEARCH_TYPE_FROM_FIELD[field];
            // Special case since the comparison is 'expires_at<=now'
            if (field === 'expires_at' && sFilter[field] !== undefined) {
                if (manifest[field] > sFilter[field]) {
                    match = false;
                }
                continue;
            } else if (type === '~str' && sFilter[field][0] === '~') {
                var substr = sFilter[field].slice(1);
                if (manifest[field].indexOf(substr) === -1) {
                    match = false;
                    break;
                }
            } else if (type === '~str' || type === 'str' || type === 'bool') {
                if (String(manifest[field]) !== sFilter[field]) {
                    //console.log("    field %s: %s (%s) !== %s (%s)", field,
                    //    manifest[field], typeof(manifest[field]),
                    //    sFilter[field], typeof(sFilter[field]))
                    match = false;
                    break;
                }
            } else if (type === '!str') {
                var sVal = sFilter[field];
                if (sVal && sVal[0] === '!') {
                    // Invert
                    sVal = sVal.slice(1);
                    if (String(manifest[field]) === sVal) {
                        //console.log("    field %s: %s (%s) === %s (%s)",
                        //    field, manifest[field], typeof(manifest[field]),
                        //    sVal, typeof(sVal))
                        match = false;
                        break;
                    }
                } else {
                    if (String(manifest[field]) !== sVal) {
                        //console.log("    field %s: %s (%s) !== %s (%s)",
                        //    field, manifest[field], typeof(manifest[field]),
                        //    sVal, typeof(sVal))
                        match = false;
                        break;
                    }
                }
            } else if (type === 'array') {
                //console.log("    field %j: %j in %j?", field,
                //    sFilter[field], manifest[field]);
                if (!manifest[field]) {
                    match = false;
                    break;
                }
                var values = (typeof (sFilter[field]) === 'string' ?
                    [sFilter[field]] : sFilter[field]);
                for (var v = 0; v < values.length; v++) {
                    // Single tag match breaks the switch
                    if (manifest[field].indexOf(values[v]) === -1) {
                        match = false;
                        break;
                    }
                }
            } else {
                throw TypeError(format(
                    'unknown filter field type: "%s"', type));
            }
        }

        if (match && options.marker) {
            // When a marker is passed and sort order is ASC, it means that we
            // don't consider a match when published_at < options.marker because
            // we're looking for images after the marker. If our sort order is
            // DESC then we want images that are older than the marker
            if (options.sort.order === 'ASC' || options.sort.order === 'asc') {
                match = !(published_at < options.marker);
            } else {
                match = !(published_at > options.marker);
            }
        }
        if (match)
            hits.push(manifests[m]);

        // If we hit the limit on `hits` then we can break out of the for loop
        // because our images are sorted by mtime already
        if (options.limit && hits.length >= options.limit) {
            log.trace({limit: options.limit, numHits: hits.length},
                'LocalDatabase.search: break on limit');
            break;
        }
    }

    callback(null, hits);
};


LocalDatabase.prototype.add = function (uuid, raw, callback) {
    var log = this.log;
    assert.string(uuid, 'uuid');
    assert.object(raw, 'raw');
    assert.func(callback, 'callback');

    log.trace({uuid: uuid, raw: raw}, 'LocalDatabase.add');
    this._writeManifest(raw, callback);
};


LocalDatabase.prototype.modify = function (uuid, raw, callback) {
    var log = this.log;
    assert.string(uuid, 'uuid');
    assert.object(raw, 'raw');
    assert.func(callback, 'callback');

    log.trace({uuid: uuid, raw: raw}, 'LocalDatabase.modify');
    this._writeManifest(raw, callback);
};


LocalDatabase.prototype.del = function (uuid, callback) {
    var log = this.log;
    log.trace({uuid: uuid}, 'LocalDatabase.del');
    assert.string(uuid, 'uuid');
    assert.func(callback, 'callback');

    var manifest = this.manifestFromUuid[uuid];
    if (manifest === undefined) {
        return callback(new errors.ResourceNotFoundError(
            format('image %s not found', uuid)));
    }

    delete this.manifestFromUuid[uuid];
    this.manifests = this.manifests.filter(
        function (i) { return i.value.uuid !== uuid; });
    var manifestPath = path.join(this.dir, uuid + '.raw');
    rimraf(manifestPath, callback);
};



//---- Moray database

/**
 * Create a MorayDatabase handler.
 *
 * @param app {App}
 * @params log {Bunyan Logger}
 */
function MorayDatabase(app, log) {
    assert.object(app, 'app');
    assert.object(log, 'log');

    this.type = 'moray';
    this.app = app;
    this.log = log.child({component: 'db'}, true);
}
util.inherits(MorayDatabase, Database);


/**
 * Sets up the VMAPI buckets.
 */
var IMAGES_BUCKET = 'imgapi_images';
MorayDatabase.prototype._setupBucket = function (callback) {
    var self = this;
    var bucket = {
        name: IMAGES_BUCKET,
        indices: {
            index: {
                uuid: { type: 'string', unique: true},
                name: { type: 'string' },
                version: { type: 'string' },
                owner: { type: 'string' },
                origin: { type: 'string' },
                state: { type: 'string' },
                urn: { type: 'string', unique: true },
                tags: { type: '[string]' },
                billing_tags: { type: '[string]' },
                acl: { type: '[string]' },
                activated: { type: 'boolean' },
                disabled: { type: 'boolean' },
                public: { type: 'boolean' },
                os: { type: 'string' },
                type: { type: 'string' },
                expires_at: { type: 'string' },
                published_at: { type: 'string' }
            }
        }
    };

    self.app.morayClient.getBucket(bucket.name, function (err, bck) {
        if (err) {
            if (err.name === 'BucketNotFoundError') {
                self.app.morayClient.createBucket(bucket.name, bucket.indices,
                    callback);
            } else {
                callback(err);
            }
        } else {
            callback(null);
        }
    });
};


/**
 * Get one manifest from the database.
 *
 * @param uuid {String} Image uuid.
 * @param callback {Function} `function (err, manifest, published_at)`
 *      where 'published_at' is the manifest published_at field, a string.
 */
MorayDatabase.prototype.get = function (uuid, callback) {
    var self = this;
    var log = self.log;

    log.trace({ uuid: uuid }, 'moray get');
    self.app.morayClient.getObject(IMAGES_BUCKET, uuid, function (err, obj) {
        if (err) {
            if (err.name === 'ObjectNotFoundError') {
                callback(new errors.ResourceNotFoundError(
                    format('image %s not found', uuid)));
            } else {
                // 503: presuming this is a "can't connect to moray" error.
                callback(new errors.ServiceUnavailableError(err,
                    'service unavailable'));
            }
        } else {
            callback(null, obj.value, obj.value.published_at);
        }
    });
};

/**
 * MorayDatabase search
 *
 * @param options {Object} Search options.
 * @param options.filter {Object} Fields conditions filter.
 * @param options.limit {Number} Optional. Return at most `limit` number of
 *      images.
 * @param options.marker {String} Optional. Return images with a creation date
 *      greater or equal than the marker. For a LocalDatabase, marker is the
 *      mtime value in milliseconds of an image manifest file
 * @param callback {Function} `function (err, items)`
 */
MorayDatabase.prototype.search = function (options, callback) {
    var self = this;
    assert.object(options, 'options');
    assert.object(options.filter, 'options.filter');
    assert.optionalNumber(options.limit, 'options.limit');
    assert.optionalString(options.marker, 'options.marker');
    assert.func(callback, 'callback');
    var log = self.log;
    var filter = options.filter;
    log.trace({ options: options }, 'MorayDatabase.options');

    // Build the ldapjs filter.
    var ldapFilter = null;
    var findOpts = {};

    var fields = Object.keys(filter);
    if (fields.length === 0) {
        /*jsl:pass*/
    } else {
        ldapFilter = new filters.AndFilter();
        for (var i = 0; i < fields.length; i++) {
            var field = fields[i];
            var value = filter[field];
            if (value === undefined)
                continue;
            if (field === 'expires_at') {
                ldapFilter.addFilter(new filters.LessThanEqualsFilter(
                    {attribute: field, value: value}));
                continue;
            }
            switch (SEARCH_TYPE_FROM_FIELD[field]) {
            case 'str':
                ldapFilter.addFilter(new filters.EqualityFilter(
                        {attribute: field, value: value}));
                break;
            case '!str':
                if (value && value[0] === '!') {
                    // Invert
                    ldapFilter.addFilter(new filters.NotFilter({
                        filter: new filters.EqualityFilter({
                            attribute: field,
                            value: value.slice(1)
                        })
                    }));
                } else {
                    ldapFilter.addFilter(new filters.EqualityFilter(
                            {attribute: field, value: value}));
                }
                break;
            case 'array':
                // There are two ways we can filter on array values: regular
                // filtering or tag filtering (special because of its format).
                // - if length is 1 (i.e. billingtag = ['xxxl']), then we want
                //     a regular equality filter
                // - if length is 2 and the second value is '' (i.e.
                //     tag = ['foo='] -> ['foo', '']), then we want a
                //     substring filter (tag key 'foo' must be present)
                // - if length is 2 or more and the second value is not '' (i.e.
                //     tag = ['foo=bar'] -> ['foo', 'bar']), then we want an
                //     equality filter like case 1
                var alength;
                for (var j = 0; j < value.length; j++) {
                    alength = value[j].split('=').length;
                    if (alength == 1) {
                        ldapFilter.addFilter(new filters.EqualityFilter(
                            {attribute: field, value: value[j]}));
                    } else if (alength >= 2) {
                        if (value[j].split('=')[1] === '') {
                            ldapFilter.addFilter(new filters.SubstringFilter(
                                {attribute: field, initial: value[j]}));
                        } else {
                            ldapFilter.addFilter(new filters.EqualityFilter(
                                {attribute: field, value: value[j]}));
                        }
                    }
                }
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

        if (options.marker) {
            var filterClass;
            if (options.sort.order === 'ASC' || options.sort.order === 'asc') {
                filterClass = filters.GreaterThanEqualsFilter;
            } else {
                filterClass = filters.LessThanEqualsFilter;
            }
            ldapFilter.addFilter(new filterClass(
                { attribute: 'published_at', value: String(options.marker) }));
        }

        if (options.limit) {
            findOpts.limit = options.limit;
        }

        // When all fields have an undefined value
        if (!ldapFilter.filters.length) {
            ldapFilter = new filters.PresenceFilter({ attribute: 'uuid' });
        }
    }

    // By default this is published_at ASC
    findOpts.sort = options.sort;

    var morayfilter = ldapFilter.toString();
    log.info({ filter: morayfilter }, 'moray ldap search');
    log.info({ findOpts: findOpts }, 'moray findOpts');
    var items = [];
    var req = self.app.morayClient.findObjects(IMAGES_BUCKET,
        morayfilter, findOpts);

    req.once('error', function (err) {
        log.warn(err, 'Moray search error');
        // 503: presuming this is a "can't connect to Moray" error.
        return callback(new errors.ServiceUnavailableError(err,
            'service unavailable'));
    });

    req.on('record', function (object) {
        // Push published_at to the items array so we can order images by
        // that field inside apiListImages
        items.push({ value: object.value,
            published_at: object.value.published_at });
    });

    return req.once('end', function () {
        return callback(null, items);
    });
};

/**
 * Add a manifest to the database.
 *
 * @param uuid {String} Image uuid.
 * @param data {Object}
 * @param callback {Function} `function (err)`
 */
MorayDatabase.prototype.add = function (uuid, data, callback) {
    var self = this;
    var log = self.log;

    try {
        self.app.morayClient.putObject(IMAGES_BUCKET, uuid, data,
        function (addErr) {
            if (addErr) {
                log.warn({data: data}, 'error saving image data to moray');
                return callback(new errors.InternalError(addErr,
                    'error saving image ' + uuid));
            }
            callback();
        });
    } catch (ex) {
        callback(new errors.InternalError(ex, 'error saving'));
    }
};

/**
 * Modify is the same as add on Moray since both use putObject.
 */
MorayDatabase.prototype.modify = function (uuid, data, callback) {
    var self = this;

    self.app.morayClient.putObject(IMAGES_BUCKET, uuid, data,
    function (modErr) {
        if (modErr) {
            return callback(new errors.InternalError(modErr,
                'error modifying image ' + uuid));
        }
        callback();
    });
};

/**
 * Delete a manifest from the database.
 *
 * @param uuid {String} Image uuid.
 * @param callback {Function} `function (err)`
 */
MorayDatabase.prototype.del = function (uuid, callback) {
    var self = this;

    self.app.morayClient.delObject(IMAGES_BUCKET, uuid, function (delErr) {
        if (delErr) {
            if (delErr.name === 'ObjectNotFoundError') {
                callback(new errors.ResourceNotFoundError(
                    delErr, 'image ' + uuid + ' not found'));
            } else {
                callback(new errors.InternalError(delErr,
                    'could not delete image ' + uuid));
            }
        } else {
            callback();
        }
    });
};


//---- exports

module.exports = {
    local: LocalDatabase,
    moray: MorayDatabase
};
