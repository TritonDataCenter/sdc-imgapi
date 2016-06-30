#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2016 Joyent, Inc.
#

#
# Upload Triton log files in /var/log/triton/upload/ to Manta.
#
# Typically this script is setup to run after logadm does it rotations.
# This will make *5* upload attempts with 60s gaps. This is to allow
# log rotation to complete. 
#
#       0 * * * * /usr/sbin/logadm -v >>/var/log/logadm.log 2>&1
#       1 * * * * /.../tritonlogupload.sh -a 5 >>/var/log/tritonlogupload.log 2>&1
#
# Currently this is hardcoded for standalone IMGAPI usage, getting
# manta config info from $CONFIG. TODO: generalize this.
#
# Based on https://github.com/joyent/manta-scripts/blob/master/backup.sh
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


export PATH=/opt/local/bin:/opt/smartdc/imgapi/node_modules/.bin:$PATH

SRCDIR=/var/log/triton/upload
CONFIG=/data/imgapi/etc/imgapi.config.json
DATE=/opt/local/bin/date


#---- support functions

function fatal() {
    echo "$0: error: $*" >&2
    exit 1
}

function errexit
{
    [[ $1 -ne 0 ]] || exit 0
    fatal "error exit status $1"
}

function usage () {
    echo "Upload Triton log files in /var/log/triton/upload to Manta."
    echo ""
    echo "Requirements:"
    echo "1. The log files are expected to be of the form:"
    echo "       $logname_$nodename_YYYYMMDDTHH0000.log"
    echo "2. The '$logname' cannot contain an underscore."
    echo ""
    echo "The files are uploaded to:"
    echo "    /$account/stor/$baseDir/logs/$logname/YYYY/MM/DD/HH/$nodename.log"
    echo "where the hour dir is an hour *previous*."
    echo ""
    echo "Usage:"
    echo "    tritonlogupload.sh [-h]"
    echo ""
    echo "Options:"
    echo "     -h       Print this help and exit."
    echo "     -n       Dry-run."
    echo "     -a N     Number of attempts (with 60s gap between attempts)."
    echo "              Multiple attempts can be useful to run this once but"
    echo "              give time to logadm to finish rotating logs."
}

function upload_files() {
    local dryrun
    dryrun=$1

    # Looking for $logname_$nodename_YYYYMMDDTHHMMSS.log files.
    files=$(ls -1 $SRCDIR/ | (egrep '.*_.*_........T......\.log' || true))
    if [[ -z "$files" ]]; then
        echo "no files to upload"
        return
    fi

    nfiles=$(echo "$files" | wc -l)
    echo "upload $nfiles file(s) from $SRCDIR to $dstMdir"
    for f in $files
    do
        base=$(basename $f)
        logname=$(echo $base | cut -d _ -f 1)
        # Assume no '_' in nodename for now.
        nodename=$(echo $base | cut -d _ -f 2)
        datestr=$(echo $base | awk '{ FS="_"; print $NF }' | cut -d. -f1)
        isotime=$(echo $datestr | strptime -i '%Y%m%dT%H%M%S' -f '%Y-%m-%dT%H:%M:%S')
        # Note: GZ /usr/bin/date doesn't support -d.
        hourdir=$($DATE -d \@$(( $($DATE -d $isotime "+%s") - 3600 )) "+%Y/%m/%d/%H")
        targ="$dstMdir/$logname/$hourdir/$nodename.log"

        upload_file $SRCDIR/$f $targ $dryrun
        echo "rm $SRCDIR/$f"
        if [[ $dryrun == "no" ]]; then
            rm $SRCDIR/$f
        fi
    done
}

function upload_file() {
    local src dst dryrun
    src=$1
    dst=$2
    dryrun=$3
    echo "upload $src to $dst"
    if [[ $dryrun == "no" ]]; then
        mput -q -p -H "Content-Type: text/plain" -f $src $dst
    fi
}


#---- mainline

trap 'errexit $?' EXIT

# Options.
opt_dryrun=no
opt_numattempts=1
while getopts "hna:" opt
do
    case "$opt" in
        h)
            usage
            exit 0
            ;;
        n)
            opt_dryrun=yes
            ;;
        a)
            opt_numattempts=$OPTARG
            ;;
        *)
            usage
            exit 1
            ;;
    esac
done
shift $((OPTIND - 1))


export MANTA_URL=$(json -f $CONFIG storage.manta.url)
export MANTA_USER=$(json -f $CONFIG storage.manta.user)
export MANTA_KEY_ID=$(json -f $CONFIG storage.manta.keyId)
if [[ "$(json -f $CONFIG storage.manta.insecure)" == "true" ]]; then
    export MANTA_TLS_INSECURE=1
fi
dstMdir=/$MANTA_USER/stor/$(json -f $CONFIG storage.manta.baseDir)/logs

echo ""
n=1
while true; do
    echo "[$(date '+%Y%m%dT%H%M%S')] upload_files attempt $n (dryrun=$opt_dryrun)"
    upload_files $opt_dryrun
    echo "[$(date '+%Y%m%dT%H%M%S')] done upload_files attempt $n"
    n=$(( $n + 1 ))
    if [[ $n -gt $opt_numattempts ]]; then
        break
    fi
    sleep 60
done

