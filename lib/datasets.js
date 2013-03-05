/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * IMGAPI endpoints for '/datasets/...'. These are solely here to easy the
 * transition from DSAPI. Because of the drop of URNs, the mapping isn't
 * perfect.
 */

var warn = console.warn;
var util = require('util'),
    format = util.format;

var assert = require('assert-plus');
var restify = require('restify');

var errors = require('./errors');
var redir = require('./utils').redir;



//---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- API controllers


function apiGetDataset(req, res, next) {
    var arg = req.params.arg;
    if (UUID_RE.test(arg)) {
        redir('/images/' + arg, true)(req, res, next);
    } else {
        var parts = arg.split(/:/g);
        if (parts.length === 2) {
            redir('/images/?name=' + parts[0] + '&version=' + parts[1],
                     true)(req, res, next);
        } else if (parts.length === 3) {
            redir('/images/?name=' + parts[2], true)(req, res, next);
        } else if (parts.length === 4) {
            redir('/images/?name=' + parts[2] + '&version=' + parts[3],
                     true)(req, res, next);
        } else {
            redir('/images/?name=' + arg, true)(req, res, next);
        }
    }
}

/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 */
function mountApi(server) {
    server.get(
        {path: '/datasets', name: 'ListDatasets'},
        redir('/images', true));
    server.get(
        {path: '/datasets/:arg', name: 'GetDataset'},
        apiGetDataset);
}



//---- exports

module.exports = {
    mountApi: mountApi
};
