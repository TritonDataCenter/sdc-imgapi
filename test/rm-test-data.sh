#!/bin/bash
#
# Remove the test data.
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\t] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


TOP=$(unset CDPATH; cd $(dirname $0)/../; pwd)


#---- support functions

function usage
{
    echo "Usage:"
    echo "  ./test/rm-test-data.sh [OPTIONS...]"
    echo ""
    echo "Options:"
    echo "  -l          Remove data for a *local* testing imgapi."
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


if [[ -n "$opt_local" ]]; then
    CFG_FILE=$TOP/test/imgapi-config-local-$opt_mode.json
    rm -rf $(json database.dir <$CFG_FILE)
    rm -rf $(json storage.local.dir <$CFG_FILE)
elif [[ "$opt_mode" == "dc" ]]; then
    # Load image into moray with putobject
    CFG_FILE=$TOP/etc/imgapi.config.json
    uuids="c58161c0-2547-11e2-a75e-9fdca1940570"
    uuids+=" 47e6af92-daf0-11e0-ac11-473ca1173ab0"
    uuids+=" 1fc068b0-13b0-11e2-9f4e-2f3f6a96d9bc"
    uuids+=" 583287ae-366b-11e2-aea4-bf6c552eb39b"

    for uuid in $uuids; do
        echo "Deleting $uuid"
        MORAY_URL=moray://$(json moray.host <$CFG_FILE) $TOP/test/delobject imgapi_images $uuid
        i=$(($i + 1))
    done

    # All the test users.
    dns=" $(grep '^dn' $TOP/test/dc-test-users.ldif | cut -d' ' -f2- | sed 's/, /,/g' | xargs)"
    for dn in $dns; do
        dn=$(echo $dn | sed 's/,/, /g')
        uuid_query=$(echo $dn | cut -d, -f1)
        if [[ -n "$($TOP/test/sdc-ldap search "$uuid_query")" ]]; then
            echo "Deleting '$dn'."
            $TOP/test/sdc-ldap rm "$dn"
        fi
    done
fi

rm -rf /var/tmp/imgapi-test-file-*
rm -rf /var/tmp/image-test-file-*
rm -rf /var/tmp/dataset-test-file-*
