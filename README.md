# Image API

- Repository: <git@git.joyent.com:imgapi.git>, <https://mo.joyent.com/imgapi>
- Who: Trent Mick, Trevor O
- API Docs: <https://mo.joyent.com/docs/imgapi>
- XMPP/Jabber: <mib@groupchat.joyent.com>
- Tickets/bugs: <https://devhub.joyent.com/jira/browse/IMGAPI>
- CI builds: <https://jenkins.joyent.us/job/imgapi>,
  <https://stuff.joyent.us/stuff/builds/imgapi/>

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

TODO
