#!/bin/bash
#
# SSH to datasets.joyent.com and push all datasets to images.joyent.com.
#
# WARNING: Right now, at least, this should only be used for dev.
# It might eventually be useful for keeping datasets.jo and images.jo in sync.
#

if [ "$TRACE" != "" ]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


TOP=$(unset CDPATH; cd $(dirname $0)/; pwd)
SSH_OPTIONS="-q -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
SSH="ssh $SSH_OPTIONS"
DATASETS_LOGIN=root@datasets



#---- mainline

echo '# Push datasets.joyent.com datasets to images.joyent.com.'
echo '# WARNING: images.joyent.com is a *production* server.'
echo '# Press <Enter> to continue, <Ctrl+C> to cancel.'
read

$SSH -T $DATASETS_LOGIN <<SCRIPT

# TODO: should be images.joyent.com when that is DNS'd.
IMGAPI_URL=https://64.30.133.39

function imgapi {
    local path=\$1
    shift
    curl -k --connect-timeout 10 -sS -i -H accept:application/json \
        --url \$IMGAPI_URL\$path "\$@" | json -q
}

function push2images {
    local manifests=\$(ls -1 /shared/dsapi/manifests/*.dsmanifest)
    for manifest in \$manifests; do
        local uuid=\$(json uuid < \$manifest)
        local name=\$(json name < \$manifest)
        local version=\$(json version < \$manifest)
        local restricted_to_uuid=\$(json restricted_to_uuid < \$manifest)
        local type_=\$(json type < \$manifest)
        if [[ "\$type_" == "vmimage" ]]; then
            echo "Skipping import of image \$uuid: vmimage type is invalid."
            continue
        elif [[ "\$type_" == "zvol" ]]; then
            echo "Skipping import of image \$uuid: zvol not quite supported yet."
            continue
        elif [[ -n "\$restricted_to_uuid" ]]; then
            echo "Skipping import of image \$uuid: private."
            continue
        fi
        local status=\$(imgapi /images/\$uuid | head -1 | awk '{print \$2}')
        if [[ "\$status" == "404" ]]; then
            local file=\$(ls /shared/dsapi/assets/\$uuid/*)
            echo "Importing image \$uuid \$name-\$version into IMGAPI."
            echo "  manifest: \$manifest"
            echo "  file:     \$file"
            [[ -f "\$file" ]] || fatal "Image \$uuid file '\$file' not found."
            imgapi /images/\$uuid?action=import -d @\$manifest -f
            imgapi /images/\$uuid/file -T \$file -f
            imgapi /images/\$uuid?action=activate -X POST -f
        elif [[ "\$status" == "200" ]]; then
            echo "Skipping import of image \$uuid: already in IMGAPI."
        else
            echo "Error checking if image \$uuid is in IMGAPI: HTTP \$status"
        fi
    done
}

push2images

SCRIPT
