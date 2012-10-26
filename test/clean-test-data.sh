#!/usr/bin/env bash
#
# Clean out Amon test data.
#
# Usage:
#       ./clean-test-data.sh [-q]
#

if [[ -n "$TRACE" ]]; then
    export PS4='${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


TOP=$(unset CDPATH; cd $(dirname $0)/../; pwd)


#---- support functions

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

function imgapi() {
    [[ -z "$IMGAPI_URL" ]] && fatal "'IMGAPI_URL' is not set"
    local path=$1
    shift
    curl --connect-timeout 10 -sS $IMGAPI_URL$path "$@"
}

function ufdsdelete() {
    [[ -z "$UFDS_URL" ]] && fatal "'UFDS_URL' is not set"
    [[ -z "$UFDS_ROOT_DN" ]] && fatal "'UFDS_ROOT_DN' is not set"
    [[ -z "$UFDS_PASSWORD" ]] && fatal "'UFDS_PASSWORD' is not set"
    local ldap_opts="-H $UFDS_URL -x -D $UFDS_ROOT_DN -w $UFDS_PASSWORD"
    LDAPTLS_REQCERT=allow /usr/openldap/bin/ldapdelete $ldap_opts "$@"
}

function ufdssearch() {
    [[ -z "$UFDS_URL" ]] && fatal "'UFDS_URL' is not set"
    [[ -z "$UFDS_ROOT_DN" ]] && fatal "'UFDS_ROOT_DN' is not set"
    [[ -z "$UFDS_PASSWORD" ]] && fatal "'UFDS_PASSWORD' is not set"
    local ldap_opts="-H $UFDS_URL -x -D $UFDS_ROOT_DN -w $UFDS_PASSWORD"
    LDAPTLS_REQCERT=allow /usr/openldap/bin/ldapsearch $ldap_opts -LLL -b o=smartdc "$@"
}


function clearUser() {
    local login=$1
    local uuid=$(ufdssearch login=$login uuid | grep '^uuid:' | cut -d' ' -f2)
    echo "# Clear user $login (uuid='$uuid')."
    if [[ -z "$uuid" ]]; then
        echo "# No such user '$login'."
        return
    fi

    #XXX filter by owner_uuid is not implemented. The foloowing returns *all* images right now
    #local images=$(imgapi /images?owner_uuid=$uuid | json -Ha uuid | xargs)
    #for image in $images; do
    #    echo "# DELETE /images/$image"
    #    imgapi /images/$image -X DELETE -f
    #done

    if [[ ! -n "$opt_quick_clean" ]]; then
        local person="uuid=$uuid, ou=users, o=smartdc"

        # Blow away all children of the user to avoid "ldap_delete: Operation
        # not allowed on non-leaf (66)".
        local children=$(ufdssearch -b "$person" dn \
            | (grep dn || true) \
            | grep -v "dn: $person" \
            | sed 's/^dn: //' \
            | sed 's/, /,/g' | xargs)
        for child in $children; do
            echo "# Delete '$child'"
            ufdsdelete "$child"
            # Lame attempt to avoid "ldap_delete: Operation not allowed on
            # non-leaf (66)" delete error race on deleting the sdc-person.
            sleep 1
        done

        echo "# Delete sdcperson '$person'."
        ufdsdelete "$person"
    fi
}




#---- mainline

# Options.
opt_quick_clean=
while getopts "q" opt
do
    case "$opt" in
        q)
            opt_quick_clean=yes
            ;;
        *)
            exit 1
            ;;
    esac
done

clearUser 'imgapitestuserulrich'
