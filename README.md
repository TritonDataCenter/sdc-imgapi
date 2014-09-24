<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# sdc-imgapi

This repository is part of the Joyent SmartDataCenter project (SDC).  For
contribution guidelines, issues, and general documentation, visit the main
[SDC](http://github.com/joyent/sdc) project page.

The Image API (IMGAPI) is the API in each SDC data center for managing
VM (i.e. KVM and Zones) images.

# Development

    git clone git@github.com:joyent/sdc-imgapi.git
    cd sdc-imgapi
    git submodule update --init
    make all
    node main.js [OPTIONS]


# Testing

There are two common flavours of IMGAPI server:

- DC: `config.mode === "dc"` E.g. the IMGAPI in an SDC datacenter.
- Public: `config.mode === "public"` E.g. <https://images.joyent.com>.

There are different testing entry points for testing these.

1. Test a COAL SDC standup's IMGAPI.:

        make test-coal

2. Test an SDC standup's IMGAPI.

        $ ssh HEADNODE
        [root@headnode]# IMGAPI_ZONE=$(vmadm lookup -1 alias=imgapi0)
        [root@headnode]# /zones/$IMGAPI_ZONE/root/opt/smartdc/imgapi/test/runtests

    This will not run in a production system (guard on the
    '/lib/sdc/.sdc-test-no-production-data' file). It leaves some test data
    lieing around for faster re-runs of the test suite. You can clean up via:

        [root@headnode]# /zones/$IMGAPI_ZONE/root/opt/smartdc/imgapi/test/runtests -c

3. Test public-flavour locally:

        ./test/runtests -p -l

4. Test the *production* <https://images.joyent.com>:

        ./test/runtests -p

    To successfully run this, you also need to have the follow env setup
    (the same env setup for using the `joyent-imgadm` tool):

        JOYENT_IMGADM_USER=<username>
        JOYENT_IMGADM_IDENTITY=<signature-of-configured-key-for-username>

    These are required to authenticate with image.joyent.com's HTTP signature
    auth.


# Related Repositories

There are a number of repositories that are relevant for IMGAPI and image
management in SmartDataCenter and SmartOS.


| Repo | Description |
| ---- | ----------- |
| https://github/joyent/sdc-imgapi.git | The IMGAPI server. This repository. |
| https://github/joyent/node-sdc-clients.git | Includes imgapi.js node client library for using IMGAPI. |
| https://github/joyent/node-imgmanifest.git | Defines the SDC/SmartOS Image manifest spec and support for validation and upgrade of image manifests. |
| https://github/joyent/sdc-imgapi-cli.git | Includes the `*-imgadm` tools for common IMGAPI servers, e.g. `joyent-imgadm`, `sdc-imgadm`, `updates-imgadm` and a framework for tools for other IMGAPI servers. |
| https://github/joyent/smartos-live.git | Holds the SmartOS `imgadm` tool (in src/img). This is the tool used on any SmartOS global zone to install image datasets into the zpool to enable provisioning VMs with that image. |
