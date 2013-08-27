#!/bin/sh
#
# Usage:
#   ./install-seed-packages-ams-1.sh [-o <owner_uuid>]
#
# The default <owner_uuid> is the Joyent_Dev user
# (uuid 7b315468-c6be-46dc-b99b-9c1f59224693)
#

TOP=$(cd $(dirname $0)/ >/dev/null; pwd)

UUID1=13cb578f-ea98-e949-82bd-caca11346f7c
UUID2=274eebf2-fc53-724c-ae39-2bdf50334712
UUID3=94bb92fc-57a8-ac42-aa20-82dad16b8906
UUID4=15d98def-6acf-ca47-b1ed-2254a0468c2d
# The JPC 'Joyent_Dev' user.
IN_OWNER_UUID=7b315468-c6be-46dc-b99b-9c1f59224693
# The Joyent-SDC-Public and Joyent-SDC-Private network pools.
NETWORKS='["1e7bb0e1-25a9-43b6-bb19-f79ae9540b39", "193d6804-256c-4e89-a4cd-46f045959993"]'

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

