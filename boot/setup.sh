#!/usr/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2018, Joyent, Inc.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace
set -o errexit

PATH=/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin
role=imgapi

# Mount our delegated dataset at '/data' (before common setup, because
# our config-agent-written config file is under /data).
zfs set mountpoint=/data zones/$(zonename)/data

# Include common utility functions (then run the boilerplate)
source /opt/smartdc/boot/lib/util.sh
CONFIG_AGENT_LOCAL_MANIFESTS_DIRS=/opt/smartdc/$role
sdc_common_setup

# Cookie to identify this as a SmartDC zone and its role
mkdir -p /var/smartdc/$role

# Add build/node/bin and node_modules/.bin to PATH
echo "" >>/root/.profile
echo "export PATH=/opt/smartdc/$role/bin:/opt/smartdc/$role/build/node/bin:/opt/smartdc/$role/node_modules/.bin:\$PATH" >>/root/.profile
echo '[[ -f $HOME/.mantaprofile ]] && source $HOME/.mantaprofile' >>/root/.profile

LOCAL_BASE_DIR=$(/opt/smartdc/imgapi/build/node/bin/node /opt/smartdc/imgapi/lib/constants.js LOCAL_BASE_DIR)
if [[ ! -d $LOCAL_BASE_DIR ]]; then
    mkdir -p $LOCAL_BASE_DIR
fi
chown nobody:nobody $LOCAL_BASE_DIR

/usr/sbin/svccfg import /opt/smartdc/imgapi/smf/manifests/imgapi.xml

# Log rotation.
# TODO(HEAD-1365): look at current JPC log sizes for reasonable size limit.
sdc_log_rotation_add amon-agent /var/svc/log/*amon-agent*.log 1g
sdc_log_rotation_add config-agent /var/svc/log/*config-agent*.log 1g
sdc_log_rotation_add registrar /var/svc/log/*registrar*.log 1g
sdc_log_rotation_add $role /var/svc/log/*$role*.log 1g
sdc_log_rotation_setup_end

# Add metadata for cmon-agent discovery
mdata-put metricPorts 8881

# All done, run boilerplate end-of-setup
sdc_setup_complete

exit 0
