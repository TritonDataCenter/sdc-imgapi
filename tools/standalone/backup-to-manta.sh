#!/bin/bash
#
# Copyright 2016 Joyent, Inc.
#
# Backup local IMGAPI data to Manta.
# This is intended to be run in cron (see "./setup.sh" for cron entries).
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


# ---- globals and config

export PATH=/opt/smartdc/imgapi/build/node/bin:/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

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
    fatal "error exit status $1"
}


#---- mainline

trap 'errexit $?' EXIT

echo ""
echo "--"
echo "[$(date '+%Y%m%dT%H%M%S')] Backing up to Manta"

# Get manta info from config
config="$(node /opt/smartdc/imgapi/lib/config.js)"
export MANTA_URL=$(echo "$config" | json manta.url)
[[ -n "$MANTA_URL" ]] || fatal "not configured to use Manta: no 'manta.url' in config"
export MANTA_USER=$(echo "$config" | json manta.user)
[[ -n "$MANTA_USER" ]] || fatal "not configured to use Manta: no 'manta.user' in config"
# Current manta-sync doesn't support the newer KEY_ID's, so we'll rebuild it
# from the key path.
mantaKeyPath=$(echo "$config" | json manta.key)
[[ -n "$mantaKeyPath" ]] || fatal "not configured to use Manta: no 'manta.key' in config"
export MANTA_KEY_ID=$(ssh-keygen -E md5 -lf $mantaKeyPath | awk '{print $2}' | cut -c5-)
if [[ "$(echo "$config" | json manta.insecure)" == "true" ]]; then
    export MANTA_TLS_INSECURE=1
fi
bakDir=$(echo "$config" | json manta.rootDir)/backup
echo "backup dir: $bakDir"

$MANTASYNC /data/imgapi/images $bakDir/images \
    | (grep -v "size same as source file, skipping" || true)
$MANTASYNC /data/imgapi/manifests $bakDir/manifests \
    | (grep -v "size same as source file, skipping" || true)

echo "[$(date '+%Y%m%dT%H%M%S')] Done backing up"

#
# vim: set softtabstop=4 shiftwidth=4:
#
