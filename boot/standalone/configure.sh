#!/usr/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2016 Joyent, Inc.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace
set -o errexit
set -o pipefail

# Tune TCP so IMGAPI will work better with Manta
# '|| true' because this 'ipadm set-prop' is necessary on some platform versions
# and breaks on older ones.
ipadm set-prop -t -p max_buf=2097152 tcp || true
ndd -set /dev/tcp tcp_recv_hiwat 2097152
ndd -set /dev/tcp tcp_xmit_hiwat 2097152
ndd -set /dev/tcp tcp_conn_req_max_q 2048
ndd -set /dev/tcp tcp_conn_req_max_q0 8192

exit 0
