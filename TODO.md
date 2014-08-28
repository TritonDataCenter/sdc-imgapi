<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# channels

Process: Add tests to channels.public-test.js. Test with 'runtests -lp'.

- check that image import from channel-IMGAPI (local test first) still works
  (i.e. extra 'channels' field doesn't break things): nope -> IMGAPI versioning
    - black book items
- hack migration to add 'dev' channel to current set of images on updates.jo
- update_channel in prompt-config.sh, SAPI 'sdc' app metadata,
  updates-imgadm.config.json manifest and updates-imgadm using that,
  sdcadm using that config var for channel. `sdcadm channel` command to list,
  show and set channel. Nightly switch to 'dev' channel.
- when up on updates.jo add channel=staging test to tests/adminimport.test.js
- imgadm support for sources with a channel: URL?channel=foo
- channel features like disallowing (name,version) repeats
