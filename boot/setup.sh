#!/usr/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# Copyright (c) 2013 Joyent Inc., All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

PATH=/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin
role=imgapi

# Include common utility functions (then run the boilerplate)
source /opt/smartdc/boot/lib/util.sh
CONFIG_AGENT_LOCAL_MANIFESTS_DIRS=/opt/smartdc/$role
sdc_common_setup

# Cookie to identify this as a SmartDC zone and its role
mkdir -p /var/smartdc/$role

# Mount our delegate dataset at '/data'.
zfs set mountpoint=/data zones/$(zonename)/data

# Add build/node/bin and node_modules/.bin to PATH
echo "" >>/root/.profile
echo "export PATH=/opt/smartdc/$role/build/node/bin:/opt/smartdc/$role/node_modules/.bin:\$PATH" >>/root/.profile
echo '[[ -f $HOME/.mantaprofile ]] && source $HOME/.mantaprofile' >>/root/.profile

STORAGE_LOCAL_BASEDIR=$(json -f /opt/smartdc/imgapi/etc/imgapi.config.json storage.local.baseDir)
if [[ ! -d $STORAGE_LOCAL_BASEDIR ]]; then
    mkdir -p $STORAGE_LOCAL_BASEDIR
    chown nobody:nobody $STORAGE_LOCAL_BASEDIR
fi

$(/opt/local/bin/gsed -i"" -e "s/@@PREFIX@@/\/opt\/smartdc\/imgapi/g" /opt/smartdc/imgapi/smf/manifests/imgapi.xml)
/usr/sbin/svccfg import /opt/smartdc/imgapi/smf/manifests/imgapi.xml

# Log rotation.
# TODO(HEAD-1365): look at current JPC log sizes for reasonable size limit.
sdc_log_rotation_add amon-agent /var/svc/log/*amon-agent*.log 1g
sdc_log_rotation_add config-agent /var/svc/log/*config-agent*.log 1g
sdc_log_rotation_add registrar /var/svc/log/*registrar*.log 1g
sdc_log_rotation_add $role /var/svc/log/*$role*.log 1g
sdc_log_rotation_setup_end

# All done, run boilerplate end-of-setup
sdc_setup_complete

exit 0
