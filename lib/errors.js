/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * IMGAPI errors. Error responses follow
 * <https://mo.joyent.com/docs/eng/master/#error-handling>
 *
 * Test out an example errors response via:
 *
 *      sdc-imgapi /ping?error=ValidationFailedError
 */

var util = require('util'),
    format = util.format;
var restify = require('restify'),
    RestError = restify.RestError;
var assert = require('assert-plus');


//---- globals

var examples = {};


///--- Errors

/**
 * Usage:
 *      new ValidationFailedError("boom", errors)
 *      new ValidationFailedError(cause, "boom", errors)
 * I.e. optional *first* arg "cause", per WError style.
 */
function ValidationFailedError(cause, message, errors) {
    if (errors === undefined) {
        errors = message;
        message = cause;
        cause = undefined;
    }
    assert.string(message, 'message');
    assert.arrayOfObject(errors, 'errors');
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        cause: cause,
        body: {
            code: this.constructor.restCode,
            message: message,
            errors: errors
        }
    });
}
util.inherits(ValidationFailedError, RestError);
ValidationFailedError.prototype.name = 'ValidationFailedError';
ValidationFailedError.restCode = 'ValidationFailed';
ValidationFailedError.statusCode = 422;
//ValidationFailedError.description = '...';

examples.ValidationFailedError = new ValidationFailedError("boom", []);



//---- restdown doc generation
// TODO later (TOOLS-204)

//if (require.main === module) {
//    console.log(ruhroh.generateRestdownTable(module.exports));
//    //XXX
//    //console.log("||**restCode**||**HTTP status code**||**Description**||");
//    //var restify = require('restify');
//    //Object.keys(module.exports).forEach(function (k) {
//    //    var E = module.exports[k];
//    //    if (k === 'HttpError' || k === 'RestError')
//    //        return;
//    //    console.log("||%s||%s||%s||", E.restCode, E.statusCode, E.description);
//    //})
//}



//---- exports

module.exports = {
    ValidationFailedError: ValidationFailedError,

    // Borrowed restify errors.
    InternalError: restify.InternalError,

    examples: examples
}
