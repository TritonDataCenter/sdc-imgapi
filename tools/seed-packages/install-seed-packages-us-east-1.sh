#!/bin/sh

TOP=$(cd $(dirname $0)/ >/dev/null; pwd)

UUID1=92e2b20a-0c37-11e3-9605-63a778146273
UUID2=9c1948c0-0c37-11e3-be34-5780f9789210
UUID3=a3501ccc-0c37-11e3-965d-ef7e825515c9
UUID4=b1575678-0c37-11e3-8a27-63052c0a42c1
NETWORKS='["9ec60129-9034-47b4-b111-3026f9b1a10f", "5983940e-58a5-4543-b732-c689b1fe4c08"]'

if [[ ! -f $TOP/seed.ldif.in ]]; then
    echo "$0: fatal error: '$TOP/seed.ldif.in' does not exist" >&2
    exit 1
fi
sed -e "
    s|IN_UUID1|$UUID1|;
    s|IN_UUID2|$UUID2|;
    s|IN_UUID3|$UUID3|;
    s|IN_UUID4|$UUID4|;
    s|IN_NETWORKS|$NETWORKS|;
    " $TOP/seed.ldif.in >/tmp/seed-packages.ldif
sdc-ldap add -f /tmp/seed-packages.ldif

