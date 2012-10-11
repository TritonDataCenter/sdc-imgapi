/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * IMGAPI model and endpoints for '/images/...'.
 */

var debug = console.warn;
var format = require('util').format;

var assert = require('assert-plus');
var uuid = require('node-uuid');

var ufdsmodel = require('./ufdsmodel');
var utils = require('./utils'),
  objCopy = utils.objCopy,
  boolFromString = utils.boolFromString;
var errors = require('./errors');



//---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- Image model

/**
 * Create a Image object from raw DB (i.e. UFDS) data.
 * External usage should use `Image.create(...)`.
 *
 * @param app
 * @param raw {Object} The raw instance data from the DB (or manually in
 *    that form). E.g.:
 *      { dn: 'image=:uuid, ou=images, o=smartdc',
 *        uuid: ':uuid',
 *        ...
 *        objectclass: 'image' }
 * @throws {Error} if the given data is invalid.
 */
function Image(app, raw) {
  assert.object(app, 'app');
  assert.object(raw, 'raw');
  assert.string(raw.uuid, 'raw.uuid');
  assert.string(raw.name, 'raw.name');
  //TODO:XXX ... others
  assert.string(raw.objectclass, 'raw.objectclass');
  if (raw.objectclass !== Image.objectclass) {
    assert.equal(raw.objectclass, Image.objectclass,
      format('invalid Image data: objectclass "%s" !== "%s"',
      raw.objectclass, Image.objectclass));
  }

  this.uuid = raw.uuid;
  this.dn = Image.dn(this.uuid);
  if (raw.dn) {
    assert.equal(raw.dn, this.dn,
      format('invalid Image data: given "dn" (%s) does not '
        + 'match built dn (%s)', raw.dn, this.dn));
  }

  var rawCopy = objCopy(raw);
  delete rawCopy.dn;
  delete rawCopy.controls;
  if (rawCopy.datacenter && typeof(rawCopy.datacenter) === 'string') {
    rawCopy.datacenter = [rawCopy.datacenter];
  }
  this.raw = Image.validate(app, rawCopy);

  var self = this;
  this.__defineGetter__('name', function () {
    return self.raw.name;
  });
  this.__defineGetter__('description', function () {
    return self.raw.description;
  });
  this.__defineGetter__('type', function () {
    return self.raw.type;
  });
  this.__defineGetter__('os', function () {
    return self.raw.os;
  });
  this.__defineGetter__('published_at', function () {
    return new Date(self.raw.published_at);
  });
  this.__defineGetter__('tags', function () {
    return self.raw.tag;
  });
  this.__defineGetter__('datacenters', function () {
    return self.raw.datacenter;
  });
  this.disabled = boolFromString(this.raw.disabled, false, 'raw.disabled');
}




Image.objectclass = 'sdcimage';

Image.dn = function (uuid) {
  return format('uuid=%s, ou=images, o=smartdc', uuid);
};

Image.dnFromRequest = function (req) {
  var uuid = req.params.uuid;
  if (! UUID_RE.test(uuid)) {
    throw new restify.InvalidArgumentError(
      format('invalid probe UUID: "%s"', uuid));
  }
  return Image.dn(uuid);
};

Image.parentDnFromRequest = function (req) {
  return 'ou=images, o=smartdc';
};


/**
 * Return the API view of this Image's data.
 */
Image.prototype.serialize = function serialize() {
  var data = {
    uuid: this.uuid,
    name: this.name,
    os: this.os,
    type: this.type,
    published_at: this.published_at,
    disabled: this.disabled,
    datacenters: this.datacenters,
    tags: this.tags
  };
  if (this.description) data.description = this.description;
  if (this.urn) data.urn = this.urn;
  return data;
};


/**
 * Authorize that this Image can be added/updated.
 *
 * @param app {App} The amon-master app.
 * @param callback {Function} `function (err)`. `err` may be:
 *    undefined: write is authorized
 *    InternalError: some other error in authorizing
 */
Image.prototype.authorizeWrite = function (app, callback) {
  callback();
};

Image.prototype.authorizeDelete = function (app, callback) {
  callback();
};



/**
 * Get a probe.
 *
 * @param app {App} The IMGAPI App.
 * @param uuid {String} The image UUID.
 * @param callback {Function} `function (err, image)`
 */
Image.get = function get(app, uuid, callback) {
  XXX
  var dn = Image.dn(uuid);
  ufdsmodel.modelGet(app, Image, dn, app.log, callback);
};


/**
 * Validate the raw data and optionally massage some fields.
 *
 * @param app {App} The amon-master app.
 * @param raw {Object} The raw data for this object.
 * @returns {Object} The raw data for this object, possibly massaged to
 *    normalize field values.
 * @throws {restify Error} if the raw data is invalid.
 */
Image.validate = function validate(app, raw) {
  //XXX
  //if (raw.name && raw.name.length > 512) {
  //  throw new restify.InvalidArgumentError(
  //    format('image name is too long (max 512 characters): \'%s\'', raw.name));
  //}

  return raw;
};



/**
 * Create a new Image (with validation).
 *
 * @param app {App}
 * @param data {Object} The probe data.
 * @param callback {Function} `function (err, probe)`.
 */
Image.create = function createImage(app, data, callback) {
  assert.object(app, 'app');
  assert.object(data, 'data');
  assert.func(callback, 'callback');

  // Basic validation.
  //TODO:XXX Validation. Something other that assert-plus. Perhaps a
  //    ./validation.js with similar methods and uses ./errors.js for
  //    spec'd error codes.
  try {
    assert.string(data.name, 'data.name');
    assert.string(data.type, 'data.type');
    assert.string(data.os, 'data.os');
    assert.optionalArrayOfString(data.tags, 'data.tags');
    //assert.arrayOfObject(data.files, 'data.files');
  } catch (e) {
    // TODO: complete from <https://mo.joyent.com/docs/eng/master/#error-handling>
    throw new errors.ValidationFailedError({
      cause: e,
      message: "invalid parameters for image", //XXX list the fields in the msg
      //XXX need a 'field' key per JEG
      errors: [{field: 'XXX', code: 'Invalid'}]
    });
  }

  // Put together the raw data.
  var newUuid = uuid();
  var raw = {
    uuid: newUuid,
    name: data.name,
    type: data.type,
    published_at: (new Date()).toISOString(),
    os: data.os,
    disabled: data.disabled || false,
    objectclass: Image.objectclass
  };
  if (data.tags && data.tags.length > 0) {
    raw.tags = data.tags;
  }

  var image = null;
  try {
    image = new Image(app, raw);
  } catch (cErr) {
    return callback(cErr);
  }

  callback(null, image);
};




//---- API controllers

function apiListImages(req, res, next) {
  return ufdsmodel.requestList(req, res, next, Image);
}

function apiGetImage(req, res, next) {
  return ufdsmodel.requestGet(req, res, next, Image);
}

function apiCreateImage(req, res, next) {
  return ufdsmodel.requestCreate(req, res, next, Image);
}

//function apiPutImage(req, res, next) {
//  return ufdsmodel.requestPut(req, res, next, Image);
//}

//function apiDeleteImage(req, res, next) {
//  return ufdsmodel.requestDelete(req, res, next, Image);
//}


/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 */
function mountApi(server) {
  server.get(
    {path: '/images', name: 'ListImages'},
    apiListImages);
  server.get(
    {path: '/images/:uuid', name: 'GetImage'},
    apiGetImage);
  server.post(
    {path: '/images', name: 'CreateImage'},
    apiCreateImage);
  //server.put(
  //  {path: '/images/:uuid', name: 'PutImage'},
  //  apiPutImage);
  //server.del(
  //  {path: '/images/:uuid', name: 'DeleteImage'},
  //  apiDeleteImage);
}



//---- exports

module.exports = {
  Image: Image,
  mountApi: mountApi
};
