<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2016 Joyent, Inc.
-->

# sdc-imgapi

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md) --
*Triton does not use GitHub PRs* -- and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

The Image API (IMGAPI) is the API in each Triton data center for managing
instance images. It is also the software behind standalone IMGAPI services
like <https://images.joyent.com> and <https://updates.joyent.com>.


# Development

For an IMGAPI running as part of a Triton DataCenter, please start with a
[CoaL setup](https://github.com/joyent/triton#getting-started). Then a common
dev cycle goes something like this:

    # Make local changes:
    git clone git@github.com:joyent/sdc-imgapi.git
    cd sdc-imgapi
    make

    # Sync local changes to the "imgapi0" zone in CoaL:
    ./tools/rsync-to root@10.99.99.7

Note that this has limitations in that binary modules from, say, a Mac
laptop obviously cannot be sync'd to the SmartOS imgapi0 zone.

* * *

For a standalone IMGAPI, see the [Operator Guide](./docs/operator-guide.md)
for deployment and update details.


# Testing

A `mode=dc` IMGAPI's test suite is run as follows:

    ssh HEADNODE   # e.g. ssh root@10.99.99.7

    # Indicate that this is a non-production DC.
    touch /lib/sdc/.sdc-test-no-production-data

    sdc-login -l imgapi
    /opt/smartdc/imgapi/test/runtests

The test suite leaves some test data lying around for faster re-runs of the
test suite. You can clean up via:

    sdc-login -l imgapi /opt/smartdc/imgapi/test/runtests -c

* * *

For standalone IMGAPI instances the test suite is currently broken.


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
