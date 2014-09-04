<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# sdc-imgapi

The Image API (IMGAPI) is the API in each SDC data center for managing
VM (i.e. KVM and Zones) images.

This repository is part of the Joyent SmartDataCenter project (SDC).  For
contribution guidelines, issues, and general documentation, visit the main
[SDC](http://github.com/joyent/sdc) project page.

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

1. Test DC-flavour locally (i.e. startup a local IMGAPI server as part of
   the test suite.):

        ./test/runtests -l

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

The `make test` target will run both #1 and #2.
