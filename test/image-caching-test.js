/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Test manta image caching.
 */

var p = console.log;
//var p = function () {};
var childprocess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var async = require('async');
var format = require('util').format;
var IMGAPI = require('sdc-clients').IMGAPI;


// node-tap API
if (require.cache[__dirname + '/tap4nodeunit.js'])
    delete require.cache[__dirname + '/tap4nodeunit.js'];
var tap4nodeunit = require('./tap4nodeunit.js');
var after = tap4nodeunit.after;
var before = tap4nodeunit.before;
var test = tap4nodeunit.test;

var busyboxImage;


//---- tests

before(function (next) {
    this.client = new IMGAPI({url: process.env.IMGAPI_URL, agent: false});
    next();
});



/**
 * Test basics of local image filecache for manta.
 */
test('FileCache basics', function (t) {
    //t.done();
    //return; // XXX

    var self = this;
    var initState;

    function clearCache(next) {
        childprocess.exec('curl -isS ' + process.env.IMGAPI_URL
                            + '/state?action=dropcaches -X POST >/dev/null',
                            next);
    }
    function getInitialState(stdout, stderr, next) {
        self.client.adminGetState(function (err, state, res) {
            t.ifError(err, 'adminGetState err: ', err);
            initState = state;
            p('initialState: ', initState);
            next(err);
        });
    }
    function findImageUuid(next) {
        if (typeof (busyboxImage) !== 'undefined') {
            return next();
        }
        p('findImageUuid');
        self.client.listImages(function (err, images) {
            t.ifError(err, 'ListImages err: ', err);
            t.ok(images, 'images');
            t.ok(Array.isArray(images), 'images');
            var busyboxImages = images.filter(function (image) {
                return image.type == 'docker' &&
                        image.tags['docker:repo'] == 'busybox';
            });
            busyboxImage = busyboxImages[0];
            //p('busyboxImage: ', busyboxImage);
            next(err);
        });
    }
    function getDockerBusyboxImage(next) {
        if (typeof (busyboxImage) !== 'undefined') {
            return next();
        }
        p('getDockerBusyboxImage');
        var opts = {
             /*
              * All sdc-docker pull images are owned by and private to 'admin'.
              * It is sdc-docker code that gates access to all the images.
              */
             public: false,
             repo: 'docker.io/busybox',
             tag: 'latest'
         };
         self.client.adminImportDockerImage(opts, function (err, res) {
            t.ifError(err, err);
            if (err) {
                next(err);
                return;
            }
            res.on('data', function (data) {
                var d = JSON.parse(data);
                if (d['type'] === 'data' && 'imgJson' in d) {
                    busyboxImage = d['image'];
                }
            });
            res.on('error', function (entry) {
                p('error: ', entry);
            });
            res.on('end', next);
         });
    }
    function getImage(next) {
        p('getImage');
        self.client.getImage(busyboxImage.uuid, function (err, image, res) {
            //p('image tags: ', image && image.tags);
            t.ifError(err, err);
            t.ok(image);
            t.ok(image.tags);
            t.equal(image.tags['docker:repo'], 'busybox');
            next(err);
        });
    }
    function getFile(next) {
        p('getFile');
        var tmpFilePath = format('/var/tmp/imgapi-test-file-%s.zfs.bz2',
                                process.pid);
        self.client.getImageFile(busyboxImage.uuid, tmpFilePath,
                                function (err, res) {
            try {
                t.ifError(err, err);
                next(err);
            } finally {
                if (fs.existsSync(tmpFilePath)) {
                    fs.unlinkSync(tmpFilePath);
                }
            }
        });
    }
    function checkState1(next) {
        p('checkState1');
        self.client.adminGetState(function (err, state, res) {
            t.ifError(err, 'adminGetState err: ', err);
            p('state1: ', state);

            var filecache = state.filecache;
            //t.ok(filecache.stats.misses > initState.filecache.stats.misses,
            //     'expected filecache misses to have increased');
            t.ok(filecache.stats.hits > initState.filecache.stats.hits,
                 'expected filecache hits to have increased');

            var cachePath = filecache.keys.filter(function (key) {
                return key.indexOf(busyboxImage.uuid) >= 0;
            });
            t.ok(cachePath, 'expected to find busybox uuid '
                            + busyboxImage.uuid
                            + ' in filecache keys: '
                            + filecache.keys);

            next(err);
        });
    }
    function getFileAgain(next) {
        p('getFileAgain');
        var tmpFilePath = format('/var/tmp/imgapi-test-file-%s.zfs.bz2',
                                process.pid);
        self.client.getImageFile(busyboxImage.uuid, tmpFilePath,
                                function (err, res) {
            try {
                t.ifError(err, err);
                next(err);
            } finally {
                if (fs.existsSync(tmpFilePath)) {
                    fs.unlinkSync(tmpFilePath);
                }
            }
        });
    }
    function checkState2(next) {
        p('checkState2');
        self.client.adminGetState(function (err, state, res) {
            t.ifError(err, 'adminGetState err: ', err);
            p('state2: ', state);

            var filecache = state.filecache;
            t.ok(filecache.stats.hits > initState.filecache.stats.hits,
                 'expected filecache hits to have increased');

            var cachePath = filecache.keys.filter(function (key) {
                return key.indexOf(busyboxImage.uuid) >= 0;
            });
            t.ok(cachePath, 'expected to find busybox uuid '
                            + busyboxImage.uuid
                            + ' in filecache keys: '
                            + filecache.keys);

            next(err);
        });
    }

    async.waterfall(
        [
            clearCache,
            getInitialState,
            findImageUuid,
            getDockerBusyboxImage,
            getImage,
            getFile,
            checkState1,
            getFileAgain,
            checkState2
        ],
        function (err) {
            if (err) {
                p('test error', err);
            }
            t.end();
        }
    );
});



/**
 * Test limits for local image filecache.
 */
test('FileCache limits', function (t) {
    //t.end();
    //return;

    var self = this;
    var lastState;

    function clearCache(next) {
      try {
        p('clearCache', arguments);
        childprocess.exec('curl -isS ' + process.env.IMGAPI_URL
                            + '/state?action=dropcaches -X POST >/dev/null',
                            function (err, stdout, stderr)
        {
            next(err);
        });
      } catch (ex) {
        next(ex);
      }
    }
    function findImageUuid(next) {
      try {
        if (typeof (busyboxImage) !== 'undefined') {
            return next();
        }
        p('findImageUuid');
        self.client.listImages(function (err, images) {
            t.ifError(err, 'ListImages err: ', err);
            t.ok(images, 'images');
            t.ok(Array.isArray(images), 'images');
            var busyboxImages = images.filter(function (image) {
                return image.type == 'docker' &&
                        image.tags['docker:repo'] == 'busybox';
            });
            busyboxImage = busyboxImages[0];
            //p('busyboxImage: ', busyboxImage);
            next(err);
        });
      } catch (ex) {
        next(ex);
      }
    }
    function getDockerBusyboxImage(next) {
      try {
        if (typeof (busyboxImage) !== 'undefined') {
            return next();
        }
        p('getDockerBusyboxImage');
        var opts = {
             /*
              * All sdc-docker pull images are owned by and private to 'admin'.
              * It is sdc-docker code that gates access to all the images.
              */
             public: false,
             repo: 'docker.io/busybox',
             tag: 'latest'
         };
         self.client.adminImportDockerImage(opts, function (err, res) {
            t.ifError(err, err);
            if (err) {
                next(err);
                return;
            }
            res.on('data', function (data) {
                var d = JSON.parse(data);
                if (d['type'] === 'data' && 'imgJson' in d) {
                    busyboxImage = d['image'];
                }
            });
            res.on('error', function (entry) {
                p('error: ', entry);
            });
            res.on('end', next);
         });
      } catch (ex) {
        next(ex);
      }
    }
    function getFile(next) {
      try {
        p('getFile');
        var tmpFilePath = format('/var/tmp/imgapi-test-file-%s.zfs.bz2',
                                process.pid);
        self.client.getImageFile(busyboxImage.uuid, tmpFilePath,
                                function (err, res) {
            try {
                t.ifError(err, err);
                next(err);
            } finally {
                if (fs.existsSync(tmpFilePath)) {
                    fs.unlinkSync(tmpFilePath);
                }
            }
        });
      } catch (ex) {
        next(ex);
      }
    }
    function checkState1(next) {
      try {
        p('checkState1');
        self.client.adminGetState(function (err, state, res) {
            t.ifError(err, 'adminGetState err: ', err);
            p('state1: ', state);

            var filecache = state.filecache;
            var cachePath = filecache.keys.filter(function (key) {
                return key.indexOf(busyboxImage.uuid) >= 0;
            });
            t.ok(cachePath, 'expected to find busybox uuid '
                            + busyboxImage.uuid
                            + ' in filecache keys: '
                            + filecache.keys);

            lastState = state;
            next(err);
        });
      } catch (ex) {
        next(ex);
      }
    }
    function changeConfig(next) {
      try {
        p('changeConfig', arguments);
        var configPath = path.resolve(__dirname, '../etc/imgapi.config.json');
        p('Loading default config from "%s".', configPath);
        var config = JSON.parse(fs.readFileSync(configPath));
        t.ok(config && config.storage && config.storage.manta,
             'config.storage.manta is missing');

        var filecache = config.storage.manta.filecache;
        t.ok(filecache, 'config filecache is missing');

        //filecache.maxDiskUsage = '1KB';
        filecache.maxDiskUsage = '1';

        p('sending config change');
        var proc = childprocess.exec('curl -isS -d @- ' + process.env.IMGAPI_URL
                            + '/state?action=config -X POST',
                            function (err, stdout, stderr)
        {
            next(err);
        });
        proc.stdin.write(JSON.stringify(config));
        proc.stdin.end();
      } catch (ex) {
        next(ex);
      }
    }
    function checkState2(next) {
      try {
        p('checkState2');
        self.client.adminGetState(function (err, state, res) {
            t.ifError(err, 'adminGetState err: ', err);
            p('state2: ', state);

            var filecache = state.filecache;
            t.ok(filecache.stats.drops >= lastState.filecache.stats.drops,
                 'unexpected, filecache drops have decreased');

            var cachePath = filecache.keys.filter(function (key) {
                return key.indexOf(busyboxImage.uuid) >= 0;
            });
            t.ok(cachePath.length === 0,
                'expected to not find busybox uuid ' + busyboxImage.uuid
                + ' in filecache keys: ' + filecache.keys);

            lastState = state;
            next(err);
        });
      } catch (ex) {
        next(ex);
      }
    }
    function getFileAgain(next) {
      try {
        p('getFileAgain');
        var tmpFilePath = format('/var/tmp/imgapi-test-file-%s.zfs.bz2',
                                process.pid);
        self.client.getImageFile(busyboxImage.uuid, tmpFilePath,
                                function (err, res) {
            try {
                t.ifError(err, err);
                next(err);
            } finally {
                if (fs.existsSync(tmpFilePath)) {
                    fs.unlinkSync(tmpFilePath);
                }
            }
        });
      } catch (ex) {
        next(ex);
      }
    }
    function checkState3(next) {
      try {
        p('checkState3');
        self.client.adminGetState(function (err, state, res) {
            t.ifError(err, 'adminGetState err: ', err);
            p('state3: ', state);

            var filecache = state.filecache;
            t.ok(filecache.stats.misses > lastState.filecache.stats.misses,
                 'expected filecache misses to have increased');

            var cachePath = filecache.keys.filter(function (key) {
                return key.indexOf(busyboxImage.uuid) >= 0;
            });
            t.ok(cachePath.length === 0,
                'expected to not find busybox uuid ' + busyboxImage.uuid
                + ' in filecache keys: ' + filecache.keys);

            next(err);
        });
      } catch (ex) {
        next(ex);
      }
    }

    async.waterfall(
        [
            clearCache,
            findImageUuid,
            getDockerBusyboxImage,
            getFile,
            checkState1,
            changeConfig,
            checkState2,
            getFileAgain,
            checkState3
        ],
        function (err) {
            if (err) {
                p('test error', err);
            }
            // Restart imgadm - to ensure config gets reset.
            childprocess.exec('svcadm restart imgapi',
                            function (childerr, stdout, stderr)
            {
                p('childerr: ', childerr);
                t.ifError(childerr);
                t.end();
            });
        }
    );
});
