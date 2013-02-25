/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Audit logger for imgapi.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');



//---- API

/**
 * Returns a Bunyan audit logger suitable to be used in a server.on('after')
 * event.  I.e.:
 *
 *      server.on('after', audit.auditLogger({ log: myAuditLogger }));
 *
 * @param {Object} options:
 *      - log {Bunyan Logger} Required. The base logger for audit logging.
 *      - body {Boolean} Default false. Set to true to log request and
 *        response bodies.
 * @return {Function} to be used in server.after.
 */
function auditLogger(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');

    var log = options.log.child({
        audit: true,
        serializers: {
            err: bunyan.stdSerializers.err,
            req: function auditRequestSerializer(req) {
                // Slightly diff fields than `bunyan.stdSerializers.req`.
                if (!req)
                    return (false);
                return ({
                    method: req.method,
                    url: req.url,
                    headers: req.headers,
                    httpVersion: req.httpVersion,
                    version: req.version,
                    body: options.body === true ? req.body : undefined,
                    user: req._user ? req._user.uuid : undefined
                });
            },
            res: function auditResponseSerializer(res) {
                if (!res)
                    return (false);
                return ({
                    statusCode: res.statusCode,
                    headers: res._headers,
                    body: options.body === true ? res._body : undefined
                });
            }
        }
    });

    function audit(req, res, route, err) {
        // Skip logging some high frequency or unimportant endpoints to key
        // log noise down.
        var method = req.method;
        var path = req.path();
        if (method === 'GET' || method === 'HEAD') {
            if (path === '/ping'
                || path.slice(0, 6) === '/docs/')
            {
                return;
            }
        }

        var latency = res.getHeader('Response-Time');
        if (typeof (latency) !== 'number')
            latency = Date.now() - req.time();

        var obj = {
            remoteAddress: req.connection.remoteAddress,
            remotePort: req.connection.remotePort,
            req_id: req.getId(),
            req: req,
            res: res,
            err: err,
            latency: latency
        };
        log.info(obj, '%shandled: %d', (route ? route + ' ' : ''),
            res.statusCode);
        return (true);
    }

    return (audit);
}



//---- Exports

module.exports = {
    auditLogger: auditLogger
};
