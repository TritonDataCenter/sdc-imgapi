#!/usr/bin/env node
/**
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Load some play/dev data for IMGAPI play.
 *
 * Usage:
 *    ./tools/bootstrap.js HEADNODE-HOST-OR-IP
 *
 * Example:
 *    ./tools/bootstrap.js root@10.99.99.7   # COAL
 *
 * This will:
 * - create test users: elmo (a user) and oscar (an operator)
 */

var log = console.error;
var fs = require('fs');
var path = require('path');
var child_process = require('child_process'),
    exec = child_process.exec;
var format = require('util').format;

var async = require('async');
var sdcClients = require('sdc-clients'),
  UFDS = sdcClients.UFDS;



//---- globals and constants

var headnodeAlias;
var headnodeConfig;
var elmo = JSON.parse(fs.readFileSync(__dirname + '/user-elmo.json', 'utf8'));
var oscar = JSON.parse(fs.readFileSync(__dirname + '/user-oscar.json', 'utf8')); // operator
var ufdsClient;

// We can presume the user has a `node` on the PATH, right? Don't want to
// use 'build/node/bin/node' to allow this script to run on Mac.
var JSONTOOL = path.resolve(__dirname, '../node_modules/.bin/json');



//---- prep steps

function parseArgs(next) {
  headnodeAlias = process.argv[2]; // intentionally global
  if (!headnodeAlias) {
    log('bootstrap: error: no headnode alias was given as an argument\n'
      + '\n'
      + 'Usage:\n'
      + '   ./tools/bootstrap.js HEADNODE\n'
      + '\n'
      + 'Where HEADNODE is an ssh-able string to the headnode gz.\n');
    process.exit(1);
  }

  log('# Headnode alias/host/IP is "%s".', headnodeAlias);
  next();
}

function getHeadnodeConfig(next) {
  log('# Getting headnode config.');
  exec(format('ssh %s bash /lib/sdc/config.sh -json', headnodeAlias),
    function (err, stdout, stderr) {
      //console.log('stdout: ' + stdout);
      //console.log('stderr: ' + stderr);
      if (err !== null) {
        //console.log('exec error: ' + error);
        return next(err);
      }
      headnodeConfig = JSON.parse(stdout); // intentionally global
      next();
    }
  );
}

function ufdsClientBind(next) {
  log("# Create UFDS client and bind.")
  var ufdsIp = headnodeConfig.ufds_admin_ips.split(',')[0];
  var ufdsUrl = format("ldaps://%s:636", ufdsIp);
  ufdsClient = new UFDS({
    url: ufdsUrl,
    bindDN: headnodeConfig.ufds_ldap_root_dn,
    bindPassword: headnodeConfig.ufds_ldap_root_pw
  });
  ufdsClient.on('ready', function() {
    next();
  })
  ufdsClient.on('error', function(err) {
    next(err);
  })
}

function createUser(userData, next) {
  ufdsClient.getUser(userData.login, function (err, user) {
    if (user) {
      log("# User %s already exists.", user.login);
      return next(null, user);
    } else if (err.httpCode === 404) {
      log("# Create %s.", userData.login);
      ufdsClient.addUser(userData, next);
    } else {
      return next(err);
    }
  });
}

function createUsers(next) {
  log("# Create users.")
  async.map([elmo, oscar], createUser, function(err, _){
    next(err)
  });
}

function makeOscarAnOperator(next) {
  var dn = format("uuid=%s, ou=users, o=smartdc", oscar.uuid);
  var change = {
    type: 'add',
    modification: {
      uniquemember: dn,
    }
  };
  log("# Make user %s an operator.", oscar.login);
  ufdsClient.modify('cn=operators, ou=groups, o=smartdc', change, function (err) {
    next(err);
  });
}

function ufdsClientClose(next) {
  log("# Unbind UFDS client.")
  if (ufdsClient) {
    ufdsClient.close(next);
  } else {
    next();
  }
}



//---- mainline

async.series([
    parseArgs,
    getHeadnodeConfig,
    ufdsClientBind,
    createUsers,
    makeOscarAnOperator,
    ufdsClientClose,
  ],
  function (err) {
    if (err) {
      log('error bootstrapping:', (err.stack || err));
      process.exit(1);
    }
    log("# Done.")
  }
);
