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

$SSH -A -T $DATASETS_LOGIN <<SCRIPT

if [ "$TRACE" != "" ]; then
    #export PS4='[\D{%FT%TZ}] \${BASH_SOURCE}:\${LINENO}: \${FUNCNAME[0]:+\${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail

export JOYENT_IMGADM_IDENTITY=b3:f0:a1:6c:18:3b:47:63:ae:6e:57:22:74:71:d4:bc
export JOYENT_IMGADM_USER=trentm
JOYENT_IMGADM=\$HOME/bin/joyent-imgadm
JSON=\$HOME/bin/json


function push2images {
    local have_uuids=\$(\$JOYENT_IMGADM list -a -j | \$JSON -a uuid)
    local manifests=\$(ls -1 /shared/dsapi/manifests/*.dsmanifest)
    for manifest in \$manifests; do
        local uuid=\$(\$JSON uuid < \$manifest)
        local name=\$(\$JSON name < \$manifest)
        local version=\$(\$JSON version < \$manifest)
        local restricted_to_uuid=\$(\$JSON restricted_to_uuid < \$manifest)
        local type_=\$(\$JSON type < \$manifest)
        if [[ "\$type_" == "vmimage" ]]; then
            echo "Skipping import of image \$uuid: vmimage type is invalid."
            continue
        elif [[ -n "\$restricted_to_uuid" ]]; then
            echo "Skipping import of image \$uuid: private."
            continue
        fi
        if [[ -z "\$(echo "\$have_uuids" | grep \$uuid)" ]]; then
            local file=\$(ls /shared/dsapi/assets/\$uuid/*)
            echo "Importing image \$uuid \$name-\$version into IMGAPI."
            echo "  manifest: \$manifest"
            echo "  file:     \$file"
            [[ -f "\$file" ]] || fatal "Image \$uuid file '\$file' not found."
            \$JOYENT_IMGADM import -P -m "\$manifest" -f "\$file"
        else
            echo "Skipping import of image \$uuid: already in IMGAPI."
        fi
    done
}

push2images

SCRIPT
