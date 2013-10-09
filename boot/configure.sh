#!/usr/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# Copyright (c) 2013 Joyent Inc., All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace
set -o errexit
set -o pipefail

PATH=/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin


# Tune TCP so IMGAPI will work better with Manta
# '|| true' because this 'ipadm set-prop' is necessary on some platform versions
# and breaks on older ones.
ipadm set-prop -t -p max_buf=2097152 tcp || true
ndd -set /dev/tcp tcp_recv_hiwat 2097152
ndd -set /dev/tcp tcp_xmit_hiwat 2097152
ndd -set /dev/tcp tcp_conn_req_max_q 2048
ndd -set /dev/tcp tcp_conn_req_max_q0 8192

exit 0
