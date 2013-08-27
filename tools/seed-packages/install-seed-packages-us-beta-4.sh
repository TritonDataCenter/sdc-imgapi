#!/bin/sh
#
# Usage:
#   ./install-seed-packages-us-beta-4.sh [-o <owner_uuid>]
#
# The default <owner_uuid> is the Joyent_Dev user
# (uuid 7b315468-c6be-46dc-b99b-9c1f59224693)
#

TOP=$(cd $(dirname $0)/ >/dev/null; pwd)

UUID1=d6cbefc0-8678-3b45-afd2-ce5864249c25
UUID2=8c3710d8-bf7e-e54d-9452-60cce2a0fa70
UUID3=dc0c1879-349b-8a45-902a-0097e23ec98b
UUID4=147ba2ea-a518-7f49-8f75-041243789044
# The JPC 'Joyent_Dev' user.
IN_OWNER_UUID=7b315468-c6be-46dc-b99b-9c1f59224693
# 'external' network on us-beta-4
NETWORKS='["213fb868-f613-46df-90db-b85c60ffaa05"]'

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

