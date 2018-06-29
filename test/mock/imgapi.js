/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Mock IMGAPI server.
 */

var fs = require('fs');
var path = require('path');
var util = require('util');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var restify = require('restify');

var DEFAULT_PORT = 8082;
var format = util.format;
var images = {};
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;


function loadImage(server, uuid) {
    if (images.hasOwnProperty(uuid)) {
        return true;
    }

    var mpath = path.join(server.imagesDir, uuid + '.manifest');
    if (!fs.existsSync(mpath)) {
        return false;
    }

    var image = JSON.parse(fs.readFileSync(mpath));
    assert.equal(uuid, image.uuid);

    if (server.mapAdminAccount && image.owner === server.mapAdminAccount) {
        image.owner = server.adminAccount;
    }

    images[uuid] = image;

    return true;
}

function reqImg(req, res, next) {
    var uuid = req.params.uuid;

    if (!UUID_RE.test(uuid) || !loadImage(this, uuid)) {
        var message = req.url + ' does not exist';
        next(new restify.errors.NotFoundError(format('%s', message)));
        return;
    }

    req.img = images[uuid];
    next();
}

function checkImgAccess(req, res, next) {
    assert.object(req.img, 'req.img');

    var account = req.query.account;

    if (account) {
        var m = req.img;
        if (m.owner === this.adminAccount && m.public) {
            // Public admin (operator) images are always accessible.
            next();
            return;
        }
        if (m.owner !== account && (!m.acl || m.acl.indexOf(account) === -1)) {
            var message = req.url + ' does not exist';
            next(new restify.errors.NotFoundError(format('%s', message)));
            return;
        }
    }

    next();
}

function mockGetImage(req, res, next) {
    res.send(req.img);
    next();
}

function mockGetImageFile(req, res, next) {
    var fpath = path.join(this.imagesDir, req.img.uuid + '.file0');
    var stream = fs.createReadStream(fpath);
    stream.on('end', function () {
        next();
    });
    stream.pipe(res);
}

function setupServer(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalString(opts.adminAccount, 'opts.adminAccount');
    assert.optionalString(opts.imagesDir, 'opts.imagesDir');
    assert.optionalObject(opts.log, 'opts.log');
    assert.optionalNumber(opts.port, 'opts.port');
    assert.func(callback, 'callback');

    var log = opts.log;
    if (!log) {
        log = bunyan.createLogger({name: 'mock-imgapi', level: 'warn'});
    }
    var port = opts.port || DEFAULT_PORT;
    var server;

    server = restify.createServer({
        name: 'mock-imgapi',
        handleUncaughtExceptions: true,
        log: log
    });

    if (process.env.UFDS_ADMIN_UUID) {
        server.adminAccount = process.env.UFDS_ADMIN_UUID;
        server.mapAdminAccount = opts.adminAccount;
    } else {
        server.adminAccount = opts.adminAccount;
    }

    server.imagesDir = opts.imagesDir || '/var/tmp/images';

    // server.use(restify.requestLogger());
    server.use(restify.queryParser({
        mapParams: false,
        allowDots: false,
        plainObjects: false
    }));

    server.on('uncaughtException', function (req, res, route, err) {
        console.log('Mock Server Error:', err.message);
        log.error(err, 'uncaughtException');
        res.send(new restify.errors.InternalServerError(err.message));
    });

    server.on('after', function (req, res, route, err) {
        restify.auditLogger({
            log: log.child(
                {
                    route: route && route.name,
                    action: req.query.action
                },
                true),
            body: true
        })(req, res, route, err);
    });

    server.get(
        {path: '/images/:uuid', name: 'GetImage'},
        reqImg,
        checkImgAccess,
        mockGetImage);
    server.get(
        {path: '/images/:uuid/file', name: 'GetImageFile'},
        reqImg,
        checkImgAccess,
        mockGetImageFile);

    server.listen(port, '127.0.0.1', function (err) {
        if (err) {
            callback(err);
            return;
        }

        log.info('Mock Image API listening on <http://localhost:%d>.', port);
        callback(null, server);
    });
}


module.exports = {
    setupServer: setupServer
};
