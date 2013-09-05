#!/bin/sh
#
# Usage:
#   ./install-seed-packages-us-east-1.sh [-o <owner_uuid>]
#
# The default <owner_uuid> is the Joyent_Dev user
# (uuid 7b315468-c6be-46dc-b99b-9c1f59224693)
#

TOP=$(cd $(dirname $0)/ >/dev/null; pwd)

UUID1=25fb809a-f618-7244-b80a-2e503807d468
UUID2=b7fe869a-3be8-e944-b652-79540573f908
UUID3=4796f039-b500-c547-a65b-a5315303ab89
UUID4=a8cdc7ec-740a-d14b-8a0e-3074384111c4
# The JPC 'Joyent_Dev' user.
IN_OWNER_UUID=7b315468-c6be-46dc-b99b-9c1f59224693
# The Joyent-SDC-Public and Joyent-SDC-Private network pools.
NETWORKS='["42325ea0-eb62-44c1-8eb6-0af3e2f83abc", "c8cde927-6277-49ca-82a3-741e8b23b02f"]'

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

