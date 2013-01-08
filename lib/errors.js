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

var samples = {};


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
ValidationFailedError.description = 'Validation of parameters failed.';
samples.ValidationFailedError = new ValidationFailedError('boom', []);


function InvalidParameterError(cause, message, errors) {
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
util.inherits(InvalidParameterError, RestError);
InvalidParameterError.prototype.name = 'InvalidParameterError';
InvalidParameterError.restCode = 'InvalidParameter';
InvalidParameterError.statusCode = 422;
InvalidParameterError.description = 'Given parameter was invalid.';
samples.InvalidParameterError = new InvalidParameterError(
    'invalid "foo"', [ {field: 'foo', code: 'Invalid'} ]);


function ImageFilesImmutableError(cause, imageUuid) {
    if (imageUuid === undefined) {
        imageUuid = cause;
        cause = undefined;
    }
    var message = "cannot modify files on activated image " + imageUuid;
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(ImageFilesImmutableError, RestError);
ImageFilesImmutableError.prototype.name = 'ImageFilesImmutableError';
ImageFilesImmutableError.restCode = 'ImageFilesImmutable';
ImageFilesImmutableError.statusCode = 422;
ImageFilesImmutableError.description = 'Cannot modify files on an activated image.';
samples.ImageFilesImmutableError = new ImageFilesImmutableError(
    '82ce32a2-9cb4-9a4c-a303-7a63254bacf4');


function ImageAlreadyActivatedError(cause, imageUuid) {
    if (imageUuid === undefined) {
        imageUuid = cause;
        cause = undefined;
    }
    var message = format("image '%s' is already activated", imageUuid);
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(ImageAlreadyActivatedError, RestError);
ImageAlreadyActivatedError.prototype.name = 'ImageAlreadyActivatedError';
ImageAlreadyActivatedError.restCode = 'ImageAlreadyActivated';
ImageAlreadyActivatedError.statusCode = 422;
ImageAlreadyActivatedError.description = 'Image is already activated.';
samples.ImageAlreadyActivatedError = new ImageAlreadyActivatedError(
    'ed8cd007-2065-0140-8d41-e32247b71748');


// Oh my Little sister, don't she'd no tears...
function NoActivationNoFileError(cause, imageUuid) {
    if (imageUuid === undefined) {
        imageUuid = cause;
        cause = undefined;
    }
    var message = format("image '%s' cannot be activated: it has no file",
        imageUuid);
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(NoActivationNoFileError, RestError);
NoActivationNoFileError.prototype.name = 'NoActivationNoFileError';
NoActivationNoFileError.restCode = 'NoActivationNoFile';
NoActivationNoFileError.statusCode = 422;
NoActivationNoFileError.description = 'Image must have a file to be activated.';
samples.NoActivationNoFileError = new NoActivationNoFileError(
    'ed8cd007-2065-0140-8d41-e32247b71748');


function OperatorOnlyError(cause) {
    var message = 'this endpoint may only be called by an operator';
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(OperatorOnlyError, RestError);
OperatorOnlyError.prototype.name = 'OperatorOnlyError';
OperatorOnlyError.restCode = 'OperatorOnly';
OperatorOnlyError.statusCode = 403;
OperatorOnlyError.description = 'Operator-only endpoint called by a non-operator.';
samples.OperatorOnlyError = new OperatorOnlyError();


function ImageUuidAlreadyExistsError(cause, imageUuid) {
    if (imageUuid === undefined) {
        imageUuid = cause;
        cause = undefined;
    }
    var message = format('image uuid "%s" already exists', imageUuid);
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(ImageUuidAlreadyExistsError, RestError);
ImageUuidAlreadyExistsError.prototype.name = 'ImageUuidAlreadyExistsError';
ImageUuidAlreadyExistsError.restCode = 'ImageUuidAlreadyExists';
ImageUuidAlreadyExistsError.statusCode = 409;
ImageUuidAlreadyExistsError.description
    = 'Attempt to import an image with a conflicting UUID';
samples.ImageUuidAlreadyExistsError = new ImageUuidAlreadyExistsError();


function UploadError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(UploadError, RestError);
UploadError.prototype.name = 'UploadError';
UploadError.restCode = 'Upload';
UploadError.statusCode = 400;
UploadError.description = 'There was a problem with the upload.';



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
//    //    console.log("||%s||%s||%s||", E.restCode, E.statusCode,
//    //        E.description);
//    //})
//}


samples.InternalError = new restify.InternalError('boom');



//---- exports

module.exports = {
    ValidationFailedError: ValidationFailedError,
    InvalidParameterError: InvalidParameterError,
    ImageFilesImmutableError: ImageFilesImmutableError,
    ImageAlreadyActivatedError: ImageAlreadyActivatedError,
    NoActivationNoFileError: NoActivationNoFileError,
    OperatorOnlyError: OperatorOnlyError,
    ImageUuidAlreadyExistsError: ImageUuidAlreadyExistsError,
    UploadError: UploadError,

    // Core restify RestError and HttpError classes used by IMGAPI.
    InternalError: restify.InternalError,
    ResourceNotFoundError: restify.ResourceNotFoundError,
    InvalidHeaderError: restify.InvalidHeaderError,
    ServiceUnavailableError: restify.ServiceUnavailableError,
    UnauthorizedError: restify.UnauthorizedError,
    BadRequestError: restify.BadRequestError,

    samples: samples
};
