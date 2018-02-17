---
title: IMGAPI Operator Guide
markdown2extras: tables, code-friendly, cuddled-lists
apisections:
---

# IMGAPI Operator Guide

This document is a guide for operators of an IMGAPI. Users of IMGAPI can
refer to the [User Guide](./index.md).

There are two main types of IMGAPI:

1. `DC-mode`: An instance that is part of the core "imgapi" service in a Triton
   DataCenter. An in-DC IMGAPI is configured with `mode === "dc"`. It serves
   HTTP over the DC's "admin" network. It optionally has a firewalled (external
   connections only) NIC on an external network to be able to reach out (to
   import from standalone IMGAPIs, or pull from Docker registries).

2. `standalone`: A standalone IMGAPI, that runs independent of a Triton
   DataCenter. These are configured with `mode === "public"` (for public images,
   example "images.joyent.com") or `mode === "private"` (for repos with private
   images, example "updates.joyent.com"). These serve HTTPS over a public
   network (via stud for SSL termination, to HAproxy for possible load
   balancing, to one or more node.js IMGAPI processes). They are typically
   configured to use HTTP Signature auth (like Triton's CloudAPI and Manta's web
   API) for any write endpoints.

# Image

Both types of IMGAPI instances use "imgapi" images built from sdc-imgapi.git and
mountain-gorilla.git on Joyent's internal CI build system and released to
[Joyent's Updates Image repository](https://updates.joyent.com).


# DC-Mode Setup

A DC-mode IMGAPI instance is setup via standard Triton DataCenter headnode
setup. See
[headnode.sh](https://github.com/joyent/sdc-headnode/blob/master/scripts/headnode.sh).

## DC-mode setup: add an external NIC

For a DC-mode IMGAPI to import images -- e.g. from images.joyent.com to add base
images for users of the DC, or from updates.joyent.com for updating the Triton
DC -- the IMGAPI instance requires an external NIC. The instance is firewalled
to only allow outgoing connections. The external NIC can be added (and to the
adminui instance) via:

    sdcadm post-setup common-external-nics


## DC-mode setup: connect to Manta

For durable image storage (and to enable image creation which intentionally
fails without durable storage), a DC-mode IMGAPI instance needs to be given
Manta connection details.

This can be done by running one of the following scripts (they must be run
from inside the imgapi zone):

    # Use a Manta that is part of this same Triton cloud (i.e. shares the
    # same account database):
    imgapi-manta-setup MANTA_URL [OPTIONS] | bunyan

    # Use a Manta that is not part of this Triton cloud:
    imgapi-external-manta-setup MANTA_URL MANTA_USER PATH_TO_PRIV_KEY | bunyan

(Dev Note: Longer term this responsibility should move to a `sdcadm post-setup ...` command.)


## DC-mode setup: enable custom image creation without Manta

(This step is optional, and typically solely for development.)

By default, a DC-mode IMGAPI only allows custom image creation (i.e. the
[CreateImageFromVm](./index.md#CreateImageFromVm] endpoint) if it is configured
with Manta storage for custom image files. However for *test* Triton DataCenter
standups you can hack IMGAPI to allow local custom image storage.

The symptom of needing to do this from cloudapi or the node-smartdc CLI is:

    $ triton image create 3d68ee48-d1fa-685c-9c33-e23064141138 myimage 1.0.0
    triton image create: error (NotAvailable): custom image creation is not currently available

To allow custom images using *local* storage, run the following in your
SDC headnode global zone:

    echo '{"metadata": {"IMGAPI_ALLOW_LOCAL_CREATE_IMAGE_FROM_VM": true}}' \
      | sapiadm update $(sdc-sapi /services?name=imgapi | json -H 0.uuid)

When the 'config-agent' running in the imgapi zone picks up this change
(after about 30s), the imgapi service will be restarted with
`"allowLocalCreateImageFromVm": true` (see [the Configuration
section](#configuration) above).


# Standalone Setup

A standalone IMGAPI instance is just a regular instance. However two reasons
mean we can't use stock `triton` to provision one:

- We use 'imgapi' images from updates.joyent.com, which can only be imported
  to a DC by an operator.
  Dev Note: Eventually this could move to custom image builds by the user that
  owns the imgapi instance. Preferably this would be via a `triton build`
  that automates this.
- We want (for good updating we currently require) a delegated dataset, which
  isn't yet an exported feature of CloudAPI's CreateMachine.

*Warning:* Currently, standalone IMGAPI code does not support multiple instances
using the same Manta area. It is up to the operator to guard against this. If
two instances are writing to the same Manta area, they could cause conflicts
in the image files and backups stored there.


## Standalone Setup Step 1: create instance

To create new standalone IMGAPI instance, use
[imgapi-standalone-create](../bin/imgapi-standalone-create). It needs to be
run from the DC's headnode global zone.

    imgapi-standalone-create [OPTIONS] ACCOUNT IMAGE PACKAGE ALIAS

For example:

    cd /var/tmp
    curl -kO https://raw.githubusercontent.com/joyent/sdc-imgapi/master/bin/imgapi-standalone-create
    chmod +x imgapi-standalone-create

    # A play IMGAPI in COAL using a local 'trentm' COAL account and
    # /trent.mick/stor/tmp/images in Manta:
    ./imgapi-standalone-create \
        -m mantaUrl=https://us-east.manta.joyent.com \
        -m mantaUser=trent.mick \
        -m mantaBaseDir=tmp/images \
        trentm latest sample-2G myimages0

    # An deployment of images.joyent.com might look like this:
    ./imgapi-standalone-create \
        -m mantaUrl=https://us-east.manta.joyent.com \
        -m mantaUser=joyops \
        -m mantaBaseDir=images.joyent.com \
        -t triton.cns.services=imagesjo \
        joyops latest g4-highcpu-2G imagesjo0

The `-m` option adds metadata. A set of metadata keys are supported setup config
vars (see [Standalone Setup Configuration](#standalone-setup-configuration)
below). The `-t` option adds an instance tag -- in this case to use
[CNS](https://docs.joyent.com/public-cloud/network/cns).


## Standalone Setup Step 2: edit config

After creation, one may edit the generated config file at
"/data/imgapi/etc/imgapi.config.json" manually. Afterwards, remember to
restart the imgapi service:

    vi /data/imgapi/etc/imgapi.config.json
    svcadm restart imgapi


## Standalone Setup Step 3: add imgapi instance key to account

Every standalone IMGAPI instance creates its own "instance key" -- an SSH key
to be used for authenticated access to Manta, if relevant. If configuring
this IMGAPI instance for Manta access (strongly suggested), then one needs
to add this instance's SSH public key to the Manta account to being used.

For convenience the instance public key is published on the instance's metadata,
so that a command like the following can work to add the key to one's account:

    triton inst get ALIAS | json metadata.instPubKey | triton key add -

The key is typically named "imgapi-$alias-$zonenameprefix-$date", so when
listing keys it to check, it will look something like this:

    $ triton keys
    FINGERPRINT                                      NAME
    b5:cb:80:c0:5e:d9:2b:6f:63:a3:44:eb:ac:39:db:fa  imgapi-imagesjo0-ef4a1442-20160907
    b3:f0:a1:6c:32:3b:47:63:ae:6e:57:22:74:71:d4:bd  trentm


## Standalone Setup Step 4: restore data from backup

The setup is not complete until
[imgapi-standalone-restore](../bin/imgapi-standalone-restore) is run. This will
restore "local" data from the backup in the IMGAPI's Manta area, if any. It must
be run even if it is a no-op (not configured to use Manta, empty Manta area).

    ssh root@$(triton ip ALIAS)
    imgapi-standalone-restore [OPTIONS]

Dev note: It must always be run because it leaves a marker file indicating that
it is safe for the background imgapi-standalone-backup process to run and write
data *to* the backup. Even if not backing up `imgapi-standalone-status` will
report a problem if it hasn't been successfully run once.


## Standalone Setup Step 5: set TLS cert

This step is optional.

Initial setup will create a self-signed TLS certificate. If you have a signed
certificate you'd like to use, it can be installed as follows:

    cp /var/tmp/your-cert.pem /data/imgapi/etc/cert.pem
    svcadm restart stud   # restart stud, the TLS terminator

Dev note: Eventually we hope to support Let's Encrypt.


## Standalone Setup Step 6: add authkeys for signature auth

This step is optional.

Typically (and by default) a standalone IMGAPI will use HTTP Signature auth
(`config.authType === "signature"`). Authentication is only done on endpoints
that modify things (CreateImage, DeleteImage, UpdateImage, etc.) and on the
Ping endpoint for testing.

For signature auth you need a mapping of usernames to SSH public keys. A good
way to do that is to add "$username.keys" files in the IMGAPI's Manta area at:

    /${manta.user}/stor/${manta.baseDir}/authkeys/

For example:

    $ mget /joyops/stor/images.joyent.com/authkeys/trentm.keys
    ssh-rsa AAAAB3NzaC1yc2EAAAABIwAA...

The IMGAPI server periodically (once per hour) syncs changes from that Manta
area and updates its auth info. Or for the lazy one can do either of:

    ssh root@$(triton ip ALIAS) svcadm restart imgapi

    # The following require already being setup for auth.
    IMGAPI_CLI_URL=https://myimages.com imgapi-cli reload-auth-keys
    joyent-imgadm reload-auth-keys      # custom CLI for images.joyent.com
    updates-imgadm reload-auth-keys     # custom CLI for updates.joyent.com

This isn't the only place that authkeys can be added. See the
[Authentication](#authentication) section below for full details.


## Standalone Setup Step 6: set CNS service tag

This step is optional.

A nice way to setup DNS for a standalone IMGAPI instance is to use
[CNS](https://docs.joyent.com/public-cloud/network/cns), if available in
your Triton DC. Set the `triton.cns.services` tag on your instance:

    triton inst tag set -w myimages0 triton.cns.services=myimages

and CNS will create a service ("svc") DNS name:

    $ triton -p joyentsw-sw1 inst get imagesjo0 | json dns_names
    [
      "0370c8fc-7f73-11e6-a160-7f089df626c7.inst.f3fabce8-7f72-11e6-98f8-6f6f85da7472.us-sw-1.triton.zone",
      "myimages0.inst.f3fabce8-7f72-11e6-98f8-6f6f85da7472.us-west-1.triton.zone",
      "myimages.svc.f3fabce8-7f72-11e6-98f8-6f6f85da7472.us-west-1.triton.zone"
    ]

Then create a CNAME in your DNS provider mapping, say, "myimages.com"
to the service name:

    myimages.com -> myimages.svc.f3fabce8-7f72-11e6-98f8-6f6f85da7472.us-west-1.triton.zone

Then, even if your instance is recycled and replaced, DNS will still work.
And when imgapi supports multiple instances (for HA), DNS will map to all your
instances using the "myimages" cns tag.


# Update

DC-mode:

    sdcadm up imgapi

* * *

Standalone: To update a standalone IMGAPI instance use
[imgapi-standalone-reprovision](../bin/imgapi-standalone-reprovision). It needs
to be run from the DC's headnode global zone (dev note: because reprovision
isn't yet a part of CloudAPI).

    imgapi-standalone-reprovision [OPTIONS] INSTANCE IMAGE

For example:

    cd /var/tmp
    curl -kO https://raw.githubusercontent.com/joyent/sdc-imgapi/master/bin/imgapi-standalone-reprovision
    chmod +x imgapi-standalone-reprovision

    ./imgapi-standalone-reprovision 98cf10d4-7550-11e6-8930-ef291247b988 latest


This will handle importing the identified 'imgapi' image to the DC, tweaking
its permissions, and reprovisioning the instance to the new image.


# Key rotation

Both DC-mode and standalone IMGAPI instances use an SSH key to talk to Manta
for file storage (if configured to use Manta). This section describes how
to rotate that key.

## Key rotation: DC-mode

A DC-mode IMGAPI that is configured to use Manta is setup in one of two ways:

1. with a local manta (in the same region), the 'admin' account, and using a key
   generated by the setup script (`imgapi-manta-setup`); or

2. with a possibly external manta, using a key provided to the setup script
   (`imgapi-external-manta-setup`).

In both cases the IMGAPI key can be rotated by re-running the script:

    # 1.
    # Note: Use the "--force" option to force re-generation of the key.
    sdc-login -l imgapi
    imgapi-manta-setup --force MANTA-URL | bunyan

    # 2.
    sdc-login -l imgapi
    imgapi-external-manta-setup <manta-url> <manta-user> <path-to-new-priv-key> | bunyan


## Key rotation: Standalone

Login to the instance and run:

    imgapi-standalone-rotate-key

This will walk you through the process of rotating the key: A new key will
be generated. You will need to manually add that key to the appropriate
Manta user (in general a standalone IMGAPI instance doesn't know or have
access to the appropriate CloudAPI on which to add a key). The script will
wait until that key is available and then update the imgapi service as
appropriate.


# Health

DC-mode:

    sdcadm check-health
    sdc-healthcheck

(Dev note: Yes, currently there are both of those things. Eventually when
`sdcadm check-health` improves, the latter can be deprecated.)

* * *

Standalone:

    ssh root@$(triton ip ALIAS)
    imgapi-standalone-status [-h] [-v]


# Backup and Recovery

DC-mode: nothing currently

* * *

Standalone: A regular part of a standalone IMGAPI is a background process
(see "Background processes" section below) that periodically backs up local data
to Manta, to `/${manta.user}/stor/${manta.baseDir}/backup/...`. This, of course,
requires that the config file have manta access (see "Setup" steps above).

Recovery from backup is exactly the setup process described above: read the
"Setup" section from the start. In particular the 'imgapi-standalone-restore'
script is the part that restores the local data from backup.


# Background processes

DC-mode IMGAPI has the following background processes:

1. A node.js "config-agent" SMF service that handles updating config files
   (in particular the imgapi service config) from "sapi_templates/..." and
   SAPI data.
2. A node.js "registrar" SMF service agent that handles registering this
   imgapi instance in the Triton DataCenter's "binder".
3. A node.js "amon-agent" SMF service that handles monitoring.
   (Dev Note: Current amon usage for imgapi monitoring is not significant.)
4. An hourly cronjob runs "logadm" to handle log rotation.
5. A "hermes" SMF service agent runs from the GZ to handle rotated log file
   upload to Manta (if the Triton DC is so configured).

* * *

Along with the usual 'imgapi' service, HAproxy, and stud; a standalone IMGAPI
has the following background processes:

1. An hourly cronjob runs "logadm" to handle log rotation.
2. An hourly cronjob runs
   [tritonlogupload.sh](../tools/standalone/tritonlogupload.sh) to upload
   rotated files to manta.
3. An hourly cronjob runs "imgapi-standalone-backup" to backup local data to
   Manta.


# Configuration

An IMGAPI process is configured via two files:

1.  A defaults JSON file: "etc/defaults.json" in the repository,
    "/opt/smartdc/imgapi/etc/defaults.json" in an IMGAPI instance.

2.  An instance-specific JSON config file, typically
    "/data/imgapi/etc/imgapi.config.json" (can be overridden with the `node
    main.js -f CONFIG-PATH` option). An explicit config file must exist, but
    it can be the empty `{}` to just use the defaults.

    A DC-mode config file is rendered by the `config-agent` service -- rendered
    from the template at "sapi_templates/imgapi/template" and instance config
    from the SAPI GetConfig endpoint
    (https://github.com/joyent/sdc-sapi/blob/master/docs/index.md). See
    "SAPI Configuration" below.

    A standalone IMGAPI's config file is initially rendered by the
    "boot/standalone/setup.sh" setup process from the template at
    "etc/standalone/imgapi.config.json.handlebars" and setup config vars on
    instance metadata, if any. See "Standalone Setup Configuration" below

Currently the defaults give you a public-mode standalone IMGAPI,
that listens at "https://127.0.0.1:8080", uses the local database and local
storage backends, and uses signature auth for endpoints that
create/update/delete resources.

Note that given custom values override full top-level keys in the defaults.
For example: if providing `manta`, one must provide the whole `manta` object.

| var                          | type          | default           | description |
| ---------------------------- | ------------- | ----------------- | ----------- |
| port                         | Number        | 8080              | Port number on which to listen. |
| address                      | String        | 127.0.0.1         | Address on which to listen. |
| serverName                   | String        | imgapi/$version   | Name of the HTTP server. This value is present on every HTTP response in the 'Server' header. |
| logLevel                     | String/Number | debug             | Level at which to log. One of the supported Bunyan log levels. This is overridden by the `-d,--debug` switch. |
| maxSockets                   | Number        | 100               | Maximum number of sockets for external API calls |
| mode                         | String        | public            | One of 'public' (default, running as a public server e.g. images.joyent.com), 'private' (a ironically "public" server that only houses images marked `public=false`), or 'dc' (running as the IMGAPI in a Triton DataCenter). |
| datacenterName               | String        | -                 | Name of the Triton DataCenter on which IMGAPI is running. Only relevant if `mode === "dc"`. |
| serviceName                  | String        | -                 | The name of the service. Only relevant if `mode === "dc"`. |
| instanceUuid                 | String        | -                 | The instance UUID. Only relevant if `mode === "dc"`. |
| serverUuid                   | String        | -                 | The server (CN) UUID on which the instance is running. Only relevant if `mode === "dc"`. |
| adminIp                      | String        | -                 | The admin IP address. The metrics server will be exposed on this network. Only relevant if `mode === "dc"`. |
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

For operational scripts, development, and debugging, one can look at the full
merged and computed config by calling "lib/config.js" as a script. This should
always be used in preference to looking at the config files directly to get
the merged and computed config object values. Examples:

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

## SAPI Configuration

DC-mode IMGAPI is configured via "metadata" on the "imgapi" SAPI service.
See [the config template](../sapi_manifests/imgapi/template) for the
authoritative details.

| Key                                     | Type    | Default | Description |
| --------------------------------------- | ------- | ------- | ----------- |
| IMGAPI_ALLOW_LOCAL_CREATE_IMAGE_FROM_VM | Boolean | false   | Set this to allow image creation even when the DC is not setup to use a Manta. This is useful for development. See [the setup section](#dc-mode-setup-enable-custom-image-creation-without-manta). |
| IMGAPI_MANTA_\*                         | various | -       | These are typically setup by the `imgapi[-external]-manta-setup` scripts. See the [DC-mode setup: connect to Manta](#dc-mode-setup-connect-to-manta) section |
| docker_registry_insecure                | Boolean | false   | See <https://github.com/joyent/triton/blob/master/docs/operator-guide/configuration.md#sdc-application-configuration> |
| http_proxy                              | String  | -       | See <https://github.com/joyent/triton/blob/master/docs/operator-guide/configuration.md#sdc-application-configuration> |


## Standalone Setup Configuration

A standalone IMGAPI instance's config is first written at initial setup by
[imgapi-standalone-gen-setup-config](../bin/imgapi-standalone-gen-setup-config)
by rendering a [template](../etc/standalone/imgapi.config.json.handlebars). A
number of keys can be provided on instance metadata for this initial rendering.
These are called "setup config vars". At time of writing they are (see
`setupConfigVars` in imgapi-standalone-gen-setup-config):

| Key          | Corresponds to this key from the "Configuration" table |
| ------------ | ------------------------------------------------------ |
| mode         | mode |
| serverName   | serverName |
| mantaUrl     | manta.url |
| mantaUser    | manta.user |
| mantaBaseDir | manta.baseDir |
| channels     | channels; This may also by the special value `standard`, which will be substituted by the "standard" channels (a set of channels used by updates.joyent.com). |


# Storage

There are two possible storage mechanisms for the (possibly large) image files
(and image icon files). The storage mechanisms used are configured via
the `storageTypes` config var. For example:

    "storageTypes": ["manta", "local"],
    "mode": "dc",
    "datacenterName": "us-test-1",
    "manta": {
        "url": "https://us-east.manta.joyent.com",
        "user": "alice",
        "key": "/data/imgapi/etc/imgapi-img7-37591570-20160831.id_ecdsa",
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
unless [overriden](#dc-mode-setup-enable-custom-image-creation-without-manta).

For DC-mode imgapi instances, the
[`<imgapi-zone>:/opt/smartdc/imgapi/bin/imgapi-manta-setup`](https://github.com/joyent/sdc-imgapi/blob/master/bin/imgapi-manta-setup)
and [`<imgapi-zone>:/opt/smartdc/imgapi/bin/imgapi-external-manta-setup`](https://github.com/joyent/sdc-imgapi/blob/master/bin/imgapi-external-manta-setup)
scripts are intended for use in setting up to use a Manta. (Longer term this
responsibility should move to a `sdcadm post-setup ...` command.)

At runtime, when a file is added (via `AddImageFile`) a storage backend must be
selected. Non-remote Manta storage, if available, is used in preference to
"local" storage. If Manta storage is available *but is remote*, then which
storage is used is a little more complicated. The intention is that user-created
custom images (i.e. IMGAPI's CreateImageFromVm, aka CreateImageFromMachine on
cloudapi) go to Manta. However, admin-managed public images for the DC are
typically large and can't practically live in a remote Manta. Therefore the
algorithm is that "admin"-owned images prefer local storage to "remote Manta"
storage. Images owned by others prefer remote Manta storage to local storage.

The login shell of an IMGAPI instance should be setup to access its configured
Manta (useful for development and debugging):

    sdc-login -l imgapi
    rootDir=$(node /opt/smartdc/imgapi/lib/config.json manta.rootDir)
    mls $rootDir

# Authentication

IMGAPI supports two authentication modes:

1. HTTP Signature auth (`config.authType === "signature"). This is the default
   and suggested auth mode for standalone IMGAPI instances.
2. No auth (`config.authType === "none"`). This is the typical configuration for
   DC-mode IMGAPI instances, which run on the "admin" network.

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

2. Local ".keys" files in `/data/imgapi/etc/authkeys/local/$username.keys`. E.g.

        $ cat /data/imgapi/etc/authkeys/local/trentm.keys
        ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDPLIC/hQIyd3gvIteBVOIrhZJ8KJHdZe3O/eb7wZL3yoEAOSQeC5yIZINLyZElFeDjKrgsshhPRnWV0QrPPPfkgnpiHTXbTPU0p5aEqekMgMUVVblGmtKr1QRxuQYW2S1r3HBZkoVC8LnbPBR4xWgtCx8LuVOOwCtYc9+E+e+Yl9EjW415KZyVtMVhpzR7ja8Le+SiapJOUejy7CuO73XS9A9xXDHGw81lQtoDJASgJhJKj8/64tgGFxkNERjBtA/hG/9bofHD/Zw4kxAoR1kjtF49sDop5UKEBT3WlejWedQ/fZqyHCNk+YOpmIt+aM0jF49vNMM+QhQotTN5iYHb DESCRIPTION

3. ".keys" files in *Manta* at `${manta.rootDir}/authkeys/$username.keys`:

        $ mls /trent.mick/stor/imgapi/authkeys
        trentm.keys

    This, of course, requires `config.manta.*` be set. IMGAPI will periodically
    (once per hour) sync `${manta.rootDir}/authkeys/*.keys` files in Manta to
    `/data/imgapi/etc/authkeys/manta/` locally and load from there. Use the
    [AdminReloadAuthKeys](#AdminReloadAuthKeys) endpoint to trigger a reload.


# Logs

| service/path         | where                  | notes |
| -------------------- | ---------------------- | ----- |
| imgapi SMF log       | `svcs -L imgapi`       | \*    |
| config-agent SMF log | `svcs -L config-agent` | \*, DC-mode only |
| registrar SMF log    | `svcs -L registrar`    | \*, DC-mode only |
| amon-agent SMF log   | `svcs -L amon-agent`   | \*, DC-mode only    |
| backup to Manta      | /var/log/triton/imgapi-backup.log | \*, standalone-mode only |
| log upload to Manta  | /var/log/tritonlogupload.log      | standalone-mode only |
| logadm               | /var/log/logadm.log               | standalone-mode only |


## Log rotation and upload to Manta

Logs marked with an asterisk (\*) are rotated and uploaded to Manta.

DC-mode IMGAPIs' `logadm` rotates logs hourly to:

    /var/log/sdc/upload/$svc_$zonename_$timestamp.log

and the [hermes](https://github.com/joyent/sdc-hermes) global zone agent
periodically uploads from there to Manta per [this
configuration](https://github.com/joyent/sdc-sdc/blob/master/etc/logsets.json#L198),
removing files after a period after upload.

* * *

Standalone IMGAPIs' `logadm` rotates logs hourly to:

    /var/log/triton/$svc_$nodename_$timestamp.log

The [tritonpostlogrotate.sh](../tools/standalone/tritonpostlogrotate.sh) script
links those files to:

    /var/log/triton/upload/$svc_$nodename_$normtimestamp.log

From there the [tritonlogupload.sh](../tools/standalone/tritonlogupload.sh)
script uploads (via an hourly cron job) to Manta:

    /${manta.user}/stor/${manta.baseDir}/logs/$svc/$YYYY/$MM/$DD/$HH/$nodename.log

Dev Note: The result with standalone IMGAPIs' log rotation and upload has
a few properties different to DC-mode IMGAPIs. These are intentional and
I (Trent) would like to propagate this pattern to all Triton core services.
The improvements are:

- Rotated logs for local use are in /var/log/triton/*.log and are retained
  for the period listed in the /etc/logadm.conf config. Typically that is
  a week of hourly logs. One common problem of in-prod debugging is that
  after a few hours (the hermes `retain_time`), the log files may have been
  uploaded to Manta and deleted from the local instance. Retaining them
  according to logadm config also means that log space usage behaviour is
  similar for DCs setup for Manta log upload and those that are not, which is
  beneficial for dogfooding.
- The log files in the "upload/" subdir can be deleted immediately after
  successful upload. This simplifies the log upload script.
- The basename of uploaded logs is the `$nodename` -- which is the zone's
  alias. This allows for a predictable name in Manta (rather than an instance
  zonename UUID) which can allow avoiding an extra `mfind` for Manta jobs
  for analysis.


## Log-related commands

Some possibly useful commands follow.
Tail the imgapi log:

    tail -f `svcs -L imgapi` | bunyan

Restart the IMGAPI service and tail the log:

    svcadm restart imgapi && tail -f `svcs -L imgapi` | bunyan

Use the [Bunyan dtrace
facility](https://github.com/trentm/node-bunyan/#runtime-log-snooping-via-dtrace)
to tail *trace*-level logs of the imgapi service:

    bunyan -p imgapi

# Metrics

IMGAPI exposes metrics via [node-artedi](https://github.com/joyent/node-artedi).  For development, it is probably easiest to use `curl` to scrape metrics:

```
$ curl http://<ADMIN_IP>:8881/metrics
```
The metrics are returned in Prometheus v0.0.4 text format.

The following metrics are collected:

- http_requests_completed
- http_request_duration_seconds

Each of the metrics returned include the following metadata labels:

- datacenter (Datacenter name e.g. us-east-1)
- service (Service name e.g. vmapi)
- instance (Instance UUID)
- server (Server UUID)
- method (e.g. 'PUT')
- status_code (e.g. 200)
- route (e.g. 'listvms')
- user_agent (only the first token e.g. restify/1.5.2)

The metric collection facility provided is intended to be consumed by a monitoring service like a Prometheus or InfluxDB server.

Notably, some metadata labels are not being collected due to their potential for
high cardinality. Metadata labels that have a large number of unique values
cause memory strain on metric client processes (imgapi) as well as metric
servers (Prometheus). It's important to understand what kind of an effect on
the entire system the addition of metrics and metadata labels can have before
adding them. This is an issue that would likely not appear in a development or
staging environment.
