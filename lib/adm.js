/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * The cmdln class for the `imgapiadm` CLI to administer an IMGAPI.
 */


var assert = require('assert-plus');
var bunyan = require('bunyan');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;
var crypto = require('crypto');
var fs = require('fs');
var lib_uuid = require('uuid');
var mkdirp = require('mkdirp');
var path = require('path');
var ProgressBar = require('progbar').ProgressBar;
var restify = require('restify');
var sdcClients = require('sdc-clients');
var sprintf = require('extsprintf').sprintf;
var util = require('util'),
    format = util.format;
var vasync = require('vasync');
var verror = require('verror'),
    VError = verror.VError,
    MultiError = verror.MultiError;

var magic = require('./magic');
var storage = require('./storage');
var utils = require('./utils'),
    spawnRun = utils.spawnRun;



//---- globals

var p = console.log;
var pkg = require('../package.json');

var CONFIG_PATH = '/data/imgapi/etc/imgapi.config.json';
var UA = format('imgapiadm/%s', pkg.version);



//---- Adm class

function Adm() {
    Cmdln.call(this, {
        name: 'imgapiadm',
        desc: 'Administer the IMGAPI service',
        options: [
            {names: ['help', 'h'], type: 'bool', help: 'Print help and exit.'},
            {name: 'version', type: 'bool', help: 'Print version and exit.'},
            {names: ['verbose', 'v'], type: 'bool',
                help: 'Verbose/debug output.'}
        ],
        helpOpts: {
            includeEnv: true,
            minHelpCol: 27 /* line up with option help */
        }
    });
}
util.inherits(Adm, Cmdln);

Adm.prototype.init = function init(opts, args, callback) {
    var self = this;

    self.log = bunyan.createLogger({
        name: this.name,
        src: Boolean(opts.verbose),
        streams: [
            {
               stream: process.stderr,
                level: Boolean(opts.verbose) ? 'trace' : 'warn'
            }
        ],
        serializers: restify.bunyan.serializers
    });

    // Log the invocation args (trim out dashdash meta vars).
    var trimmedOpts = utils.objCopy(opts);
    delete trimmedOpts._args;
    delete trimmedOpts._order;
    this.log.debug({opts: trimmedOpts, args: args, cli: true}, 'cli init');

    /**
     * Call this to emit a progress message to the "user" on stdout.
     * Takes args like `console.log(...)`.
     */
    this.print = function print() {
        var args_ = Array.prototype.slice.call(arguments);
        self.log.debug.apply(self.log, [ {progress: true} ].concat(args_));
        console.log.apply(null, args_);
    };

    if (opts.version) {
        p('%s %s', self.name, pkg.version);
        return callback(false);
    }

    var req_id = lib_uuid.v4();
    Object.defineProperty(this, 'imgapi', {
        get: function () {
            if (self._imgapi === undefined) {
                self._imgapi = new sdcClients.IMGAPI({
                    url: 'http://localhost',
                    agent: false,
                    userAgent: UA,
                    log: self.log,
                    headers: {
                        'x-request-id': req_id
                    }
                });
            }
            return self._imgapi;
        }
    });
    Object.defineProperty(this, 'config', {
        get: function () {
            if (self._config === undefined) {
                self._config = JSON.parse(fs.readFileSync(CONFIG_PATH));
                // We don't want the WFAPI integration/setup for our App inst.
                delete self._config.wfapi;
            }
            return self._config;
        }
    });

    // Cmdln class handles `opts.help`.
    Cmdln.prototype.init.call(this, opts, args, function (err) {
        if (err || err === false) {
            return callback(err);
        }
        callback();
    });
};


/**
 * Finalize the command call before exiting: log exit status, flush logs.
 */
Adm.prototype.fini = function fini(subcmd, err, cb) {
    if (this.opts && this.opts.verbose) {
        this.showErrStack = true; // turn this on for `cmdln.main()`
    }

    if (this.log) {  // On an early error we might not have `log`.
        var exitStatus = (err ? err.exitStatus || 1 : 0);
        var logLevel = 'debug';
        if (err && this.opts && this.opts.verbose) {
            logLevel = 'error';
        }
        this.log[logLevel]({subcmd: subcmd, exitStatus: exitStatus, cli: true},
            'cli exit');
    }

    cb();
};


Adm.prototype.do_check_files =
function do_check_files(subcmd, opts, args, cb) {
    var self = this;
    var log = self.log;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var cachePath = '/data/imgapiadm/cache/check-files.json';
    function saveCacheSync(obj) {
        var dir = path.dirname(cachePath);
        if (! fs.existsSync(dir)) {
            mkdirp.sync(dir);
        }
        fs.writeFileSync(cachePath, JSON.stringify(obj, null, 4));
    }

    function msgFromFileCheckErr(img, err, imgFromUuid, imgsFromOrigin) {
        assert.object(img, 'img');
        assert.object(err, 'err');
        assert.object(imgFromUuid, 'imgFromUuid');
        assert.object(imgsFromOrigin, 'imgsFromOrigin');
        var i, j;

        /*
         *  Image: ff95621f-33c1-84c0-692f-941d478dd8dc (foo@1.2.3)
         *  State: image file corruption
         * Reason: invalid size (...)
         *    See: https://smartos.org/bugview/IMGAPI-???
         *    Fix: # Delete image and its offspring for re-import
         *    Fix: sdc-imgadm delete $uuid1
         *    Fix: sdc-imgadm delete $uuid1b
         *    Fix: sdc-imgadm delete ff95621f-33c1-84c0-692f-941d478dd8dc
         * Impact: Provisioning with head image $uuid1 will fail
         * Impact: Provisioning with head image $uuid2 will fail
         */
        var lines = [];
        var template = '%s: %s';
        lines.push(sprintf(template, ' Image', format('%s (%s@%s)',
            img.uuid, img.name, img.version)));
        lines.push(sprintf(template, ' State', 'image file corruption'));
        lines.push(sprintf(template, 'Reason', err.message));
        lines.push(sprintf(template, '   See',
            'https://smartos.org/bugview/IMGAPI-515'));

        // Find all the offspring for this image, i.e. all those using this
        // image as an 'origin'. The will all need to be deleted to delete
        // the corrupted image.
        lines.push(sprintf(template, '   Fix',
            '# Delete image and its offspring for re-import'));
        var imgsToDel = [img];
        var currGeneration = [img];
        while (true) {
            var newGeneration = [];
            for (i = 0; i < currGeneration.length; i++) {
                var origin = currGeneration[i].uuid;
                var imgs = imgsFromOrigin[origin];
                if (imgs) {
                    for (j = 0; j < imgs.length; j++) {
                        imgsToDel.push(imgs[j]);
                        newGeneration.push(imgs[j]);
                    }
                }
            }
            if (newGeneration.length === 0) {
                break;
            }
            currGeneration = newGeneration;
        }
        imgsToDel.reverse();
        for (i = 0; i < imgsToDel.length; i++) {
            lines.push(sprintf(template, '   Fix',
                'sdc-imgadm delete ' + imgsToDel[i].uuid));
        }

        for (i = 0; i < currGeneration.length; i++) {
            var cimg = currGeneration[i];
            lines.push(sprintf(template, 'Impact',
                sprintf('Provisioning with head image %s (%s@%s) will fail',
                    cimg.uuid, cimg.name, cimg.version)));
        }

        return lines.join('\n');
    }


    vasync.pipeline({arg: {}, funcs: [
        // If `args` is given *and* there are no errors, then we technically
        // don't need `allImgs`. Not bothering being lazy though.
        function ctxAllImgs(ctx, next) {
            self.imgapi.listImages({}, {
                inclAdminFields: true
            }, function (err, allImgs) {
                if (err) {
                    return next(err);
                }
                ctx.allImgs = allImgs;
                ctx.imgFromUuid = {};
                ctx.imgsFromOrigin = {};
                for (var i = 0; i < allImgs.length; i++) {
                    var img = allImgs[i];
                    ctx.imgFromUuid[img.uuid] = img;
                    if (img.origin) {
                        if (!ctx.imgsFromOrigin[img.origin]) {
                            ctx.imgsFromOrigin[img.origin] = [];
                        }
                        ctx.imgsFromOrigin[img.origin].push(img);
                    }
                }
                next();
            });
        },

        function ctxImgs(ctx, next) {
            if (args.length > 0) {
                ctx.imgs = [];
                vasync.forEachParallel({
                    inputs: args,
                    func: function imgFromUuid(uuid, nextUuid) {
                        self.imgapi.getImage(uuid, {
                            inclAdminFields: true
                        }, function (err, img) {
                            if (!err) {
                                ctx.imgs.push(img);
                            }
                            nextUuid(err);
                        });
                    }
                }, next);
            } else {
                ctx.imgs = ctx.allImgs;
                next();
            }
        },

        function loadCache(ctx, next) {
            if (!fs.existsSync(cachePath)) {
                ctx.checkInfoFromImgUuid = {};
                return next();
            }
            ctx.checkInfoFromImgUuid = JSON.parse(fs.readFileSync(cachePath));
            next();
        },

        function filterAlreadyCheckedFiles(ctx, next) {
            if (opts.force) {
                return next();
            }

            var filtered = [];
            for (var i = 0; i < ctx.imgs.length; i++) {
                var img = ctx.imgs[i];
                var checkInfo = ctx.checkInfoFromImgUuid[img.uuid];
                if (!checkInfo) {
                    filtered.push(img);
                } else if (checkInfo.size !== img.files[0].size ||
                    checkInfo.sha1 !== img.files[0].sha1)
                {
                    filtered.push(img);
                }
            }
            log.info('%d of %d images have not yet been checked',
                filtered.length, ctx.imgs.length);
            ctx.imgs = filtered;
            next();
        },

        function ctxTodos(ctx, next) {
            ctx.todos = [];
            var localStor = new storage.local({
                log: self.log,
                config: self.config
            });
            for (var i = 0; i < ctx.imgs.length; i++) {
                var img = ctx.imgs[i];
                if (!img.files || !img.files[0]) {
                    log.debug({img: img}, 'skip image: no files');
                } else if (img.files[0].stor !== 'local') {
                    log.debug({img: img},
                        'skip image: file not stor=local (limitation)');
                } else {
                    ctx.todos.push({
                        img: img,
                        stor: 'local',
                        path: localStor.storPathFromImageUuid(
                            img.uuid, 'file0')
                    });
                }
            }
            log.info('%d of %d are locally stored (image files in manta '
                + 'cannot yet be checked)', ctx.todos.length, ctx.imgs.length);
            next();
        },

        function checkFiles(ctx, next) {
            log.info('Checking %d image files corruption',
                ctx.todos.length);
            var bar = new ProgressBar({
                filename: format('Checking %s image files', ctx.todos.length),
                size: ctx.todos.length
            });
            ctx.errs = [];
            vasync.forEachPipeline({
                inputs: ctx.todos,
                func: function oneTodo(todo, nextTodo) {
                    assert.equal(todo.stor, 'local'); // current limitation
                    var uuid = todo.img.uuid;
                    self._checkLocalImageFile({
                        manifest: todo.img,
                        path: todo.path
                    }, function (err) {
                        bar.advance(1);
                        if (err) {
                            ctx.errs.push(err);
                            self.log.debug(err, '_checkLocalImageFile err');

                            // TODO no multiline <progbar>.log(msg) currently
                            if (ctx.errs.length !== 1) {
                                bar.log('', process.stdout);
                            }
                            var lines = msgFromFileCheckErr(
                                todo.img, err, ctx.imgFromUuid,
                                ctx.imgsFromOrigin).split(/\n/g);
                            lines.forEach(function (line) {
                                bar.log(line, process.stdout);
                            });

                            if (ctx.checkInfoFromImgUuid[uuid]) {
                                delete ctx.checkInfoFromImgUuid[uuid];
                                saveCacheSync(ctx.checkInfoFromImgUuid);
                            }
                        } else {
                            ctx.checkInfoFromImgUuid[todo.img.uuid] = {
                                uuid: todo.img.uuid,
                                size: todo.img.files[0].size,
                                sha1: todo.img.files[0].sha1
                            };
                            saveCacheSync(ctx.checkInfoFromImgUuid);
                        }
                        nextTodo();
                    });
                }
            }, function (err) {
                bar.end();
                next(err);
            });
        },

        function returnErrs(ctx, next) {
            if (ctx.errs.length) {
                self.showErr = false;
                var err = new MultiError(ctx.errs);
                err.exitStatus = ctx.errs.length;
                next(err);
            } else {
                next();
            }
        }
    ]}, cb);
};
Adm.prototype.do_check_files.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['force', 'f'],
        type: 'bool',
        help: 'Do not skip image files that have already been checked.'
    }
];
Adm.prototype.do_check_files.help = (
    'Check integrity of image files.\n' +
    '\n' +
    'Limitation: Currently this only supports stor=local image files.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} check-files [<options>]\n' +
    '\n' +
    '{{options}}'
);


Adm.prototype._checkLocalImageFile = function _checkLocalImageFile(opts, cb) {
    assert.string(opts.path, 'opts.path');
    assert.object(opts.manifest, 'opts.manifest');
    assert.func(cb, 'cb');

    var self = this;
    var manFile = opts.manifest.files[0];

    vasync.pipeline({arg: {}, funcs: [
        function ctxStats(ctx, next) {
            fs.stat(opts.path, function (err, stat) {
                ctx.stat = stat;
                next(err);
            });
        },

        function checkSize(ctx, next) {
            if (ctx.stat.size !== manFile.size) {
                next(new Error('invalid size (actual %s != manifest %s)',
                    ctx.stat.size, manFile.size));
            } else {
                next();
            }
        },

        function ctxChecksums(ctx, next) {
            var sha1Hash = crypto.createHash('sha1');
            var stream = fs.createReadStream(opts.path);
            stream.on('data', function (chunk) {
                sha1Hash.update(chunk);
            });
            stream.on('close', function () {
                ctx.sha1 = sha1Hash.digest('hex');
                next();
            });
        },

        function checkSha1(ctx, next) {
            if (ctx.sha1 !== manFile.sha1) {
                next(new Error('invalid sha1 (actual %s != manifest %s)',
                    ctx.sha1, manFile.sha1));
            } else {
                next();
            }
        },

        function ctxCompression(ctx, next) {
            magic.compressionTypeFromPath(opts.path, function (err, cType) {
                if (err) {
                    next(err);
                    return;
                }
                ctx.compression = cType; // one of: null, bzip2, gzip, xz
                next();
            });
        },

        function testArchive(ctx, next) {
            if (!ctx.compression) {
                return next();
            }

            var cmd;
            switch (ctx.compression) {
            case 'gzip':
                cmd = '/usr/bin/gzip';
                break;
            case 'bzip2':
                cmd = '/opt/local/bin/bzip2';
                break;
            case 'xz':
                cmd = '/opt/local/bin/xz';
                break;
            default:
                throw VError('unknown compression: ' + ctx.compression);
            }

            spawnRun({
                argv: [cmd, '-t', opts.path],
                log: self.log
            }, function (err, stdout, stderr) {
                if (err) {
                    next(new Error('invalid ' + ctx.compression + ' archive'));
                } else {
                    next();
                }
            });
        }
    ]}, cb);
};



//---- exports

module.exports = Adm;
