#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2017, Joyent, Inc.
#

#
# (Re-)deploy a staging version of updates.joyent.com to Joyent Engineering's
# staging DC. This will use the latest "imgapi" image in the updates.joyent.com
# *experimental* channel.
#

if [ "$TRACE" != "" ]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


# ---- config

# Staging updates.jo config:
SVC_NAME=stagingupdatesjo
ALIAS=${SVC_NAME}0
MBASEDIR=imgapi/${SVC_NAME}


SSH_OPTIONS="-q -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
if [[ -n "$TRACE" ]]; then
    TRACE_OPT="-v"
else
    TRACE_OPT=""
fi


#---- support stuff

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

function usage
{
    echo "Usage:"
    echo "    redeploy-staging-updatesjo.sh [OPTIONS...] HEADNODE TRITON-CLI-PROFILE"
    echo ""
    echo "Options:"
    echo "    -h            Print this help and exit."
    echo "    -C CHANNEL    Update.jo channel from which to pull latest image."
    echo "                  Default is 'dev'."
    echo ""
    echo "where HEADNODE is the ssh '[user@]host' argument for accessing the"
    echo "headnode GZ and where TRITON-CLI-PROFILE is a triton CLI profile"
    echo "name."
    echo ""
    echo "Currently this script requires that the target DC have an"
    echo "associated Manta -- i.e. one using the same user database -- so that"
    echo "keys can be added via 'triton key ...' to update Manta access."
    echo "A common target is staging-1 (in the eng lab). For example:"
    echo "    redeploy-staging-updatesjo.sh root@172.26.3.4 staging1"
}


# ---- mainline

trap 'errexit $?' EXIT

optChannel=dev
while getopts "hC:" opt
do
    case "$opt" in
        h)
            usage
            exit 0
            ;;
        C)
            optChannel=$OPTARG
            ;;
        *)
            usage
            exit 1
            ;;
    esac
done
shift $((OPTIND - 1))

export HEADNODE=$1
[[ -n "$HEADNODE" ]] || fatal "missing HEADNODE arg"
export TRITON_PROFILE=$2
[[ -n "$TRITON_PROFILE" ]] || fatal "missing TRITON-CLI-PROFILE arg"


# Gather info.
profileUrl=$(triton profile get -j | json url)
profileAccount=$(triton profile get -j | json account)
if [[ "$profileAccount" == "Joyent_Dev" \
        || "$profileAccount" == "Joyent_SW" ]]; then
    fatal "cannot continue with account '$profileAccount' (from the given" \
        "profile '$TRITON_PROFILE'), because we want to carefully avoid" \
        "accidentally destroying production assets"
fi
profileKeyId=$(triton profile get -j | json keyId)

isHeadnode=$(ssh $SSH_OPTIONS $HEADNODE pfexec sysinfo | json "Boot Parameters.headnode")
[[ $isHeadnode == "true" ]] \
    || fatal "headnode $HEADNODE is not a headnode? isHeadnode=$isHeadnode"

if [[ "${profileUrl: -18}" == ".staging.joyent.us" ]]; then
    mantaUrl=https://manta.staging.joyent.us
elif [[ "${profileUrl: -15}" == ".api.joyent.com" ]]; then
    mantaUrl=https://us-east.manta.joyent.com
else
    fatal "cannot determine Manta URL associated with CloudAPI $profileUrl"
fi
mantaUser=$profileAccount

# Find a reasonable 2G package to use.
packageName=$(triton -p staging1 pkgs memory=2048 -Ho name | grep -v '^g3')


# Show info and confirm.
echo "# Redeploying Staging updates.jo ($SVC_NAME)"
echo "    datacenter: $profileUrl"
echo "    account:    $profileAccount"
echo "    package:    $packageName"
echo "    manta area: $mantaUrl/$mantaUser/stor/$MBASEDIR"
echo ""
printf "Do you want to continue? [y/N] "
read answer
echo ""
if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    echo "Aborting."
    exit 0
fi


# Redeploy.

echo ""
echo "# Remove existing 'imgapi-$ALIAS-*' key(s) from account '$profileAccount'"
triton keys -H -o name \
    | (grep "^imgapi-$ALIAS-" || true) \
    | xargs triton key rm -y

# Ensure authkeys are in place ahead of the instance creation so they are
# picked up on first startup.
echo ""
echo "# Deploy authkeys"
mmkdir -p ~~/stor/$MBASEDIR/authkeys
triton keys -A | mput ~~/stor/$MBASEDIR/authkeys/${profileAccount}.keys

# Find and delete an existing instance.
echo ""
echo "# Delete existing deployment"
triton ls name=$ALIAS -Ho id | xargs triton rm -w

# Create the instance.
echo ""
echo "# Create new instance"
ssh -T $SSH_OPTIONS $HEADNODE <<SCRIPT
    if [[ -n "$TRACE" ]]; then
        export PS4='\${BASH_SOURCE}:\${LINENO}: \${FUNCNAME[0]:+\${FUNCNAME[0]}(): }'
        set -o xtrace
    fi
    set -o errexit
    set -o pipefail

    cd /var/tmp
    curl -kOsS https://raw.githubusercontent.com/joyent/sdc-imgapi/master/bin/imgapi-standalone-create
    chmod +x imgapi-standalone-create

    ./imgapi-standalone-create \
        -m mode=private \
        -m channels=standard \
        -m mantaUrl=$mantaUrl \
        -m mantaUser=$mantaUser \
        -m mantaBaseDir=$MBASEDIR \
        -t triton.cns.services=$SVC_NAME \
        -C $optChannel \
        $profileAccount latest $packageName $ALIAS
SCRIPT

# Remove any old keys for this service, and add the new one.
echo ""
echo "# Add new deployed instance key to Manta account"
triton inst get $ALIAS | json metadata.instPubKey | triton key add -

# There currently isn't a good way to wait for a new key to make it through
# Manta. Polling to check for a successful auth can pass on one request
# and then fail later on another request if one hits separate Manta webapis.
echo "Waiting for 2 minutes in hopes that Manta takes up the new key by then..."
sleep 120

# Step 4 (from IMGAPI Operator Guide): imgapi-standalone-restore
echo ""
echo "# Restore backups to new instance"
triton ssh $ALIAS $SSH_OPTIONS <<SCRIPT2
    if [[ -n "$TRACE" ]]; then
        export PS4='\${BASH_SOURCE}:\${LINENO}: \${FUNCNAME[0]:+\${FUNCNAME[0]}(): }'
        set -o xtrace
    fi
    set -o errexit
    set -o pipefail

    if [[ -f /data/imgapi/run/restored.marker ]]; then
        exit 0
    fi

    /opt/smartdc/imgapi/bin/imgapi-standalone-restore -y $TRACE_OPT
    exit 0
SCRIPT2

# Test it.
echo ""
echo "# Sanity test the deployment"
export UPDATES_IMGADM_URL=https://$(triton inst get $ALIAS \
    | json dns_names | json -a | grep svc.$profileAccount)
export UPDATES_IMGADM_USER=$profileAccount
export UPDATES_IMGADM_IDENTITY=$profileKeyId
export UPDATES_IMGADM_INSECURE=1
updates-imgadm ping
# Don't die on images without "channels" support in setup config.
updates-imgadm channels || true

echo ""
echo "# Staging updates.jo has been successfully deployed"
echo "# 'updates-imgadm' environment for staging updates.jo"
env | grep UPDATES_IMGADM | sed -e 's/^/export /'
