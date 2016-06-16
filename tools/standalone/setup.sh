#!/usr/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2016 Joyent, Inc.
#

#
# Setup a new zone for a standalone IMGAPI.
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


#XXX only if have a delegate dataset
## Mount our delegate dataset at '/data'.
#zfs set mountpoint=/data zones/$(zonename)/data

#XXX
## Add build/node/bin and node_modules/.bin to PATH
#echo "" >>/root/.profile
#echo "export PATH=/opt/smartdc/$role/bin:/opt/smartdc/$role/build/node/bin:/opt/smartdc/$role/node_modules/.bin:\$PATH" >>/root/.profile
#echo '[[ -f $HOME/.mantaprofile ]] && source $HOME/.mantaprofile' >>/root/.profile

#STORAGE_LOCAL_BASEDIR=$(json -f /opt/smartdc/imgapi/etc/imgapi.config.json storage.local.baseDir)
#if [[ ! -d $STORAGE_LOCAL_BASEDIR ]]; then
#    mkdir -p $STORAGE_LOCAL_BASEDIR
#fi
#chown nobody:nobody $STORAGE_LOCAL_BASEDIR

#$(/opt/local/bin/gsed -i"" -e "s/@@PREFIX@@/\/opt\/smartdc\/imgapi/g" /opt/smartdc/imgapi/smf/manifests/imgapi.xml)

# XXX how to create /data/imgapi/etc/imgapi.config.json ?

chown -R nobody:nobody /data/imgapi
/usr/sbin/svccfg import /opt/smartdc/imgapi/smf/manifests/imgapi-standalone.xml

/usr/sbin/svccfg delete svc:/pkgsrc/haproxy
/usr/sbin/svccfg import /opt/smartdc/imgapi/smf/manifests/haproxy-standalone.xml

/usr/sbin/svccfg delete svc:/pkgsrc/stud
/usr/sbin/svccfg import /opt/smartdc/imgapi/smf/manifests/stud-standalone.xml


## Log rotation.
## TODO(HEAD-1365): look at current JPC log sizes for reasonable size limit.
#sdc_log_rotation_add amon-agent /var/svc/log/*amon-agent*.log 1g
#sdc_log_rotation_add config-agent /var/svc/log/*config-agent*.log 1g
#sdc_log_rotation_add registrar /var/svc/log/*registrar*.log 1g
#sdc_log_rotation_add $role /var/svc/log/*$role*.log 1g
#sdc_log_rotation_setup_end

## All done, run boilerplate end-of-setup
#sdc_setup_complete

exit 0
