#!/usr/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2017 Joyent, Inc.
#

#
# Generate a new instance key, and write it to /data/imgapi/etc/newinstkey
#
# This will also remove any imgapi-* files in that dir. I.e. the contract is
# that after successful return, there will be a single key in that dir.
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


keyType=ecdsa
nodeName=imgapi-$(mdata-get sdc:alias)-$(zonename | cut -d- -f1)
keyName=$nodeName-$(date -u '+%Y%m%dT%H%M%S')
keyDir=/data/imgapi/etc/newinstkey

mkdir -p $keyDir
rm -rf $keyDir/imgapi-*
ssh-keygen -t $keyType -b 256 -N "" \
    -C "$keyName" -f $keyDir/$keyName.id_$keyType
