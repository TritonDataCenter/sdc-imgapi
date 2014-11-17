<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# Comparing images in Manatee backups

Warning: The scripts in here are not complete or fully supported. They
are relatively quick hacks to get some useful comparison output.


If your SDC is configured to be uploading data dumps to Manta then
you should have a tree of daily "manatee\_backups" something like this:


    /$MANTA_USER/stor/sdc/manatee_backups/$DC_NAME/$YEAR/$MONTH/$DAY/00/
        adminui-2014-11-17-00-00-13.gz
        buckets_config-2014-11-17-00-00-13.gz
        cnapi_servers-2014-11-17-00-00-13.gz
        cnapi_tasks-2014-11-17-00-00-14.gz
        cnapi_waitlist_queues-2014-11-17-00-01-55.gz
        cnapi_waitlist_tickets-2014-11-17-00-01-55.gz
        fwapi_updates-2014-11-17-00-01-57.gz
        imgapi_images-2014-11-17-00-01-57.gz
        ...

we can use that "imgapi\_images-\*.gz" dump from separate days
to compare the state of IMGAPI's database over time.  This directory
includes a few scripts to help with this.

## Prerequisites

You have the [node-manta](https://github.com/joyent/node-manta) CLI
tools (e.g. `mget`, `mls`) installed and setup with access to the
SDC data dump area in Manta.


## Compare the set of images between two days

    ./manatee-diff-images BASE_DIR DC_NAME START_DAY END_DAY

Example (using "BOB" as the Manta user under which our SDC data dumps are stored):

    $ ./manatee-diff-images /BOB/stor/sdc us-sw-1 2014/11/13 2014/11/17
