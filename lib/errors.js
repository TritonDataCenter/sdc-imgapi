/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * IMGAPI errors. These include all standard restify errors (one for
 * each HTTP status code and run extra restify ones, e.g.
 * `InvalidArgumentError`, see
 * <http://mcavage.github.com/node-restify/#Error-handling>)
 *
 * See <https://github.com/trentm/node-ruhroh#error-class-call-signatures>
 * for error class call signatures. Most of these are exposed for testing via
 * IMGAPI's "Ping" endpoint:
 *
 *      # 1.
 *      sdc-imgapi /ping?error=MyError
 *      # 2.
 *      sdc-imgapi /ping?error=ValidationFailedError\&message="my message"
 *      # 3.
 *      sdc-imgapi /ping?error=ValidationFailedError\&message="my message"\&cause=TypeError
 *      # 4. Just using `42` here for brevity and Bash quoting.
 *      sdc-imgapi /ping?error=ValidationFailedError\&message="my message"\&cause=TypeError\&errors=42
 *      # 5. (not exposed via IMGAPI)
 */

var ruhroh = require('ruhroh');

var ERRORS = [
    ['ValidationFailed', 422, 'Validation of input parameters failed. See "errors" array for specific failures.'],
];

module.exports = ruhroh.createErrorClasses(ERRORS);

