<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

This is a first stab at UFDS sdcimage migrations for image validation changes. 

The correct next steps would be:

- Add an internal 'v' field on sdcimage objects that is a single
  integer giving the db record version. Key off that for migrations.
- Migrations must be idempotent.
- Have some easy entry point to trigger migrations.

Cross that road, when ...
