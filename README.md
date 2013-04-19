# Image API

- Repository: <git@git.joyent.com:imgapi.git>, <https://mo.joyent.com/imgapi>
- Who: Trent Mick
- API Docs: <https://mo.joyent.com/docs/imgapi>
- XMPP/Jabber: <mib@groupchat.joyent.com>
- Tickets/bugs: <https://devhub.joyent.com/jira/browse/IMGAPI>
- CI builds: <https://jenkins.joyent.us/job/imgapi>,
  <https://bits.joyent.us/builds/imgapi/>


# Overview

The Image API (IMGAPI) is the API in each SDC data center for managing
vm (i.e. kvm and zones) images. IOW, this is the new Dataset API (DSAPI).
`IMGAPI : SDC 7 :: DSAPI : SDC 6.5`.


# Development

    git clone git@git.joyent.com:imgapi.git
    cd imgapi
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
