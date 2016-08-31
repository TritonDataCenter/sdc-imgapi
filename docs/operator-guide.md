---
title: IMGAPI Operator Guide
markdown2extras: tables, code-friendly, cuddled-lists
apisections:
---

# IMGAPI Operator Guide

This document is a guide for operators of an IMGAPI. There are two main types
of IMGAPI:

1. An instance that is part of the core "imgapi" service in a Triton DataCenter.
   An in-DC IMGAPI is configured with `mode === "dc"`. It servers HTTP over the
   DC's "admin" network. It optionally has a firewalled NIC on an external
   network to be able to reach out (to import from standalone IMGAPIs, or
   pull from Docker registries).

2. A "standalone" IMGAPI, that runs independent of a Triton DataCenter. These
   are configured with `mode === "public"` (for public images, example
   "images.joyent.com") or `mode === "private"` (for repos with private images,
   example "updates.joyent.com"). These server HTTPS over a public network (via
   stud for SSL termination, to HAproxy for possible load balancing, to one or
   more node.js IMGAPI processes). They are typically configured to use HTTP
   Signature auth (like Triton's CloudAPI and Manta's web API) for any write
   endpoints.



# Configuration

Reference docs on configuration of the IMGAPI server. Default values are in
"[/opt/smartdc/imgapi/]etc/defaults.json" in the repository. Custom values
are in a separate JSON configuration file --
"/opt/smartdc/imgapi/etc/imgapi.config.json" by default, but for standalone
servers is at "/data/imgapi/etc/imgapi.config.json" (passed in via `-f
CONFIG-PATH` in the standalone SMF manifest) for persistence on a delegate
dataset.

Note that given custom values override full top-level keys in the factory
settings. For example: if providing 'storage', one must provide the whole
'storage' object.

| var                          | type          | default           | description |
| ---------------------------- | ------------- | ----------------- | ----------- |
| port                         | Number        | 8080              | Port number on which to listen. |
| address                      | String        | 127.0.0.1         | Address on which to listen. |
| serverName                   | String        | IMGAPI/$version   | Name of the HTTP server. This value is present on every HTTP response in the 'server' header. |
| logLevel                     | String/Number | debug             | Level at which to log. One of the supported Bunyan log levels. This is overridden by the `-d,--debug` switch. |
| maxSockets                   | Number        | 100               | Maximum number of sockets for external API calls |
| mode                         | String        | public            | One of 'public' (default, running as a public server e.g. images.joyent.com), 'private' (a ironically "public" server that only houses images marked `public=false`), or 'dc' (running as the IMGAPI in a Triton DataCenter). |
| datacenterName               | String        | -                 | Name of the Triton DataCenter on which IMGAPI is running. Only relevant if `mode === "dc"`. |
| adminUuid                    | String        | -                 | The UUID of the admin user in this Triton DataCenter. Only relevant if `mode === "dc"`. |
| channels                     | Array         | -                 | Set this make this IMGAPI server support [channels](#channels). It must be an array of channel definition objects of the form `{"name": "<name>", "description": "<desc>"[, "default": true]}`. See the example in "etc/imgapi.config.json.in". |
| placeholderImageLifespanDays | Number        | 7                 | The number of days after which a "placeholder" image (one with state 'failed' or 'creating') is purged from the database. |
| allowLocalCreateImageFromVm  | Boolean       | false             | Whether to allow CreateImageFromVm using local storage (i.e. if no manta storage is configured). This should only be enabled for testing. For SDC installations of IMGAPI `"IMGAPI_ALLOW_LOCAL_CREATE_IMAGE_FROM_VM": true` can be set on the metadata for the 'imgapi' SAPI service to enable this. |
| minImageCreationPlatform     | Array         | see defaults.json | The minimum platform version, `["<sdc version>", "<platform build timestamp>"]`, on which the proto VM for image creation must reside. This is about the minimum platform with sufficient `imgadm` tooling. This is used as an early failure guard for [CreateImageFromVm](#CreateImageFromVm). |
| authType                     | String        | signature         | One of 'none' or 'signature' ([HTTP Signature auth](https://github.com/joyent/node-http-signature)). |
| authKeys                     | Object        | -                 | Optional. A mapping of username to an array of ssh public keys. Only used for HTTP signature auth (`config.auth.type === "signature"`). |
| databaseType                 | String        | local             | The database backend type to use. One of "local" or "moray". The latter is what is typically used in-DC. |
| storageTypes                 | Array         | ["local"]         | The set of available storage mechanisms for the image *files*. There must be at least one. Supported values are "local" and "manta". See the [Image file storage](#image-file-storage) section for discussion. |
| manta                        | Object        | -                 | Object holding config information for Manta storage. |
| manta.baseDir                | String        | -                 | The base directory, relative to '/${storage.manta.user}/stor', under which image files are stored in Manta. |
| manta.url                    | String        | -                 | The Manta API URL. |
| manta.insecure               | Boolean       | false             | Ignore SSL certs on the Manta URL. |
| manta.remote                 | Boolean       | -                 | Whether this Manta is remote to this IMGAPI. This helps IMGAPI determine practical issues on whether manta or local storage is used for large files. |
| manta.user                   | String        | -                 | The Manta user under which to store data. |
| manta.key                    | String        | -                 | Path to the SSH private key file with which to authenticate to Manta. |
| manta.keyId                  | String        | -                 | The SSH public key ID (signature). |
| ufds.url                     | String        | -                 | LDAP URL to connect to UFDS. Required if `mode === 'dc'`. |
| ufds.bindDN                  | String        | -                 | UFDS root dn. Required if `mode === 'dc'`. |
| ufds.bindPassword            | String        | -                 | UFDS root dn password. Required if `mode === 'dc'`. |
| wfapi.url                    | String        | -                 | The Workflow API URL. |
| wfapi.workflows              | String        | -                 | Array of workflows to load. |
| wfapi.forceReplace           | Boolean       | -                 | Whether to replace all workflows loaded every time the IMGAPI service is started. Ideal for development environments |

| XXX database                     | Object        | -                 | Database info. The "database" is how the image manifest data is stored. |
| XXX database.type                | String        | ufds              | One of 'ufds' (the default, i.e. use an SDC UFDS directory service) or 'local'. The 'local' type is a quick implementation appropriate only for smallish numbers of images. |
| XXX database.dir                 | String        | -                 | The base directory for the database `database.type === 'local'`. |
| XXX storage                      | Object        | -                 | The set of available storage mechanisms for the image *files*. There must be at least one. See the [Image file storage](#image-file-storage) section for discussion. |
| XXX storage.local                | Object        | -                 | Object holding config information for "local" disk storage. |
| XXX storage.local.baseDir        | String        | -                 | The base directory in which to store image files and archived manifests for "local" storage. This is required even if "storage.manta" is setup for primary storage, because image manifest archives are first staged locally before upload to manta. |
| XXX auth                         | Object        |                   | If in 'public' mode, then auth details are required. 'dc' mode does no auth. |
| XXX auth.keys                    | Object        | -                 | Optional. A mapping of username to an array of ssh public keys. Only used for HTTP signature auth (`config.auth.type === "signature"`). |
| XXX auth.keysDir                 | String        | -                 | Optional. A local directory path (e.g. "/data/imgapi/etc/keys") in which the server will look for local keys files (`$auth.keysDir/local/$username.keys`) and sync keys from Manta (`$auth.keysDir/manta/$username.keys). Only relevant if `auth.type === 'signature'`. |
| XXX auth.type                    | String        | signature         | XXX rip out 'basic'. One of 'none', 'basic' (HTTP Basic Auth), or 'signature' ([HTTP Signature auth](https://github.com/joyent/node-http-signature)). |
| XXX auth.users                   | Object        | -                 | Required if `auth.type === 'basic'`. A mapping of username to bcrypt-hashed password. Use the `bin/hash-basic-auth-password` tool to create the hash. |

# Image file storage

There are two possible storage mechanisms for the (large) image files (and image
icon files). Which are in use depend on the IMGAPI configuration (and
availability in the DC).

1. manta: Requires an available Manta. All files are stored in the configured
   user's Manta area (e.g. under "/a-dc-operator/stor/imgapi/"), as opposed
   to storing images own by Bob under Bob's area in Manta.
   Manta storage may be local (i.e. within the same region, this is preferred)
   or remote (a Manta across the WAN).
2. local: A local dir (or locally mounted dir). Only really meant for testing,
   development and bootstrapping. Generally 'local' usage is insufficient
   for producion usage because a locally mounted dir can't handle HA (imgapi
   zones on more than one server).

The set of available storages is set in the [configuration](#configuration).
For example:

    "storage": {
        "manta": {
            "url": "https://us-east.manta.joyent.com",
            "user": "admin",
            "insecure": false,
            "remote": true,
            "key": "/root/.ssh/imgapi.id_rsa",
            "keyId": "59:8a:63:3f:9d:5d:69:5f:cf:37:2e:0d:84:80:91:da"
        },
        "local": {
            "baseDir": "/data/imgapi"
        }
    }

The [`<imgapi-zone>:/opt/smartdc/imgapi/bin/imgapi-manta-setup`](https://github.com/joyent/sdc-imgapi/blob/master/bin/imgapi-manta-setup)
and [`<imgapi-zone>:/opt/smartdc/imgapi/bin/imgapi-external-manta-setup`](https://github.com/joyent/sdc-imgapi/blob/master/bin/imgapi-external-manta-setup)
scripts are intended for use in setting up an IMGAPI to use a Manta.

Local Manta storage, if available, is used in preference to "local" storage.
Manta storage is *required* for user custom image creation, i.e. CloudAPI's
[CreateImageFromMachine](http://apidocs.joyent.com/cloudapi/#CreateImageFromMachine),
unless [overriden](howto-enable-custom-image-creation-without-manta).

If Manta storage is available *but is remote*, then which storage is used is a
little more complicated. The intention is that user-created custom images
(i.e. IMGAPI's CreateImageFromVm, aka CreateImageFromMachine on cloudapi) go
to Manta. However, admin-managed public images for the DC are typically large
and can't practically live in a remote Manta. Therefore the algorithm is that
"admin"-owned images prefer local storage to "remote Manta" storage. Images
owned by others prefer remote Manta storage to local storage.


# Authentication

IMGAPI supports three authentication modes:

1. HTTP Signature auth (`config.auth.type === "signature").
2. HTTP Basic auth (`config.auth.type === "basic"`). This is deprecated and will be removed.
3. No auth (`config.mode === "dc"`). When running as a component of a Triton DataCenter -- on the
   DCs private "admin" network -- IMGAPI runs without auth.

## HTTP Signature auth

To support HTTP signature authentication the server needs a mapping of
usernames to an array of SSH public keys. There are three places those keys
can come from:

1. `config.auth.keys`. For example:

        ...
        "auth": {
            "type": "signature",
            "keys": {
                "trentm": ["ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDPLIC/hQIyd3gvIteBVOIrhZJ8KJHdZe3O/eb7wZL3yoEAOSQeC5yIZINLyZElFeDjKrgsshhPRnWV0QrPPPfkgnpiHTXbTPU0p5aEqekMgMUVVblGmtKr1QRxuQYW2S1r3HBZkoVC8LnbPBR4xWgtCx8LuVOOwCtYc9+E+e+Yl9EjW415KZyVtMVhpzR7ja8Le+SiapJOUejy7CuO73XS9A9xXDHGw81lQtoDJASgJhJKj8/64tgGFxkNERjBtA/hG/9bofHD/Zw4kxAoR1kjtF49sDop5UKEBT3WlejWedQ/fZqyHCNk+YOpmIt+aM0jF49vNMM+QhQotTN5iYHb DESCRIPTION"]
            }
        }

2. Local ".keys" files in `${config.auth.keysDir}/local/$username.keys`. E.g.

        $ cat /data/imgapi/etc/keys/local/trentm.keys
        ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDPLIC/hQIyd3gvIteBVOIrhZJ8KJHdZe3O/eb7wZL3yoEAOSQeC5yIZINLyZElFeDjKrgsshhPRnWV0QrPPPfkgnpiHTXbTPU0p5aEqekMgMUVVblGmtKr1QRxuQYW2S1r3HBZkoVC8LnbPBR4xWgtCx8LuVOOwCtYc9+E+e+Yl9EjW415KZyVtMVhpzR7ja8Le+SiapJOUejy7CuO73XS9A9xXDHGw81lQtoDJASgJhJKj8/64tgGFxkNERjBtA/hG/9bofHD/Zw4kxAoR1kjtF49sDop5UKEBT3WlejWedQ/fZqyHCNk+YOpmIt+aM0jF49vNMM+QhQotTN5iYHb DESCRIPTION

    This requires `config.auth.keysDir` to be set.

3. ".keys" files in *Manta* at `.../keys/$username.keys` (where "..." is
   determined from `config.storage.manta`, if set).

        $ mls /trent.mick/stor/imgapi/keys
        trentm.keys

    This requires `config.storage.manta.*` and `config.auth.keysDir` be
    set. When those are set, IMGAPI will periodically sync keys files in
    Manta to `${config.auth.keysDir}/manta/` locally and load from there.
    Use the [AdminReloadAuthKeys](#AdminReloadAuthKeys) endpoint to trigger
    a reload.


## Logs

| service/path | where | format | tail -f |
| ------------ | ----- | ------ | ------- |
| imgapi       | in each "imgapi" zone | [Bunyan](https://github.com/trentm/node-bunyan) | `` sdc-login imgapi; tail -f `svcs -L imgapi` | bunyan `` |


## HOWTO: Enable custom image creation without Manta

By default, an IMGAPI in SDC only allows custom image creation (via the
CreateImageFromVm endpoint) if it is configured with Manta storage for
custom image files. However for *test* SDC standups you can hack IMGAPI
to allow local custom image storage.

The symptom of needing to do this from cloudapi or the node-smartdc CLI is:

    $ sdc-createimagefrommachine --machine 3d68ee48-d1fa-685c-9c33-e23064141138 --imageVersion 1.0.0 --name image1 --description "Does this work"
    sdc-createimagefrommachine: error (NotAvailable): custom image creation is not currently available


To allow custom images using *local* storage, run the following in your
SDC headnode global zone:

    echo '{"metadata": {"IMGAPI_ALLOW_LOCAL_CREATE_IMAGE_FROM_VM": true}}' \
      | sapiadm update $(sdc-sapi /services?name=imgapi | json -H 0.uuid)

When the 'config-agent' running in the imgapi zone picks up this change
(after about 30s), the imgapi service will be restarted with
`"allowLocalCreateImageFromVm": true` (see [the Configuration
section](#configuration) above).


## HOWTO: Dig into IMGAPI's Manta storage

If this IMGAPI is setup to use Manta.

        HN=stage2    # my SDC headnode login

        # Get one of the Manta LB IPs:
        export MANTA_URL=https://$(ssh $HN "/opt/smartdc/bin/sdc-vmapi /vms?tag.manta_role=loadbalancer | json -H -c 'this.state==\"running\"' 0.nics | json -c 'this.nic_tag==\"external\"' 0.ip" 2>/dev/null)

        # Get a local copy of the admin SSH key being used for Manta access
        # (or add your own to the admin user).
        ZONENAME=$(ssh $HN vmadm lookup -1 alias=imgapi0)
        mkdir -p /var/tmp/$HN
        cd /var/tmp/$HN
        scp $HN:/zones/$ZONENAME/root/root/.ssh/id_rsa* .

        # This would be sufficient for python-manta and mantash:
        #    export MANTA_KEY_ID=`pwd`/id_rsa
        # However, node-manta tools are a little more picky. You need to
        # have your id_rsa in ~/.ssh or in your agent. So we'll do the
        # latter:
        chmod 0600 id_rsa*
        ssh-add `pwd`/id_rsa
        MANTA_KEY_ID=$(ssh-keygen -l -f id_rsa.pub | awk '{print $2}')

        export MANTA_USER=admin
        set | grep MANTA_

        # With mantash from python-manta:
        mantash -k find /admin/stor/imgapi

        # With node-manta tools:
        # TODO: I think node-manta tools don't support a non-default path
        # to the ssh key?


## Configuring IMGAPI for HTTPS

This section is for setting up an IMGAPI that lives *outside* of an SDC
installation. Examples of this are for <https://images.joyent.com> and
<https://updates.joyent.com>.

On SmartOS, IMGAPI can be deployed to support HTTPS with the use of Stud
(https://github.com/bumptech/stud) as a SSL/TLS termination proxy. Because of the
way Stud works we need to put an additional reverse proxy between Stud and IMGAPI:
HAProxy. The only caveat here is that the latest version of HAProxy doesn't
fully understand the traffic coming from Stud, so we use a patched version of
the package.

### Prerequisites and Assumptions

* IMGAPI running on an Image with at least a 2012Q2 release of pkgsrc
* IMGAPI running on port 8080 if using configuration defaults
* Generated certficate file
* gmake

### Installing and Configuring HAProxy

The IMGAPI repository contains the patched copy of HAProxy under the deps/
directory. cd to that directory and proceed to compile HAProxy as follows:

    cd $IMGAPI_REPO/deps/haproxy-1.4.21/
    gmake TARGET=solaris

It's not necessary to move the resulting binary to another location. Now, we need
to configure HAProxy. This repository contains a sample configuration file (on
etc/haproxy.cfg.in) that will make the proxy listen on port 8443 and redirect
its traffic to port 8080.

The final step is to import the HAProxy SMF file in order to run the proxy as a
service. The IMGAPI repository contains a sample service definition file that
can be imported after updating the exec_method tag and config_file values to
reflect the current install setup. With a valid SMF file we can proceed to
import it and start running HAProxy:

    cp $IMGAPI_REPO/smf/manifests/haproxy.xml.in $IMGAPI_REPO/smf/manifests/haproxy.xml
    # --- Replace variables ---
    svccfg import $IMGAPI_REPO/smf/manifests/haproxy.xml
    svcadm enable haproxy:default

### Installing and configuring Stud

Configuring Stud is easier since it doesn't require a custom binary, we use the
version provided by pksrc. Additionally, pkgsrc provides a sample SMF and
configuration file to use for Stud. Begin by installing the package:

    # Install Stud
    pkgin -y in stud-0nb20120827

This package will write a sample configuration file to /opt/local/etc/stud.conf.
For this guide we assume that Stud will terminate and redirect its traffic to a
service listening on port 8443. The only additional value we need to modify
is pem-file, which specifies the location of the SSL certificate to use. After
updating the configuration file we enable the Stud SMF service, since the sample
SMF file was already imported (assuming we are OK with using
/opt/local/etc/stud.conf as the location for our configuration file):

    svcadm enable stud:default

At this point Stud, HAProxy and IMGAPI should all be running correctly. We can
confirm this with the help of the netstat command:

    netstat -f inet -an

    TCP: IPv4
       Local Address        Remote Address    Swind Send-Q Rwind Recv-Q    State
    -------------------- -------------------- ----- ------ ----- ------ -----------
          *.8080               *.*                0      0 128000      0 LISTEN
          *.8443               *.*                0      0 128000      0 LISTEN
    127.0.0.1.8081             *.*                0      0 128000      0 LISTEN
          *.443                *.*                0      0 128000      0 LISTEN
