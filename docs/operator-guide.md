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
are in a separate JSON configuration file, the first existing file of:

1. a path given by `main.js -f CONFIG-PATH`;
2. "/data/imgapi/etc/imgapi.config.json"

Note that given custom values override full top-level keys in the factory
settings. For example: if providing `manta`, one must provide the whole
`manta` object.

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
| channels                     | Array         | -                 | Set this make this IMGAPI server support [channels](#channels). It must be an array of channel definition objects of the form `{"name": "<name>", "description": "<desc>"[, "default": true]}`. |
| placeholderImageLifespanDays | Number        | 7                 | The number of days after which a "placeholder" image (one with state 'failed' or 'creating') is purged from the database. |
| allowLocalCreateImageFromVm  | Boolean       | false             | Whether to allow CreateImageFromVm using local storage (i.e. if no manta storage is configured). This should only be enabled for testing. For SDC installations of IMGAPI `"IMGAPI_ALLOW_LOCAL_CREATE_IMAGE_FROM_VM": true` can be set on the metadata for the 'imgapi' SAPI service to enable this. |
| minImageCreationPlatform     | Array         | see defaults.json | The minimum platform version, `["<sdc version>", "<platform build timestamp>"]`, on which the proto VM for image creation must reside. This is about the minimum platform with sufficient `imgadm` tooling. This is used as an early failure guard for [CreateImageFromVm](#CreateImageFromVm). |
| authType                     | String        | signature         | One of 'none' or 'signature' ([HTTP Signature auth](https://github.com/joyent/node-http-signature)). |
| authKeys                     | Object        | -                 | Optional. A mapping of username to an array of ssh public keys. Only used for HTTP signature auth (`config.authType === "signature"`). |
| databaseType                 | String        | local             | The database backend type to use. One of "local" or "moray". The latter is what is typically used in-DC. |
| storageTypes                 | Array         | ["local"]         | The set of available storage mechanisms for the image *files*. There must be at least one. Supported values are "local" and "manta". See the [Image file storage](#image-file-storage) section for discussion. |
| manta                        | Object        | -                 | Object holding config information for Manta storage. |
| manta.baseDir                | String        | imgapi            | The base directory, relative to '/${manta.user}/stor', under which image files are stored in Manta. |
| manta.url                    | String        | -                 | The Manta API URL. |
| manta.insecure               | Boolean       | false             | Ignore SSL certs on the Manta URL. |
| manta.remote                 | Boolean       | -                 | Whether this Manta is remote to this IMGAPI. This helps IMGAPI determine practical issues on whether manta or local storage is used for large files. |
| manta.user                   | String        | -                 | The Manta user under which to store data. |
| manta.key                    | String        | -                 | Path to the SSH private key file with which to authenticate to Manta. |
| manta.keyId                  | String        | -                 | The SSH public key ID (signature). |
| manta.rootDir                | String        | *<computed>*      | (This is automatically computed from other config vars.) The Manta full path under which IMGAPI uses. |
| ufds.url                     | String        | -                 | LDAP URL to connect to UFDS. Required if `mode === 'dc'`. |
| ufds.bindDN                  | String        | -                 | UFDS root dn. Required if `mode === 'dc'`. |
| ufds.bindPassword            | String        | -                 | UFDS root dn password. Required if `mode === 'dc'`. |
| wfapi.url                    | String        | -                 | The Workflow API URL. |
| wfapi.workflows              | String        | -                 | Array of workflows to load. |
| wfapi.forceReplace           | Boolean       | -                 | Whether to replace all workflows loaded every time the IMGAPI service is started. Ideal for development environments |

While an explicit config file must exist (by default at
"/data/imgapi/etc/imgapi.config.json"), it can be the empty `{}` -- i.e "use the
defaults". Currently the defaults give you a public-mode standalone IMGAPI,
that listens at "https://127.0.0.1:8080", uses the local database and local
storage backends, and uses signature auth for endpoints that
create/update/delete resources.

For development and debugging, one can look at the full merged and computed
config by calling "lib/config.js" as a script. Examples:

    $ node lib/config.js -h
    usage: node .../lib/config.js [OPTIONS] [KEY]
    options:
        -h, --help                          Print this help and exit.
        -f CONFIG-PATH, --file=CONFIG-PATH  Config file path.
    $ node lib/config.js -f foo.json authType
    signature
    $ node lib/config.js -f foo.json
    {
        "port": 8080,
        "address": "127.0.0.1",
        "maxSockets": 100,
        "logLevel": "debug",
        "mode": "public",
        "authType": "signature",
    ...


# Storage

There are two possible storage mechanisms for the (large) image files (and image
icon files). Which are in use depend on the IMGAPI configuration (and
availability in the DC). For example:

    "storageTypes": ["manta", "local"],
    "mode": "dc",
    "datacenterName": "us-test-1",
    "manta": {
        "url": "https://us-east.manta.joyent.com",
        "user": "alice",
        "key": "/data/imgapi/etc/imgapi-img7-37591570-20160831.id_rsa",
        "keyId": "SHA256:UlGQ8CXT0BIvJXq2IoPllUHUOTJUCwNLhsKMzdc8/30",
        "baseDir": "imgapi",
        "insecure": false,
        "remote": true,
    },


Storage types are:

1. `manta`: Requires an available Manta and that IMGAPI be configured to use it.
   All files are stored in the configured Manta user's area (under
   "/${manta.user}/stor/"), as opposed to storing images own by Bob under
   Bob's area in Manta. Manta storage may be local (i.e. within the same region,
   this is preferred) or remote (a Manta across the WAN).

   The Manta root directory used by an IMGAPI (called the Manta `rootDir`) is
   as follows. If in DC mode (`mode === "dc"`), then the additional
   "${datacenterName}/" dir component is added.

        /${manta.user}/stor/${manta.baseDir}/[${datacenterName}/]...

   Examples:

        /jim/stor/images.joyent.com/...
        /cloudops/stor/imgapi/us-test-1/...

2. `local`: Files are stored at the local "/data/imgapi/images/..." (possibly
   a delegate dataset or NFS mount or whatever). All IMGAPI instances will have
   at least "local" storage.

Configuring for Manta storage is preferred because file storage is then durable.
For in-DC IMGAPI instances, Manta storage is *required* for user custom image
creation, i.e. CloudAPI's
[CreateImageFromMachine](http://apidocs.joyent.com/cloudapi/#CreateImageFromMachine),
unless [overriden](howto-enable-custom-image-creation-without-manta).

For in-DC imgapi instances, the
[`<imgapi-zone>:/opt/smartdc/imgapi/bin/imgapi-manta-setup`](https://github.com/joyent/sdc-imgapi/blob/master/bin/imgapi-manta-setup)
and [`<imgapi-zone>:/opt/smartdc/imgapi/bin/imgapi-external-manta-setup`](https://github.com/joyent/sdc-imgapi/blob/master/bin/imgapi-external-manta-setup)
scripts are intended for use in setting up to use a Manta. (Longer term this
responsibility should move to a `sdcadm post-setup ...` command.)

When a file is added (via `AddImageFile`) a storage backend must be selected.
Non-remote Manta storage, if available, is used in preference to "local"
storage. If Manta storage is available *but is remote*, then which storage is
used is a little more complicated. The intention is that user-created custom
images (i.e. IMGAPI's CreateImageFromVm, aka CreateImageFromMachine on cloudapi)
go to Manta. However, admin-managed public images for the DC are typically large
and can't practically live in a remote Manta. Therefore the algorithm is that
"admin"-owned images prefer local storage to "remote Manta" storage. Images
owned by others prefer remote Manta storage to local storage.


# Authentication

IMGAPI supports two authentication modes:

1. HTTP Signature auth (`config.authType === "signature").
2. No auth (`config.authType === "none"`). When running as a component of a
   Triton DataCenter -- on the DCs private "admin" network -- IMGAPI runs
   without auth.

## HTTP Signature auth

To support HTTP signature authentication the server needs a mapping of
usernames to an array of SSH public keys. There are three places those keys
can come from:

1. `config.authKeys`. For example:

        ...
        "authType": "signature",
        "authKeys": {
            "trentm": ["ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDPLIC/hQIyd3gvIteBVOIrhZJ8KJHdZe3O/eb7wZL3yoEAOSQeC5yIZINLyZElFeDjKrgsshhPRnWV0QrPPPfkgnpiHTXbTPU0p5aEqekMgMUVVblGmtKr1QRxuQYW2S1r3HBZkoVC8LnbPBR4xWgtCx8LuVOOwCtYc9+E+e+Yl9EjW415KZyVtMVhpzR7ja8Le+SiapJOUejy7CuO73XS9A9xXDHGw81lQtoDJASgJhJKj8/64tgGFxkNERjBtA/hG/9bofHD/Zw4kxAoR1kjtF49sDop5UKEBT3WlejWedQ/fZqyHCNk+YOpmIt+aM0jF49vNMM+QhQotTN5iYHb DESCRIPTION"]
        }

2. Local ".keys" files in `/data/imgapi/etc/keys/local/$username.keys`. E.g.

        $ cat /data/imgapi/etc/keys/local/trentm.keys
        ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDPLIC/hQIyd3gvIteBVOIrhZJ8KJHdZe3O/eb7wZL3yoEAOSQeC5yIZINLyZElFeDjKrgsshhPRnWV0QrPPPfkgnpiHTXbTPU0p5aEqekMgMUVVblGmtKr1QRxuQYW2S1r3HBZkoVC8LnbPBR4xWgtCx8LuVOOwCtYc9+E+e+Yl9EjW415KZyVtMVhpzR7ja8Le+SiapJOUejy7CuO73XS9A9xXDHGw81lQtoDJASgJhJKj8/64tgGFxkNERjBtA/hG/9bofHD/Zw4kxAoR1kjtF49sDop5UKEBT3WlejWedQ/fZqyHCNk+YOpmIt+aM0jF49vNMM+QhQotTN5iYHb DESCRIPTION

3. ".keys" files in *Manta* at `${manta.rootDir}/keys/$username.keys`:

        $ mls /trent.mick/stor/imgapi/keys
        trentm.keys

    This, of course, requires `config.manta.*` be set. IMGAPI will periodically
    sync `${manta.rootDir}/keys/*.keys` files in Manta to
    `/data/imgapi/etc/keys/manta/` locally and load from there. Use the
    [AdminReloadAuthKeys](#AdminReloadAuthKeys) endpoint to trigger a reload.


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
