#!/bin/sh
#
# Usage:
#   ./install-seed-packages-us-sw-1.sh [-o <owner_uuid>]
#
# The default <owner_uuid> is the Joyent_Dev user
# (uuid 7b315468-c6be-46dc-b99b-9c1f59224693)
#

TOP=$(cd $(dirname $0)/ >/dev/null; pwd)

UUID1=6643247a-a769-424a-9f5b-a5e32ed4aaf5
UUID2=7e4ce13d-0bf6-5b43-9a65-684cc8723ca0
UUID3=0a54a104-0387-774f-9b97-2e3e593e23ef
UUID4=1fbd34f4-890e-4846-8094-2e86946df2b3
# The JPC 'Joyent_Dev' user.
IN_OWNER_UUID=7b315468-c6be-46dc-b99b-9c1f59224693
# The Joyent-SDC-Public and Joyent-SDC-Private network pools.
NETWORKS='["f7ed95d3-faaf-43ef-9346-15644403b963", "1fc62c97-c1f0-41c6-9ef7-1f7ebe0ff09a"]'

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

