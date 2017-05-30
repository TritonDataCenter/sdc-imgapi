#!/usr/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2017 Joyent, Inc.
#

#
# Setup a new zone for a standalone IMGAPI.
#
# Typically this is run via the user-script for this instance (which should
# be the content of "./user-script") and logs are in "/var/log/setup.log".
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

# Mount our delegated dataset at /data if we have one.
dataset=zones/$(zonename)/data
if zfs list | grep $dataset; then
    mountpoint=$(zfs get -Hp mountpoint $dataset | awk '{print $3}')
    if [[ $mountpoint != "/data" ]]; then
        zfs set mountpoint=/data $dataset
    fi
else
    mkdir /data
fi

# Set nodename/hostname to something that is nice to see in PS1.
NODENAME=imgapi-$(mdata-get sdc:alias)-$(zonename | cut -d- -f1)
/opt/local/bin/sm-set-hostname $NODENAME

# Bash profile:
# - set PATH, even for non-login sessions
# - set MANTA_ envvars, but only for login sessions
IMGAPI_PREFIX=/opt/smartdc/imgapi
echo "" >>/root/.profile
echo "export PATH=$IMGAPI_PREFIX/bin:$IMGAPI_PREFIX/build/node/bin:$IMGAPI_PREFIX/node_modules/.bin:\$PATH" >>/root/.profile
echo 'if [ "$PS1" ]; then eval $(/opt/smartdc/imgapi/bin/manta-env 2>/dev/null || true); fi' >>/root/.profile

# Data dir setup. For reprovisions on delegate datasets, this should already
# be done.
if [[ ! -d /data/imgapi ]]; then
    # etc/ and instance ssh key
    mkdir -p /data/imgapi/etc
    [[ ! -f /data/imgapi/etc/imgapi-*.id_ecdsa ]] \
        || fatal "unexpected existing IMGAPI instance key files: /data/imgapi/etc/imgapi-*.id_ecdsa"
    keyName=$NODENAME-$(date -u '+%Y%m%d')
    ssh-keygen -t ecdsa -b 256 -N "" \
        -C "$keyName" -f /data/imgapi/etc/$keyName.id_ecdsa
    # Write pubkey to mdata so outside tooling can use it for setup.
    mdata-put instPubKey < /data/imgapi/etc/$keyName.id_ecdsa.pub

    # Self-signed cert
    /opt/local/bin/openssl req -x509 -nodes -subj '/CN=*' -newkey rsa:2048 \
        -keyout /data/imgapi/etc/key.pem \
        -out /data/imgapi/etc/cert.pem -days 365
    cat /data/imgapi/etc/key.pem >> /data/imgapi/etc/cert.pem
    rm /data/imgapi/etc/key.pem

    # Generate config file.
    /opt/smartdc/imgapi/bin/imgapi-standalone-gen-setup-config \
        >/data/imgapi/etc/imgapi.config.json

    # Dir for local auth keys (really only needed for authType=signature).
    mkdir -p /data/imgapi/etc/authkeys/local

    # imgapi SMF service runs as 'nobody'
    chown nobody:nobody /data/imgapi
    chown nobody:nobody /data/imgapi/etc
    chown nobody:nobody /data/imgapi/etc/$keyName.id_ecdsa{,.pub}
    chown nobody:nobody /data/imgapi/etc/cert.pem
    chown nobody:nobody /data/imgapi/etc/imgapi.config.json
    chown nobody:nobody /data/imgapi/etc/authkeys
    chown nobody:nobody /data/imgapi/etc/authkeys/local
fi

# Manta CLI tools require that key be in ~/.ssh
privKeyPath=$(/opt/smartdc/imgapi/build/node/bin/node /opt/smartdc/imgapi/lib/config.js | json manta.key)
ln -s $privKeyPath ~/.ssh/
ln -s $privKeyPath.pub ~/.ssh/

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
echo '17 * * * * /opt/smartdc/imgapi/bin/imgapi-standalone-backup -y >>/var/log/triton/imgapi-backup.log 2>&1' >>$crontab
crontab $crontab
[[ $? -eq 0 ]] || fatal "Unable import crontab"
rm -f $crontab

# MOTD
# TODO: 'manta rootDir' will be out of date if Manta details are configured
# after initial setup.
cat <<EMOTD >/etc/motd
** This is a standalone IMGAPI instance.
**            uuid: $(zonename) ($(mdata-get sdc:alias))
**              dc: $(mdata-get sdc:datacenter_name)
**           owner: $(mdata-get sdc:owner_uuid)
**           image: $(mdata-get sdc:image_uuid)
**   manta rootDir: $(/opt/smartdc/imgapi/build/node/bin/node /opt/smartdc/imgapi/lib/config.js | json manta.rootDir)
EMOTD

# SMF services
/usr/sbin/svccfg import /opt/smartdc/imgapi/smf/manifests/imgapi.xml
/usr/sbin/svccfg delete pkgsrc/haproxy  # avoid 'haproxy' FMRI collison
/usr/sbin/svccfg import /opt/smartdc/imgapi/smf/manifests/haproxy-standalone.xml
/usr/sbin/svccfg delete pkgsrc/stud  # avoid 'stud' FMRI collison
/usr/sbin/svccfg import /opt/smartdc/imgapi/smf/manifests/stud-standalone.xml

# Note completion
touch $SETUP_COMPLETE_FILE
echo "Setup completed successfully"

exit 0
