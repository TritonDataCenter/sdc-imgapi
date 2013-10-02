#!/usr/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# Copyright (c) 2013 Joyent Inc., All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

PATH=/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

role=imgapi

CONFIG_AGENT_LOCAL_MANIFESTS_DIRS=/opt/smartdc/$role

# Include common utility functions (then run the boilerplate)
source /opt/smartdc/boot/lib/util.sh
sdc_common_setup

# Cookie to identify this as a SmartDC zone and its role
mkdir -p /var/smartdc/$role

# Add build/node/bin and node_modules/.bin to PATH
echo "" >>/root/.profile
echo "export PATH=/opt/smartdc/$role/build/node/bin:/opt/smartdc/$role/node_modules/.bin:\$PATH" >>/root/.profile
echo '[[ -f $HOME/.mantaprofile ]] && source $HOME/.mantaprofile' >>/root/.profile

# Install Amon monitor and probes for IMGAPI.
TRACE=1 /opt/smartdc/imgapi/bin/imgapi-amon-install

# Log rotation.
# TODO(HEAD-1365): look at current JPC log sizes for reasonable size limit.
sdc_log_rotation_add amon-agent /var/svc/log/*amon-agent*.log 1g
sdc_log_rotation_add config-agent /var/svc/log/*config-agent*.log 1g
sdc_log_rotation_add registrar /var/svc/log/*registrar*.log 1g
sdc_log_rotation_add $role /var/svc/log/*imgapi*.log 1g
# TODO(HEAD-1365): Once ready for all sdc zones, move this to sdc_setup_complete
sdc_log_rotation_end

# All done, run boilerplate end-of-setup
sdc_setup_complete

exit 0
