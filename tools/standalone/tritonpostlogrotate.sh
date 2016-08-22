#!/usr/bin/bash
# vi: sw=4 ts=4 et
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2016 Joyent, Inc.
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


export PATH=/opt/local/bin:$PATH

SRCDIR=/var/log/triton
DSTDIR=/var/log/triton/upload
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
    echo "Move a just rotated-by-logadm Triton log file from /var/log/triton to"
    echo "/var/log/triton/upload (possibly renaming the timestamp)."
    echo ""
    echo "Requirements:"
    echo "1. The 'just rotated' log file is expected to be of the form:"
    echo "       \$logname_\$nodename_YYYYMMDDTHHMMSS.log"
    echo "2. The '\$logname' cannot contain an underscore."
    echo ""
    echo "Usage:"
    echo "    tritonpostrotatelog.sh [-q] [-f] [-m] LOGNAME"
    echo ""
    echo "Options:"
    echo "     -h   Print this help and exit."
    echo "     -q   Quiet output."
    echo "     -m   Move ('mv') rotated files from /var/log/triton/*.log"
    echo "          to /var/log/triton/upload/*.log, rather than the default"
    echo "          to hardlink ('ln'). This allows one to delete logs as"
    echo "          as soon as they are uploaded, e.g. if you never want to"
    echo "          look at them locally and size is a potential constraint."
    echo "     -f   Roll the latest rotated log file *forward* to the next"
    echo "          hour. E.g., '...T091234.log' will be rolled to"
    echo "          '...T100000.log'. This is to support more-than-once-per-hour"
    echo "          rotations ending up as one correct hourly log file in"
    echo "          Manta -- which is needed to not lose log data through a"
    echo "          'vmadm reprovision'."
    echo ""
    echo "Example: 'tritonpostrotatelog.sh imgapi' might rotate this:"
    echo "    /var/log/triton/imgapi_imagesjo0_20151225T110003.log"
    echo "to this:"
    echo "    /var/log/triton/upload/imgapi_imagesjo0_20151225T110000.log"
}

#---- mainline

trap 'errexit $?' EXIT

# Options.
opt_verbose=yes
opt_action=ln
opt_rolldir=bwd
while getopts "hqfm" opt
do
    case "$opt" in
        h)
            usage
            exit 0
            ;;
        q)
            opt_verbose=
            ;;
        f)
            opt_rolldir=fwd
            ;;
        m)
            opt_action=mv
            ;;
        *)
            usage
            exit 1
            ;;
    esac
done
shift $((OPTIND - 1))

logname=$1
[[ -z "$logname" ]] && fatal "LOGNAME argument not given"
if [[ -n "$(echo "$logname" | (grep _ || true))" ]]; then
    fatal "a logname may not contain an underscore: $logname"
fi


lastlog=$(ls -1t /var/log/triton/${logname}_*_????????T??????.log | head -1)
if [[ "$opt_rolldir" == "bwd" ]]; then
    base=$(echo $lastlog | cut -d: -f1)   # '/var/log/sdc/upload/$logname...T23'
    targ=$DSTDIR/$(basename $lastlog | sed -E 's/[0-9][0-9]\.log$/00.log/')
else
    # Roll forward.
    base=$(basename $lastlog | sed -E 's/_[0-9T]+\.log$//')
    datestr=$(echo $lastlog | awk '{ FS="_"; print $NF }' | cut -d. -f1)
    isotime=$(echo $datestr | strptime -i '%Y%m%dT%H%M%S' -f '%Y-%m-%dT%H:%M:%S')
    # Note: GZ /usr/bin/date doesn't support -d.
    hourfwd=$($DATE -d \@$(( $($DATE -d $isotime "+%s") + 3600 )) "+%Y%m%dT%H0000")
    targ="$DSTDIR/${base}_${hourfwd}.log"
fi

[[ -z "$opt_verbose" ]] || echo "$opt_action $lastlog $targ"
if [[ "$opt_action" == "mv" ]]; then
    mv $lastlog $targ
elif [[ "$opt_action" == "ln" ]]; then
    ln $lastlog $targ
else
    fatal "unknown action: $opt_action"
fi
