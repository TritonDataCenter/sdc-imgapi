#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

#
# (Re-)load test data.
#
# Usage:
#   ./test/reload-test-data.sh
#

if [[ -n "$TRACE" ]]; then
    export PS4='${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


TOP=$(unset CDPATH; cd $(dirname $0)/../; pwd)


#---- support functions

function usage
{
    echo "Usage:"
    echo "  ./test/reload-test-data.sh [OPTIONS...]"
    echo ""
    echo "Options:"
    echo "  -l          Reload data for an imgapi using 'test/local.json'."
}

function fatal
{
    echo "$(basename $0): fatal error: $*"
    exit 1
}

function cleanup () {
    local status=$?
    if [[ $status -ne 0 ]]; then
        echo "error $status (run 'TRACE=1 $0' for more info)"
    fi
}
trap 'cleanup' EXIT


#---- mainline

# Options.
opt_local=
opt_mode=dc
while getopts "lp" opt
do
    case "$opt" in
        l)
            opt_local=yes
            ;;
        p)
            opt_mode=public
            ;;
        *)
            usage
            exit 1
            ;;
    esac
done

$TOP/test/rm-test-data.sh $*
if [[ -n "$opt_local" ]]; then
    # Hack in $manifestsDatabaseDir/$uuid.raw for each image
    # in MODE-test-images.json.
    manifest_dir=/data/imgapi/manifests
    if [[ ! -d $manifest_dir ]]; then
        mkdir -p $manifest_dir
    fi
    stor_dir=$(node $TOP/lib/constants.js LOCAL_BASE_DIR)
    if [[ ! -d $stor_dir ]]; then
        mkdir -p $stor_dir
    fi
    test_images=$TOP/test/$opt_mode-test-images.json
    num_test_images=$(cat "$test_images" | json length)
    i=0
    while [[ $i < $num_test_images ]]; do
        image=$(cat "$test_images" | json $i)
        uuid=$(echo "$image" | json uuid)
        raw_path=$manifest_dir/$uuid.raw
        echo "$image" >$raw_path
        file_path=$stor_dir/images/${uuid:0:3}/$uuid/file0
        mkdir -p $(dirname $file_path)
        echo "file" >$file_path
        icon_path=$stor_dir/images/${uuid:0:3}/$uuid/icon
        mkdir -p $(dirname $icon_path)
        echo "icon" >$icon_path
        i=$(($i + 1))
    done
elif [[ "$opt_mode" == "dc" ]]; then
    $TOP/test/sdc-ldap modify -f $TOP/test/dc-test-users.ldif

    # Load image into moray with putobject
    CFG_FILE=/data/imgapi/etc/imgapi.config.json
    test_images=$TOP/test/dc-test-images.json
    num_test_images=$(json length <$test_images)
    stor_dir=$(node $TOP/lib/constants.js LOCAL_BASE_DIR)
    i=0
    while [[ $i < $num_test_images ]]; do
        image=$(json $i <$test_images)
        uuid=$(echo "$image" | json uuid)
        echo "Adding $uuid"
        MORAY_URL=moray://$(json moray.host <$CFG_FILE) $TOP/test/putobject -d "$image" imgapi_images $uuid
        # Add local file object.
        file_path=$stor_dir/images/${uuid:0:3}/$uuid/file0
        mkdir -p $(dirname $file_path)
        echo "file" >$file_path
        icon_path=$stor_dir/images/${uuid:0:3}/$uuid/icon
        mkdir -p $(dirname $icon_path)
        echo "icon" >$icon_path
        i=$(($i + 1))
    done
    # Change image ownership, as imgapi runs as user 'nobody'.
    chown -R nobody:nobody /data/imgapi/images
fi
