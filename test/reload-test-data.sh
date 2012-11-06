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

TOP=$(unset CDPATH; cd $(dirname $0)/; pwd)


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


# mainline
$TOP/rm-test-data.sh
$TOP/sdc-ldap modify -f $TOP/test-data.ldif
