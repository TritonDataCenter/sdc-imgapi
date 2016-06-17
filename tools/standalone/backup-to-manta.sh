#!/bin/bash
#
# Copyright 2016 Joyent, Inc.
#
# Backup local IMGAPI data to Manta.
# This is intended to be run in cron. See 'backup-to-manta.cron'.
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


# ---- globals and config

export PATH=/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

MANTASYNC=/opt/smartdc/imgapi/node_modules/.bin/manta-sync
CONFIG=/data/imgapi/etc/imgapi.config.json


# ---- support functions

function fatal
{
    echo "$0: fatal error: $*"
    exit 1
}

function errexit
{
    [[ $1 -ne 0 ]] || exit 0
    if [[ -n "$adminEmail" ]]; then
    mail "$ADMIN_EMAIL" <<EOM
Subject: backup-to-manta on $(hostname) ($(zonename)) failed: $1
From: "backup-to-manta" <root@$(hostname)>

Exit status: $1
See the log: /var/log/backup-to-manta.log
EOM
    fi
    fatal "error exit status $1"
}


#---- mainline

trap 'errexit $?' EXIT

echo ""
echo "--"
echo "[$(date '+%Y%m%dT%H%M%S')] Backing up to Manta"

#XXX
#adminEmail=$(json -f $CONFIG adminEmail)
export MANTA_URL=$(json -f $CONFIG storage.manta.url)
export MANTA_USER=$(json -f $CONFIG storage.manta.user)
# Current manta-sync doesn't support the newer KEY_ID's, so we'll rebuild it
# from the key path.
mantaKeyPath=$(json -f $CONFIG storage.manta.key)
export MANTA_KEY_ID=$(ssh-keygen -E md5 -lf $mantaKeyPath | awk '{print $2}' | cut -c5-)
if [[ "$(json -f $CONFIG storage.manta.insecure)" == "true" ]]; then
    export MANTA_TLS_INSECURE=1
fi
bakDir=/$MANTA_USER/stor/$(json -f $CONFIG storage.manta.baseDir)/backup
echo "backup dir: $bakDir"

$MANTASYNC /data/imgapi/images $bakDir/images \
    | (grep -v "size same as source file, skipping" || true)
$MANTASYNC /data/imgapi/manifests $bakDir/manifests \
    | (grep -v "size same as source file, skipping" || true)

echo "[$(date '+%Y%m%dT%H%M%S')] Done backing up"

#
# vim: set softtabstop=4 shiftwidth=4:
#
