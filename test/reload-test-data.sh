#!/bin/bash
#
# (Re-)load test data.
# This will delete any existing items with the same DN.
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
    # Hack in $manifestsDatabaseDir/$uuid.raw for each image in test-data.ldif.
    CFG_FILE=$TOP/test/imgapi-config-local-$opt_mode.json
    raw_dir=$(json database.dir <$CFG_FILE)
    if [[ ! -d $raw_dir ]]; then
        mkdir -p $raw_dir
    fi
    test_images=$($TOP/test/ldif2json $TOP/test/test-data.ldif | json -c 'objectclass=="sdcimage"')
    num_test_images=$(echo "$test_images" | json length)
    i=0
    while [[ $i < $num_test_images ]]; do
        image=$(echo "$test_images" | json $i | json -e 'this.changetype=undefined')
        uuid=$(echo "$image" | json uuid)
        raw_path=$raw_dir/$uuid.raw
        echo "$image" >$raw_path
        i=$(($i + 1))
    done
elif [[ "$opt_mode" == "dc" ]]; then
    $TOP/test/sdc-ldap modify -f $TOP/test/test-data.ldif

    # Load image into moray with putobject
    CFG_FILE=$TOP/etc/imgapi.config.json
    test_images=$TOP/test/test-data.json
    num_test_images=$(json length <$test_images)
    i=0
    while [[ $i < $num_test_images ]]; do
        image=$(json $i <$test_images)
        uuid=$(echo "$image" | json uuid)
        echo "Adding $uuid"
        MORAY_URL=moray://$(json moray.host <$CFG_FILE) $TOP/test/putobject -d "$image" imgapi_images $uuid
        i=$(($i + 1))
    done
else
    echo "# No test data is loaded for images.joyent.com test."
fi
