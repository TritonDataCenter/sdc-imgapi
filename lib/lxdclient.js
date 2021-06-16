/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

var path = require('path');
var util = require('util');

var assert = require('assert-plus');
var restifyClients = require('restify-clients');
var restifyErrors = require('restify-errors');


const DEFAULT_REGISTRIES = {
    images: 'https://us.images.linuxcontainers.org',
    ubuntu: 'https://cloud-images.ubuntu.com/releases'
};
const INDEX_JSON_PATH = 'streams/v1/index.json';

function LxdClient(opts) {
    assert.object(opts, 'opts');
    assert.string(opts.url, 'opts.url');
    assert.object(opts.log, 'opts.log');

    this.url = opts.url;
    this.log = opts.log;

    var restifyOpts = {
        followRedirects: true,
        log: this.log,
        url: this.url
    };

    this.client = new restifyClients.JsonClient(restifyOpts);
    this.httpClient = new restifyClients.HttpClient(restifyOpts);

    this.log.info({client: this.client.url}, 'The client url');
    this.basepath = this.client.url.path;
    // The imagespath location is for the "images.json" file, but it's value
    // comes from the index.json file.
    this.imagespath = null;
}

LxdClient.prototype._makePath = function _makePath(suffix) {
    if (suffix.match(/^\w+:\/\//)) {
        // Already a url
        return suffix;
    }
    if (suffix[0] === '/') {
        // An absolute path - leave as is.
        return suffix;
    }
    // A relative path - adjust to an absolute path.
    return path.join(this.basepath, suffix);
};

LxdClient.prototype._makeHttpRequest =
function _makeHttpRequest(location, opts, callback) {
    var self = this;

    if (typeof (opts) === 'function') {
        callback = opts;
        opts = {};
    }

    if (!opts.numRedirectsHandled) {
        opts.numRedirectsHandled = 0;
    }

    console.log('Requesting: ', self._makePath(location));

    self.httpClient.get(self._makePath(location), function _getCb(err, req) {
        if (err) {
            callback(err);
            return;
        }

        req.on('error', function _onHttpError(reqErr) {
            callback(reqErr);
            return;
        });

        req.on('result', function _onHttpResult(reqErr, res) {
            if (reqErr) {
                callback(reqErr);
                return;
            }

            callback(null, req, res);
        });

        req.on('redirect', function _onHttpRedirect(res) {
            if (!res.headers.location) {
                callback(new restifyErrors.InvalidContentError(
                    'Invalid server response - no redirect location'));
                return;
            }

            opts.numRedirectsHandled += 1;

            if (opts.numRedirectsHandled >= self.httpClient.maxRedirects) {
                var msg = 'Aborted after %s redirects';
                var redirectErr = new restifyErrors.TooManyRequestsError(
                    msg, opts.numRedirectsHandled);
                callback(redirectErr, req, res);
                return;
            }

            self._makeHttpRequest(res.headers.location, opts, callback);
        });
    });
};

LxdClient.prototype.getIndex = function getIndex(callback) {
    this.client.get(this._makePath(INDEX_JSON_PATH),
            function _getIndexJsonCb(err, req, res, body) {
        if (err) {
            callback(err);
            return;
        }

        var index = body && body.index;
        if (typeof (index) !== 'object') {
            callback(new restifyErrors.InvalidContentError(
                'Invalid server response - no index found'));
            return;
        }

        callback(null, index);
    });
};

LxdClient.prototype.getImageDownloads = function getImageDownloads(callback) {
    this.getIndex(function _onGetIndexCb(err, index) {
        if (err) {
            callback(err);
            return;
        }

        var keys = Object.keys(index);
        var img;

        for (var i = 0; i < keys.length; i++) {
            img = index[keys[i]];
            if (img.datatype === 'image-downloads') {
                callback(null, img);
                return;
            }
        }

        callback(new restifyErrors.InvalidContentError(
            'Invalid server response - no image downloads found'));
    });
};

LxdClient.prototype._getImagesPath = function _getImagesPath(callback) {
    var self = this;

    if (self.imagespath !== null) {
        callback(null, self.imagespath);
        return;
    }

    self.getImageDownloads(function _getIndexCb(err, imgD) {
        if (err) {
            callback(err);
            return;
        }

        if (!imgD.path) {
            callback(new restifyErrors.InvalidContentError(
                'Invalid server response - no image path found in the index'));
            return;
        }

        self.imagespath = imgD.path;
        callback(null, self.imagespath);
    });
};

/**
 * Returns an array of image objects.
 *
 * @param {Function} callback (err, imagesArray)
 */
LxdClient.prototype.getImages = function getImages(callback) {
    var self = this;

    this._getImagesPath(function _onGetImgPath(pathErr, imgPath) {
        if (pathErr) {
            callback(pathErr);
            return;
        }

        self.client.get(self._makePath(imgPath),
                function _getImageJsonCb(err, req, res, body) {
            if (err) {
                callback(err);
                return;
            }

            var products = body && body.products;
            if (typeof (products) !== 'object') {
                callback(new restifyErrors.InvalidContentError(
                    'Invalid server response - no products found'));
                return;
            }

            var images = Object.keys(products).map(function (fullname) {
                var image = products[fullname];
                image.fullname = fullname;
                return image;
            });

            callback(null, images);
        });
    });
};

LxdClient.prototype.getImage = function getImage(alias, callback) {
    this.getImages(function _getImagesCb(err, images) {
        if (err) {
            callback(err);
            return;
        }

        // Find the image by checking for an alias match.
        var img = images.find(function (img_) {
            // Aliases are comma separated (string), but only split it up when
            // there is the chance of a match.
            return img_.aliases.indexOf(alias) >= 0 &&
                img_.aliases.split(',').indexOf(alias) >= 0;
        });

        if (img) {
            img.alias = alias;
            // populate .bestFile
            try {
                getImageBestFile(img);
            } catch (ex) {
                callback(ex);
                return;
            }

            callback(null, img);
            return;
        }

        callback(new restifyErrors.NotFoundError('Image %s was not found',
            alias));
    });
};

function isCombinedImage(img) {
    return img.bestFile.ftype === 'lxd_combined.tar.gz';
}

function getImageBestFile(img, version) {
    var bestFile, maniFile;

    // XXX I'm not sure how you can even choose a version through lxc client?
    if (img.bestFile) {
        return img.bestFile;
    }

    if (!version) {
        // Take the newest (largest) version.
        version = Object.keys(img.versions).sort().slice(-1)[0];
    }

    if (!img.versions || !img.versions[version] ||
            !img.versions[version].items) {
        throw new restifyErrors.NotFoundError(
            'Version %s not found in image %s', version, img.fullname);
    }

    img.chosenVersion = version;

    // An image can have multiple items/formats - so find the best format
    // (according to lxd), see:
    // JSSTYLED
    // https://github.com/lxc/lxd/blob/1915b481efb070e72ef9cd6e2a146d2d29340249/shared/simplestreams/sort.go#L52
    var items = img.versions[version].items;

    if (items.hasOwnProperty('lxd_combined.tar.gz')) {
        bestFile = items['lxd_combined.tar.gz'];
        maniFile = bestFile;
        maniFile.fingerprint = bestFile.sha256;

    } else {
        maniFile = items['lxd.tar.xz'];
        if (!maniFile) {
            throw new restifyErrors.InvalidContentError(
                'No "lxd.tar.gz" item found for image %s', img.fullname);
        }

        bestFile = items['squashfs'] || items['root.tar.xz'] ||
            items['disk-kvm.img'] || items['uefi1.img'] || items['disk1.img'];

        if (!bestFile) {
            throw new restifyErrors.InvalidContentError(
                'No filesystem found for image %s', img.fullname);
        }

        if (bestFile.ftype === 'root.tar.xz') {
            if (maniFile.lxdhashsha256rootxz) {
                maniFile.fingerprint = maniFile.combined_rootxz_sha256;
            } else {
                maniFile.fingerprint = maniFile.combined_sha256;
            }
        } else if (bestFile.ftype == 'squashfs') {
            maniFile.fingerprint = maniFile.combined_squashfs_sha256;
        } else if (bestFile.ftype == 'disk-kvm.img') {
            maniFile.fingerprint = maniFile['combined_disk-kvm-img_sha256'];
        } else if (bestFile.ftype == 'disk1.img') {
            maniFile.fingerprint = maniFile['combined_disk1-img_sha256'];
        } else if (bestFile.ftype == 'uefi1.img') {
            maniFile.fingerprint = maniFile['combined_uefi1-img_sha256'];
        } else {
            throw new restifyErrors.InternalError(
                'No fingerprint for image "%s" with ftype "%s"',
                img.fullname, bestFile.ftype);
        }
    }

    console.log(JSON.stringify(bestFile, null, 2));

    assert.object(bestFile, 'bestFile');
    assert.object(maniFile, 'maniFile');
    assert.string(maniFile.fingerprint, 'maniFile.fingerprint');

    // Cache it.
    img.bestFile = bestFile;
    img.manifestFile = maniFile;

    return bestFile;
}

LxdClient.prototype.getFileStreamForPath =
function getFileStreamForPath(filePath, callback) {
    assert.string(filePath, 'filePath');

    this._makeHttpRequest(filePath, function _onHttpResponse(err, req, res) {
        if (res && !err) {
            res.pause();
        }
        callback(err, res);
    });
};

//---- exports

module.exports = {
    DEFAULT_REGISTRIES: DEFAULT_REGISTRIES,
    LxdClient: LxdClient,
    isCombinedImage: isCombinedImage
};

//---- cmdline

if (require.main === module) {
    var bunyan = require('bunyan');
    var fs = require('fs');
    var tmp = require('tmp');

    var log = bunyan.createLogger({
        level: (process.env['LOG_LEVEL'] || 'debug'),
        name: 'lxd images'
    });
    var lxdOpts = {
        log: log,
        url: 'https://us.images.linuxcontainers.org'
        // url: 'https://cloud-images.ubuntu.com/releases'
    };
    var wantedImage = 'alpine/3.12';
    // var wantedImage = 'ubuntu:focal:amd64:default';
    // var wantedImage = 'com.ubuntu.cloud:server:20.10:amd64';
    // var wantedImage = 'f';

    var client = new LxdClient(lxdOpts);
    client.getImageDownloads(function (err, images) {
        if (err) {
            console.error(err);
            return;
        }

        var foundImage = (images.products || []).indexOf(wantedImage) >= 0;
        console.log(util.format('Index contains %s: %s', wantedImage,
            foundImage));

        client.getImage(wantedImage, function _onGetImageCb(getImageErr, img) {
            if (getImageErr) {
                console.trace('Get image error:', getImageErr);
                return;
            }

            log.trace({image: img}, 'getImage');
            // console.log(JSON.stringify(img, null, 2));

            // var manifest = imgManifestFromImg(img, {repo: lxdOpts.url});
            // console.log(JSON.stringify(manifest, null, 2));

            var item = img.bestFile;
            assert.object(item, 'item');

            client.getFileStreamForPath(item.path,
                    function _fileStreamCb(getFileErr, stream) {
                if (getFileErr) {
                    console.error(getFileErr);
                    return;
                }

                tmp.file({keep: true}, function _onTmpCb(tmpErr, fpath, fd) {
                    if (tmpErr) {
                        console.error(tmpErr);
                        return;
                    }

                    log.debug({ftype: item.ftype, path: fpath, size: item.size},
                        'writing file...');
                    var writeStream = fs.createWriteStream(null, {fd: fd});
                    stream.pipe(writeStream);
                });
            });
        });
    });
}
