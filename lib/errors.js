/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
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
    var message = 'cannot modify files on activated image ' + imageUuid;
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
ImageFilesImmutableError.description =
    'Cannot modify files on an activated image.';
samples.ImageFilesImmutableError = new ImageFilesImmutableError(
    '82ce32a2-9cb4-9a4c-a303-7a63254bacf4');


function ImageAlreadyActivatedError(cause, imageUuid) {
    if (imageUuid === undefined) {
        imageUuid = cause;
        cause = undefined;
    }
    var message = format('image "%s" is already activated', imageUuid);
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
    var message = format('image "%s" cannot be activated: it has no file',
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
OperatorOnlyError.description =
    'Operator-only endpoint called by a non-operator.';
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
ImageUuidAlreadyExistsError.description =
    'Attempt to import an image with a conflicting UUID';
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


function DownloadError(cause, message) {
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
util.inherits(DownloadError, RestError);
DownloadError.prototype.name = 'DownloadError';
DownloadError.restCode = 'Download';
DownloadError.statusCode = 400;
DownloadError.description = 'There was a problem with the download.';


function StorageIsDownError(cause) {
    var message = 'storage is down at the moment';
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(StorageIsDownError, restify.ServiceUnavailableError);
StorageIsDownError.prototype.name = 'StorageIsDownError';
StorageIsDownError.restCode = 'StorageIsDown';
StorageIsDownError.statusCode = 503;
StorageIsDownError.description = 'Storage system is down.';
samples.StorageIsDownError = new StorageIsDownError();


function StorageUnsupportedError(cause) {
    var message = 'storage type is unsupported';
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(StorageUnsupportedError, restify.ServiceUnavailableError);
StorageUnsupportedError.prototype.name = 'StorageUnsupportedError';
StorageUnsupportedError.restCode = 'StorageUnsupported';
StorageUnsupportedError.statusCode = 503;
StorageUnsupportedError.description =
    'The storage type for the image file is unsupported.';
samples.StorageUnsupportedError = new StorageUnsupportedError();


function RemoteSourceError(cause, message) {
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
util.inherits(RemoteSourceError, restify.ServiceUnavailableError);
RemoteSourceError.prototype.name = 'RemoteSourceError';
RemoteSourceError.restCode = 'RemoteSourceError';
RemoteSourceError.statusCode = 503;
RemoteSourceError.description = 'Error contacting the remote source.';
samples.RemoteSourceError = new RemoteSourceError();


function OwnerDoesNotExistError(cause, owner) {
    if (owner === undefined) {
        owner = cause;
        cause = undefined;
    }
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: format('owner "%s" does not exist', owner),
        cause: cause
    });
}
util.inherits(OwnerDoesNotExistError, RestError);
OwnerDoesNotExistError.prototype.name = 'OwnerDoesNotExistError';
OwnerDoesNotExistError.restCode = 'OwnerDoesNotExist';
OwnerDoesNotExistError.statusCode = 422;
OwnerDoesNotExistError.description = (
    'No user exists with the UUID given in the "owner" field for image ' +
    'creation or import.');


function AccountDoesNotExistError(cause, account) {
    if (account === undefined) {
        account = cause;
        cause = undefined;
    }
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: format('account "%s" does not exist', account),
        cause: cause
    });
}
util.inherits(AccountDoesNotExistError, RestError);
AccountDoesNotExistError.prototype.name = 'AccountDoesNotExistError';
AccountDoesNotExistError.restCode = 'AccountDoesNotExist';
AccountDoesNotExistError.statusCode = 422;
AccountDoesNotExistError.description = (
    'No account exists with the UUID/login given.');


function NotImageOwnerError(cause, account, imageUuid) {
    if (imageUuid === undefined) {
        imageUuid = account;
        account = cause;
        cause = undefined;
    }
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: format('account %s is not the owner of image %s',
            account, imageUuid),
        cause: cause
    });
}
util.inherits(NotImageOwnerError, RestError);
NotImageOwnerError.prototype.name = 'NotImageOwnerError';
NotImageOwnerError.restCode = 'NotImageOwner';
NotImageOwnerError.statusCode = 422;
NotImageOwnerError.description = 'The caller is not the owner of this image.';


function NotMantaPathOwnerError(cause, account, mpath) {
    if (mpath === undefined) {
        mpath = account;
        account = cause;
        cause = undefined;
    }
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: format('account %s is not the owner of Manta path %s',
            account, mpath),
        cause: cause
    });
}
util.inherits(NotMantaPathOwnerError, RestError);
NotMantaPathOwnerError.prototype.name = 'NotMantaPathOwnerError';
NotMantaPathOwnerError.restCode = 'NotMantaPathOwner';
NotMantaPathOwnerError.statusCode = 422;
NotMantaPathOwnerError.description = 'The caller is not the owner of this ' +
    'Manta path.';


function OriginDoesNotExistError(cause, origin) {
    if (origin === undefined) {
        origin = cause;
        cause = undefined;
    }
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: format('origin image "%s" does not exist', origin),
        cause: cause
    });
}
util.inherits(OriginDoesNotExistError, RestError);
OriginDoesNotExistError.prototype.name = 'OriginDoesNotExistError';
OriginDoesNotExistError.restCode = 'OriginDoesNotExist';
OriginDoesNotExistError.statusCode = 422;
OriginDoesNotExistError.description = (
    'No image exists with the UUID given in the "origin" field for image '
    + 'creation or import.');


function OriginIsNotActiveError(cause, origin) {
    if (origin === undefined) {
        origin = cause;
        cause = undefined;
    }
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: format('origin image "%s" is not active', origin),
        cause: cause
    });
}
util.inherits(OriginIsNotActiveError, RestError);
OriginIsNotActiveError.prototype.name = 'OriginIsNotActiveError';
OriginIsNotActiveError.restCode = 'OriginIsNotActive';
OriginIsNotActiveError.statusCode = 422;
OriginIsNotActiveError.description = (
    'An origin image of the given image exists, but is not active.');


function InsufficientServerVersionError(message) {
    assert.string(message, 'message');
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        body: {
            code: this.constructor.restCode,
            message: message
        }
    });
}
util.inherits(InsufficientServerVersionError, RestError);
InsufficientServerVersionError.prototype.name =
    'InsufficientServerVersionError';
InsufficientServerVersionError.restCode = 'InsufficientServerVersion';
InsufficientServerVersionError.statusCode = 422;
InsufficientServerVersionError.description = 'Image creation is not supported '
    + 'for this VM because the host server version is not of a recent enough '
    + 'version.';



function NotAvailableError(cause, msg) {
    if (msg === undefined) {
        msg = cause;
        cause = undefined;
    }
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: msg,
        cause: cause
    });
}
util.inherits(NotAvailableError, RestError);
NotAvailableError.prototype.name = 'NotAvailableError';
NotAvailableError.restCode = 'NotAvailable';
NotAvailableError.statusCode = 501;
NotAvailableError.description = 'Functionality is not available.';


/**
 * @param cause {Object} Optional. An underlying cause Error object.
 * @param uuid {String} The uuid of the image with deps.
 * @param deps {Array} Array of uuids of dependent images.
 */
function ImageHasDependentImagesError(cause, uuid, deps) {
    if (deps === undefined) {
        deps = uuid;
        uuid = cause;
        cause = undefined;
    }
    var depsSummary;
    if (deps.length < 10) {
        depsSummary = deps.join(', ');
    } else {
        depsSummary = format('%s, and %d more...', deps.slice(0, 5).join(', '),
            deps.length - 5);
    }
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: format('image "%s" has %d dependent incremental image(s): %s',
            uuid, deps.length, depsSummary),
        cause: cause
    });
}
util.inherits(ImageHasDependentImagesError, RestError);
ImageHasDependentImagesError.prototype.name = 'ImageHasDependentImagesError';
ImageHasDependentImagesError.restCode = 'ImageHasDependentImages';
ImageHasDependentImagesError.statusCode = 422;
ImageHasDependentImagesError.description = (
    'An error raised when attempting to delete an image which has dependent '
    + 'incremental images (images whose "origin" is this image).');


function NotImplementedError(msg) {
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: msg
    });
}
util.inherits(NotImplementedError, RestError);
NotImplementedError.prototype.name = 'NotImplementedError';
NotImplementedError.restCode = 'NotImplemented';
NotImplementedError.statusCode = 400;
NotImplementedError.description =
    'Attempt to use a feature that is not yet implemented';


// Guessing we will have to deal with more specific manta errors in the future?
function parseErrorFromStorage(err, message) {
    if (message === undefined) message = 'storage backend error';

    if (err.restCode && err.restCode === 'ServiceUnavailableError') {
        return new StorageIsDownError();
    } else {
        return new restify.InternalError(err, '%s: %s', message, err);
    }
}

// Handle docker registry client errors and convert these errors into IMGAPI
// errors. Note that err could be a docker registry client error, a node.js
// http/connection error or a restify error. Due to this we use the 'name'
// and/or 'code' attributes of the error to check what type of error it is and
// convert it into the error instance we want.
function wrapErrorFromDrc(err) {
    if (!err) {
        return err;
    }
    if (err.name === 'BadDigestError') {
        // Docker registry client digest error.
        return new ValidationFailedError(err,
            (err.message || err.toString()),
            [ {field: 'digest', code: 'Invalid'} ]);
    } else if (err.name === 'ConnectTimeoutError') {
        // Restify connection timeout.
        return new RemoteSourceError(err, err.message);
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' ||
        err.code === 'ENOTFOUND')
    {
        // Node.js connection error.
        return new RemoteSourceError(err, err.message);
    } else if (err.name === 'DownloadError') {
        // Docker registry client download error.
        return new DownloadError(err, err.message);
    } else if (err.name === 'NotFoundError') {
        // Docker registry client image not found error.
        return new restify.ResourceNotFoundError(err, err.message);
    } else if (err.name === 'UnauthorizedError') {
        // Docker registry client unauthorized error.
        return new restify.UnauthorizedError(err, err.message);
    } else {
        // Unexpected error - wrap it into an internal error.
        return new restify.InternalError(err, err.message);
    }
}


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
    DownloadError: DownloadError,
    StorageIsDownError: StorageIsDownError,
    StorageUnsupportedError: StorageUnsupportedError,
    RemoteSourceError: RemoteSourceError,
    OwnerDoesNotExistError: OwnerDoesNotExistError,
    AccountDoesNotExistError: AccountDoesNotExistError,
    NotImageOwnerError: NotImageOwnerError,
    NotMantaPathOwnerError: NotMantaPathOwnerError,
    OriginDoesNotExistError: OriginDoesNotExistError,
    OriginIsNotActiveError: OriginIsNotActiveError,
    InsufficientServerVersionError: InsufficientServerVersionError,
    ImageHasDependentImagesError: ImageHasDependentImagesError,
    NotAvailableError: NotAvailableError,
    NotImplementedError: NotImplementedError,

    // Core restify RestError and HttpError classes used by IMGAPI.
    InternalError: restify.InternalError,
    ResourceNotFoundError: restify.ResourceNotFoundError,
    InvalidHeaderError: restify.InvalidHeaderError,
    ServiceUnavailableError: restify.ServiceUnavailableError,
    UnauthorizedError: restify.UnauthorizedError,
    BadRequestError: restify.BadRequestError,

    // Helper function to parse errors that come from manta
    parseErrorFromStorage: parseErrorFromStorage,

    // Helper function to wrap errors that come from docker registry client.
    wrapErrorFromDrc: wrapErrorFromDrc,

    samples: samples
};


//---- mainline (to print out errors table for the docs)

// Some error table data that isn't included on the error classes above.
var descFromError = {
    InvalidHeaderError: 'An invalid header was given in the request.'
};

function generateRestdownTable(errors) {
    var http = require('http');
    var rows = [
        '| Code | HTTP status code | Description |',
        '| ---- | ---------------- | ----------- |'
    ];
    Object.keys(errors).forEach(function (name) {
        var E = errors[name];
        var restCode, statusCode;
        if (!E.restCode) {
            var e = new E();
            restCode = e.restCode || e.body.code;
            statusCode = e.statusCode;
        } else {
            restCode = E.restCode;
            statusCode = E.statusCode;
        }
        var desc = E.description;
        if (!desc) {
            desc = descFromError[name];
        }
        if (!desc) {
            desc = http.STATUS_CODES[statusCode];
        }
        rows.push(format('| %s | %s | %s |',
            restCode, statusCode, desc.replace('|', '\\|')));
    });
    return rows.join('\n');
}

if (require.main === module) {
    var p = console.log;
    var errs = {};
    Object.keys(module.exports).forEach(function (e) {
        if (/Error$/.test(e)) {
            errs[e] = module.exports[e];
        }
    });
    var table = generateRestdownTable(errs);
    p(table);
}
