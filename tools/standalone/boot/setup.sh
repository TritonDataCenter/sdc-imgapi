#!/usr/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2016 Joyent, Inc.
#

#
# Setup a new zone for a standalone IMGAPI.
#
# Typically this is run via the user-script for this instance (which should
# be the content of "../user-script") and logs are in
# "/var/log/imgapi-standalone-setup.log".
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


# The same path as used by core IMGAPI (from sdc-scripts.git).
SETUP_COMPLETE_FILE=/var/svc/setup_complete


if [[ -f $SETUP_COMPLETE_FILE ]]; then
    # Already setup.
    exit 0
fi

# Mount our delegate dataset at /data if we have one.
dataset=zones/$(zonename)/data
if zfs list | grep $dataset; then
    mountpoint=$(zfs get -Hp mountpoint $dataset | awk '{print $3}')
    if [[ $mountpoint != "/data" ]]; then
        zfs set mountpoint=/data $dataset
    fi
else
    mkdir -p /data/imgapi
fi

# Set nodename/hostname to something that is nice to see in PS1.
NODENAME=imgapi-$(mdata-get sdc:alias)-$(zonename | cut -d- -f1)
sm-set-hostname $NODENAME

# Bash profile
IMGAPI_PREFIX=/opt/smartdc/imgapi
echo "" >>/root/.profile
echo "export PATH=$IMGAPI_PREFIX/bin:$IMGAPI_PREFIX/build/node/bin:$IMGAPI_PREFIX/node_modules/.bin:\$PATH" >>/root/.profile
# TODO: add Manta vars, see .mantaprofile stuff, use manta-config or similar?

# etc/ and instance ssh key
mkdir -p /data/imgapi/etc
keyname=$NODENAME-$(date -u '+%Y%m%d')
ssh-keygen -t rsa -b 4096 -N "" \
    -C "$keyname" -f /data/imgapi/etc/$keyname.id_rsa
# Manta CLI tools require that key be in ~/.ssh
ln -s /data/imgapi/etc/$keyname.id_rsa ~/.ssh/
ln -s /data/imgapi/etc/$keyname.id_rsa.pub ~/.ssh/
# Write pubkey to mdata so outside tooling can use it for setup.
mdata-put instPubKey < /data/imgapi/etc/$keyname.id_rsa.pub

# Self-signed cert
/opt/local/bin/openssl req -x509 -nodes -subj '/CN=*' -newkey rsa:2048 \
    -keyout /data/imgapi/etc/key.pem \
    -out /data/imgapi/etc/cert.pem -days 365
cat /data/imgapi/etc/key.pem >> /data/imgapi/etc/cert.pem
rm /data/imgapi/etc/key.pem

# Config file.
# TODO: get this smaller
cat <<EOM >/data/imgapi/etc/imgapi.config.json
{
    "port": 8080,
    "logLevel": "debug",
    "mode": "public",
    "serverName": "Joyent Public Images Repo",
    "auth": {
        "type": "signature",
        "keysDir": "/data/imgapi/etc/keys"
    },
    "database": {
        "type": "local",
        "dir": "/data/imgapi/manifests"
    },
    "storage": {
        "manta": {
            "url": "https://us-east.manta.joyent.com",
            "user": "trent.mick",
            "key": "/data/imgapi/etc/imgapi-$keyname.id_rsa",
            "keyId": "$(ssh-keygen -E sha256 -lf /data/imgapi/etc/imgapi-$keyname.pub | awk '{print $2}')",
            "baseDir": "tmp/images.joyent.com"
        },
        "local": {
            "baseDir": "/data/imgapi"
        }
    }
}
EOM

mkdir -p /data/imgapi/etc/keys/local  # Dir for local auth keys, if any.
# imgapi SMF services runs as 'nobody'
chown nobody:nobody /data/imgapi
chown nobody:nobody /data/imgapi/etc
chown nobody:nobody /data/imgapi/etc/imgapi-*.id_rsa*
chown nobody:nobody /data/imgapi/etc/cert.pem
chown nobody:nobody /data/imgapi/etc/imgapi.config.json
chown nobody:nobody /data/imgapi/etc/keys
chown nobody:nobody /data/imgapi/etc/keys/local

# Log rotation
mkdir -p /var/log/triton/upload
touch /var/log/triton/imgapi-backup.log  # avoid a warning in logadm.log
echo '
imgapi /var/svc/log/*imgapi*.log
imgapi-backup /var/log/triton/imgapi-backup.log
' | while read logname logpat size; do
    [[ -n "$logname" ]] || continue
    # 168 == 1 week of hours
    logadm -w $logname -C 168 -c -p 1h \
        -t "/var/log/triton/${logname}_\$nodename_%Y%m%dT%H%M%S.log" \
        -a "/opt/smartdc/imgapi/tools/standalone/tritonpostlogrotate.sh ${logname}" \
        "$logpat" || fatal "unable to create $logname logadm entry"
done
logadm -r smf_logs   # smf_logs competes with 'imgapi' SMF log, put it last
logadm -w smf_logs -C 3 -c -s 1m '/var/svc/log/*.log'

# crons: logadm, manta backup, manta log upload
crontab=/tmp/imgapi-$$.cron
rm -f $crontab
touch $crontab
echo '0 5 * * * /opt/local/sbin/pkg_admin fetch-pkg-vulnerabilities >/dev/null 2>&1' >>$crontab
echo '0 * * * * /usr/sbin/logadm -v >>/var/log/logadm.log 2>&1' >>$crontab
echo '1 * * * * /opt/smartdc/imgapi/tools/standalone/tritonlogupload.sh -a 5 >>/var/log/tritonlogupload.log 2>&1' >>$crontab
echo '17 * * * * /opt/smartdc/imgapi/tools/standalone/backup-to-manta.sh >>/var/log/triton/imgapi-backup.log 2>&1' >>$crontab
crontab $crontab
[[ $? -eq 0 ]] || fatal "Unable import crontab"
rm -f $crontab

# SMF services
/usr/sbin/svccfg import /opt/smartdc/imgapi/smf/manifests/imgapi-standalone.xml
/usr/sbin/svccfg delete pkgsrc/haproxy  # avoid 'haproxy' FMRI collison
/usr/sbin/svccfg import /opt/smartdc/imgapi/smf/manifests/haproxy-standalone.xml
/usr/sbin/svccfg delete pkgsrc/stud  # avoid 'stud' FMRI collison
/usr/sbin/svccfg import /opt/smartdc/imgapi/smf/manifests/stud-standalone.xml

# Note completion
touch $SETUP_COMPLETE_FILE
echo "Setup completed successfully"

exit 0
