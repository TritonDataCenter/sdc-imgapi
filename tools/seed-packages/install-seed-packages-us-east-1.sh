#!/bin/sh
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

#
# Usage:
#   ./install-seed-packages-us-east-1.sh [-o <owner_uuid>]
#
# The default <owner_uuid> is the Joyent_Dev user
# (uuid 7b315468-c6be-46dc-b99b-9c1f59224693)
#

TOP=$(cd $(dirname $0)/ >/dev/null; pwd)

UUID1=92e2b20a-0c37-11e3-9605-63a778146273
UUID2=9c1948c0-0c37-11e3-be34-5780f9789210
UUID3=a3501ccc-0c37-11e3-965d-ef7e825515c9
UUID4=b1575678-0c37-11e3-8a27-63052c0a42c1
# The JPC 'Joyent_Dev' user.
IN_OWNER_UUID=7b315468-c6be-46dc-b99b-9c1f59224693
# The Joyent-SDC-Public and Joyent-SDC-Private network pools.
NETWORKS='["9ec60129-9034-47b4-b111-3026f9b1a10f", "5983940e-58a5-4543-b732-c689b1fe4c08"]'

# Options.
while getopts "o:" opt
do
    case "$opt" in
        o)
            # TODO: valid this is a UUID
            IN_OWNER_UUID=$OPTARG
            UUID1=$(uuid)
            UUID2=$(uuid)
            UUID3=$(uuid)
            UUID4=$(uuid)
            ;;
        *)
            echo "$0: fatal error: unknown option: $opt"
            exit 1
            ;;
    esac
done

if [[ ! -f $TOP/seed.ldif.in ]]; then
    echo "$0: fatal error: '$TOP/seed.ldif.in' does not exist" >&2
    exit 1
fi
sed -e "
    s|IN_UUID1|$UUID1|;
    s|IN_UUID2|$UUID2|;
    s|IN_UUID3|$UUID3|;
    s|IN_UUID4|$UUID4|;
    s|IN_OWNER_UUID|$IN_OWNER_UUID|;
    s|IN_NETWORKS|$NETWORKS|;
    " $TOP/seed.ldif.in >/tmp/seed-packages.ldif
sdc-ldap add -f /tmp/seed-packages.ldif

