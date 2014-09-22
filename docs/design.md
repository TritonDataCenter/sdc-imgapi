---
title: Image API Design Discussions
markdown2extras: tables, cuddled-lists
apisections:
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# Image API Design Discussions

Here-in some design discussions for Image API, collected here because they
might be helpful to understand why the Image API is the way it is. Each section
is dated to give context if reading this in the future when IMGAPI design might
have moved on. *Add new sections to the top.*


# CreateImage, ImportImage, etc. (2-Oct-2012)

from 19-Sep-2012 discussion:

    2:55:02 PM mark.cavage@eng.joyent.com: no i meant "create image looks like 'post to some url all the metadata' , imgapi validates then says 'ok, here's a place you can go write the bytes to'"
    2:55:27 PM trent: I understood that. I was questioning the need for two steps there.
    2:55:56 PM mark.cavage@eng.joyent.com: ok. well, up to you i suppose.
    2:57:10 PM trent: no, seriously, did you have a reason? :)
    2:57:34 PM mark.cavage@eng.joyent.com: i just don't understand how easy it is to combine the manifest and the byte stream in one call.
    2:57:39 PM mark.cavage@eng.joyent.com: they feel hard to "merge"
    2:57:44 PM trent: curl https://datasets.joyent.com/datasets/cc707720-359e-4d84-89a7-e50959ecba43 \
        -X PUT \
        -u joe:password \
        -F manifest=@nodejs-1.0.0.dsmanifest \
        -F nodejs-1.0.0.zfs.bz2=@nodejs-1.0.0.zfs.bz2
    2:58:07 PM trent: only reason I could think to separate is that you want validation done early
    2:58:16 PM mark.cavage@eng.joyent.com: yeah, if the image is big that's painful.
    2:58:19 PM mark.cavage@eng.joyent.com: is all i meant.
    2:58:20 PM trent: i.e. don't want to pay for the huge upload and ultimately fail because of a missing comma
    2:58:22 PM mark.cavage@eng.joyent.com: but, meh. ok.

So something like

    POST /images -u AUTH \
        -d name=foo
        -d description=...
        -d type=...
        -d os=...
        -d requirements=...
        -d tag=bar
        -d tag=baz
    --
    201 Created
    Location: http://n.n.n.n/images/$uuid
    ...

    {
        "name": "foo",
        ...
        "active": false,
        "state": "unactivated"   // or whatever
    }

Warning (TODO): watch out when proxying this 'Location' header via cloudapi.
Make it relative? No, still should be absolute.

Then add the file:

    PUT /images/$uuid/file -u AUTH -T foo.zfs.bz2    // curl's `-T FILE` option
    --
    200 OK
    ...

    {... the updated image serialization, state is 'unactivated' ...}

Not active yet, need to end file input -- this allows for future addition
of support for multiple files.

    POST /images/$uuid/activate
    --
    200 OK

    {... active image serialization ...}

Then can later stream the file out via:

    GET /images/$uuid/file

Note that here we are implicitly using "file" as an alias for "file0". The
latter will only be exposed if/when we support multi-file images.


## manta storage

IMGAPI is running with a configured Manta. The PUT stores the file in
"/imgapi/stor/images/$uuid/file0", where "imgapi" is actually the imgapi
UFDS user's UUID.

Note that possibly (need to understand the authn story) the GetImageFile
could just redirect to the Manta download URL.


## local storage

The image file to be stored is requested to be stored in local storage:

    POST /images/$uuid/file?storage=local

Authz: only allow for operators and a configured whitelist of user UUIDs
(config var `authzLocalStorateUuids`).

Note: the HA limitation here: this IMGAPI can only be on the headnode.

Physically the local storage is in "/usbkey/imgapi/images/$uuid/file0".
"/usbkey/imgapi" is mounted into the (headnode) imgapi zone.


## dcls storage

TODO: determine how this works and revisit. However, likely this will
be similar to 'local' storage:

    POST /images/$uuid/file?storage=dcls

Also, the HA limitation should *not* apply here.


## bootstrapping an image from /usbkey/datasets

    # ImportImage
    POST /images/$uuid -H content-type:application/json \
        --data-binary @/usbkey/datasets/smartos-1.6.3.dsmanifest
    POST /images/$uuid/file -T /usbkey/datasets/smartos-1.6.3.zfs.bz2

Authz: only allow for operators.

See the "CopyImageFromDC" below:

    POST /images?dc=us-west-1&uuid=:uuid

Perhaps those should both be the same:

    # ImportImage (only for operators)
    POST /images/$uuid -H content-type:application/json \
        --data-binary @/usbkey/datasets/smartos-1.6.3.dsmanifest

    # ImportImage (limited to moving one's *own* images from another DC to
    # this one).
    POST /images/$uuid?dc=us-west-1


## aside on multiple files

The 'PUT /images/$uuid/file' works well as long as only one file is ever
allowed. If we allow more, do we want to future proof with, say:

    POST /images/$uuid/file0 -u AUTH -T foo1.zfs.bz2
    POST /images/$uuid/file1 -u AUTH -T foo2.zfs.bz2
    ...
    POST /images/$uuid/end

`curl -T` isn't as convenient here because it defaults to "PUT". Not sure
if `-X POST` can just make that easy.

Could then stream the files via:

    GET /images/$uuid/file0
    GET /images/$uuid/file1
    ...

Anyway, we'll cross the "multiple files" bridge if/when we come to it.





# General IMGAPI plan (Sep-2012)

- https://datasets.joyent.com will live until all SDC 6.x are done.
  This needs to move to JPC2 soonish. Remains to be seen if this will be
  handled by imgapi code in a compat mode. Probably not.

- https://images.joyent.com is the replacement for SDC 7+. It is the central
  repository of base images for SmartOS usage. All images here are published
  and vetted by Joyent. (Images from software vendors may exist here, but
  are still vetted by Joyent.) All images here are public -- no read auth,
  no private images.

  `imgadm` in smartos is set to use this image repo by default, hence this is
  the main repository to which base smartos users are exposed. This is also
  the default repository from which an SDC operator can import new
  datasets (via adminui).

  The trust question: How can a user trust that a particular image is from
  Joyent and hence safe? Any images on images.joyent.com are vetted by
  Joyent, so SDC customers can trust those UUIDs. No guarantees on any other
  images.

  How does images.joyent.com differ from IMGAPI in a DC?

    - (maybe) images.joyent.com can host its docs
    - (maybe) perhaps an HTML webview of all the datasets?
    - it only allows addition of images from Joyent. It isn't tied to a
      UFDS perhaps? IOW, special cased auth.

- There is an IMGAPI in each DC: the imgapi zone(s). This is the authority
  for which images are available for provisioning in that DC.
  The provisioning process will lazily 'zfs receive' images on CNs as
  necessary -- streaming from the IMGAPI (imgadm on that machine handles
  that).

- IMGAPI image manifest data are stored in UFDS and replicated across all
  DCs, along with fields saying what DCs

- DC 'name' immutable in UFDS? Not currently. Could we enforce that? Else
  we can't use the "datacenter" name field in DBs. Could use a datacenter
  uuid as a reference.

  If neither, then need image-presence-in-a-dc to be a separate UFDS node
  under the datacenter DN.

  TODO: get a plan here

- IMGAPI endpoints:

        GET /images (ListImages)
        POST /images (CreateImage)
        GET /images/:uuid (GetImage)
        DELETE /images/:uuid (DeleteImage)
        PUT /images/:uuid (PutImage) - allows update of *some* fields, not of file
        GET /images/:uuid/:path (GetImageFile)
        GET /assets/:path         # REMOVED
        PUT /images/:uuid         # REMOVED (the old meaning for adding a dataset)

        POST /images/:uuid?from=https://api.us-west-1.joyent.com/my/images/:uuid (CopyImageFromDC)

  Misc:

        GET / (GetApi) - json view of the API, or redir to the /docs. Meh. Punt for now.
        GET /ping (Ping) - used for testing, health checking

  Also want ability to copy one of "my" images from one DC to another within
  the same cloud with the same UUID.

        POST /images?dc=us-west-1&uuid=:uuid

  Look-up us-west-1 in UFDS set of DCs, get an endpoint from which
  to stream internally.

  Duplicate this image to my own account

        POST /images?duplicate=$uuid (DuplicateImage)

  This is to optionally copy a public image to one's own account. It *does*
  mean paying for the storage and a new UUID, but guarantees it won't get
  deleted away from you.

- Requirement (from laurel): support being able to update some metadata
  fields (e.g. description) without requiring a change to its UUID.

  Updates to metadata fields that don't matter, like "description" will be
  supported. There will be an explicit list of fields that will be allowed
  to change in the UpdateImage (PUT /images/:uuid) endpoint. (TODO: come
  up with this list.) Manifest data is in UFDS and replicated, so shouldn't
  have a worry about replication. The "CopyImageFromDC" endpoint
  (which copies an image file to a new DC) persists the UUID will need to
  make sure to update the list of DCs in which an image is provisionable
  (or "present" or whatever the verb is).

  Plan: feel this out after have minimal manifest items in place. Walk through
  scenario.

    - scenario: User adds img in us-east-1. Moves it to us-west-1. Changes
      the "alias" (or whatever name field) in us-east-1. Now what? UFDS WAN
      replication should say this is fine.
    - design constraint: there is no built-in mechanism for moving an img
      to another SDC cloud (e.g. GCN case). It has a separate UUID in the
      other cloud. This would mean that UUID implies the same set of
      metadata.

        -> what about "core" images from images.joyent.com? Can we make that
           metadata immutable? Or just allow it... but you are on your
           own. Gentleman's agreement. These are owned by operators only,
           after all.

- TODO: URN eol of life plan.
  Notes:
    - drop URNs?  Yes. GCN WTFs with two bobs... tho the cloud_name *does* help
      still not worth it
        - drop version -> confusion, it can be duplicated (and is), so already
          lost the battle for URN as unique identifier
        - **** UUID is generated on the server side
        - cloudapi GetMachine/CreateMachine uses dataset URN. Fuck.
          Josh suggestion: need to support the old URNs (snapshot of that
          URN -> UUID mapping at the time of upgrade).
          use X-Api-Version header to distinguish

- Q: how are the storage mechanisms handled? Does it all stream through the
  API -- even if in Manta? How does this work in AWS?

    storage: manta, dcls, local

  TODO: plan out how these are handled.

- Q: do we need to support an SDC 6.5 headnode adminui speaking to
  images.joyent.com? Not sure. I hope not.

  What other tools speak to datasets.joyent.com?

  - imgadm/dsadm. Do we need to support existing imgadm's being converted to
    talk to images.joyent.com without getting the latest imgadm code?
  - The internal docs for pushing new datasets. No problem to update those.
  - ... others?

- Fine-grained access: discuss with Manta folks to have consistency.
  IOW, defer.
  The request for IMGAPI here is: groups or restricted_to_uuid *array*.
  I.e. being able to expose a private img to a number of people.




# Image manifest fields (12-Sep-2012)

Additional or clarified manifest fields from multiple discussions here
and there. Note: This list is being culled as fields are implemented or
dropped.

- josh: console_type.
  This was whether the image is setup for console to be on serial or vga.
  Josh: "I think we'll want it eventually, but it's probably something that
  can wait some more." -- Jan 2013


# Multi-DC images and the Portal (18-Jun-2012)

Discussion with Trent, Drew and Josh:

- the 6.5 portal page for provisioning requires getting the datasets for
  the current user availalbe in *each* data center. That is dog slow. Would
  be good if 7 didn't have this prob.
- reason for IMGAPI design of having the images be specific to a datacenter
  is that currently most customer don't provision to multiple datacenters
  so automatically copying to all DCs is a huge waste. Also there is a cost
  (time, space, is there a real space cost with Manta as well?) for getting
  the image data in every DC. That might be billable, so can't automatically
  push every where.
- a thought is to have the provisioning process lazily fetch the image from
  the source datacenter as required. Note that this should be reflected up
  in the portal UI for users, to explain possible cost and slower first
  provision, etc.

A design help here would then be to have IMGAPI store sufficient data on
images and which DCs the images are in **in the replicated part of UFDS**.


# Zoneinit and 6.5 <-> 7.x compat (13-Jun-2012)

Discussion with Trent and JoshW.

- Q: What would there be about a "datasets we built for SDC7-only"? Is this
  just about a more up-to-date platform? "netN" network name changes?
  Other things? Zoneinit reboot (need to understand that again)?
  TODO: ask josh
- Q: is there a backward compat issue here: do we have to worry about a given
  dataset *only* being provisioned on an SDC 6.5 CN and *not* on a SDC 7 CN?
  IOW, this would require a *maximum* version on the image manifest.


Requirements from the full discussion below:

- Image metadata to express a minimum (platform? sdc?) version needed on the
  CN to deploy to it.
  Q: How is this value used?
- If deemed necessary, we could guard against SDC 6.5 installations getting
  "only works on SDC 7+" images with a change in SDC 6.5.next MAPI to
  "refuse to import any dataset that has a minimum_sdc_version at all".
  Not sure if this is necessary, tho. An SDC 6.5 data center nominally only
  gets new datasets via (a) operator action and (b) typically from
  datasets.joyent.com. So if we just never add SDC7 datasets to
  datasets.joyent.com, then we should be good.


Full discussion:

    joshw: yeah.  The other thing we should consider is a flag on datasets "only works with versions newer than X"
    trent: versions of what? Of the CNAPI ? or of the platform (i.e. the compute node version)
    joshw: Yeah, I don't know that either (which version should win).  But I don't want people trying to install datasets we built for SDC7-only on SDC6.5
    trent: do we try to get in a change to 6.5.5 that will recognize this flag on datasets and give a nice error message?
    joshw: If we have to always make all our new datasets work on 6.5 we're digging ourselves an even bigger hole.
    joshw: I think we should.
    joshw: This also might help us encourage people to upgrade to SDC7. :)
    trent: k, so we need to spec that... and get it into (at least) provisioner-v2 (?) and cloudapi maybe
    joshw: Might need to involve MAPI. :(
    joshw: Actually that's one way.
    trent: also... the cloudapi endpoint to list available datasets should then exclude those datasets?
    trent: that'll be gross.
    joshw: We could just have MAPI refuse to import any dataset that has a minimum_sdc_version at all. :)
    joshw: Since MAPI only exists in 6.5
    trent: Hrm. My point is that the "encouragement" is at the wrong level: the customer is out of luck, but it is the operator that needs to upgrade.
    trent: ah, yah. dataset can't import. That's better.
    joshw: yeah, that puts the pain on the operator.
    joshw: I can't offer this dataset to my customers until I upgrade.
    trent: *but* this only works for MAPIs running sdc 6.5.5
    trent: so perhaps we update adminui's calling to datasets.joyent.com to pass in its version (the X-Api-Version header)
    trent: and the DSAPI doesn't show those datasets unless X-Api-Version >= 6.5.5
    trent: (actually would be a different header)
    joshw: I thought we actually added something for this already now that we're discussing it.
    joshw: Perhaps an even easier option!
    joshw: I just thought of. :)
    trent: no :(    We discussed it, but didn't happen.
    joshw: how about we only show SDC7 dataset if you *DO* pass the X-API-Version header. :D
    trent: yah... that was what we'd originally discussed
    joshw: That way we don't need to modify sdc 6.5 at all.
    joshw: It'll just not see the new datasets.
    trent: oh, you mean we keep running the same server for datasets.joyent.com and whatever SDC7's adminui looks at?
    joshw: Well, that's true too. If we have the new imgapi it won't even matter I suppose.
    joshw: Since you'll not get those datasets in your list.
    joshw: (ones that are only in our imgapi)
    trent: I'm flailing a little bit here. I need to think about it.
    trent: Will sdc7's vmadm always support running the older datasets (from sdc6 era)?
    trent: i.e. it'll look at this manifest attribute and presume the zoneinit-reboot-shit if it doesn't say "this is an sdc7 zoneinit-free dataset".
    joshw: That's another open question.
    joshw: And one of the reasons I don't like that all this logic is in the dataset. :(
    joshw: I guess that's something I need to ask bryan.
    trent: i think that's going to be a requirement
    joshw: Probably.
    joshw: But for how long?
    trent: I meant, zoneinit is going to live on.
    joshw: Oh, yeah.
    trent: s/meant/mean/
    joshw: We rev all our datasets every once in a while and I don't think old versions stay available now either though.
    joshw: Right?
    joshw: if I go to https://datasets.joyent.com/datasets/ I only get the latest.
    trent: (so, I'm guessing the requirement will be: and SDC7 compute node must support SDC6-era datasets. The only exception woudl be *platform* incompat. Zoneinit incompat wouldn't be acceptable.)
    trent: dataset revs: two things at play here
    joshw: or maybe not.  I see some older ones there too.
    trent: datasets.joyent.com *does* delete obsolete dataset every so often yes.
    trent: that's for ops tho
    joshw: ok.
    trent: the question is what ops are doing in the MAPI list of datasets
    trent: in *JPC* I believe they are "hiding" older datasets, yes.
    trent: where "hiding" is a disable attribute on the MAPI Dataset model (or something)
    trent: so, currently I *think* we could get away with rev'ing everything. But you'd still have to have datasets that can provision fine to either CN-1 (which is running sdc 6.5 platform) or CN-2 (which is running sdc 7 platform).
    trent: or is that wrong? To migrate to having images that provision with*out* the zoneinit reboot, you have to disallow provisioning those on a CN running sdc 6.5 platform.
    trent: gah. we should talk face to face tomorrow. Yah?
    joshw: Yeah. Maybe what I have to do is have vmadm grep zoneinit and see if it's going to try a reboot. :)
    trent: lol
    joshw: I'm only half kidding.


# Manta or not to manta (01-Jun-2012)

Manta is optional. So IMGAPI needs to support DCL as a backup or alternative
or both. DCL === Bill's datacenter local storage.

MarkC: "besides, manta is deployed via images, so it sort of needs imgapi in
the first place to get going :\ this is complicated, i fear."

Bryan req: allow non-op images to be on local storage (i.e. non-manta) Have a
whitelist of UUIDs.



# Design, Requirements, etc from Trevor (09-Mar-2012)

Design & Requirements:

* DSAPI is "per datacenter" which means no automatic updates between
  datacenters. One potential caveat with that is having different names
  or UUIDs for the same dataset if they are pushed to different locations.
  Amazon currently does this, but I think we can do better.
* We should never prevent someone from deleting an image
* To maintain a "guarantee" that an image is always available, a user has
  to create their own from an existing image using the "Creating & Publishing
  Datasets" instructions / flow
* Customers should be billed for how much storage space they are using
  (not intended to be your problem at all!)
* No charge for creating an image, but a cost associated with keeping that
  image in some storage location
* If someone wants to deploy an image to a second datacenter, then they have to
  manually issue a "deploy to DC" / "copy to DC" request which will copy the image
  over the WAN
  [See "CopyImageFromDC" endpoint above.]



Creating and Publishing Datasets. The workflow is written from an end-users
perspective:

* The user provisions a machine using cloudAPI
* They log into the machine and customize the machine to their
  liking. There is no telling what someone will do, but they will have
  access to all of the services / apis that a machine normally would,
  and will have to take that into account when "prepping" their machine.
* After customizing their machine, they can run the "prepare-image"
  tool which will reset and remove things like
    - ssh keys
    - ssh host keys
    - ipaddress/hostname values
    - dhcp leases / etc
    - other config settings we know need to change if we're to deploy
      numerous times
* They can then shutdown the machine elegantly
* After the machine is shutdown, they can take a snapshot
* After the snapshot is complete, they can turn the snapshot into an
  image. Whatever tools they use for this will ask them for manifest
  information that is not automatically populated by the server.
* When a snapshot is turned into an image, it is sent off of the CN
  using zfs send | compression | transport mechanism > destination,
  where destination is some storage location / LOCAL DSAPI endpoint.
* The Local DSAPI is the only system to receive the Dataset. Datasets
  are not to be automatically replicated to different datacenters.
* After the manifest is uploaded, then it is immediately available to the
  OWNER. The OWNER is initially defined as the user that uploaded the
  dataset.
* At any time, the OWNER can change the SCOPE of of the dataset to
  "public" so that anyone can provision the dataset.
* If a dataset is "public" then anyone with access to the DSAPI can
  view and launch instances using that dataset.

Role Based Access Control - RBAC:

* The owner of a manifest is the only one who can delete or modify the manifest
  or image

Manifests:

* Manifests should include an optional "icon" key which has a URL of an icon as
  its value. The size of an icon is one of 512x512, 256x256, or 128x126. This
  suggests DSAPI needs to actually store these icons, so that they can be
  validated for size. It should be possible for a user to change this icon
  after the manifest has been created.
