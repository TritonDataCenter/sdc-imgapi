- IMGAPI-???: get imgapi zone in headnode:
    - basic app structure
    - jenkins and builds up
    - test on kvm7
    - add to headnode
    - nodeunit tests basically working
    - deps: vasync instead of async?
    - shrinkwrap -> target to update shrinkwrap

- assist in the SDC 6.5 SOP for image creation as per
  Trevor's email: https://mail.google.com/mail/u/1/?ui=2&shva=1#inbox/1379fad460845d56

- integrate these notes from meeting with Trevor, Josh, Trent, Andres (early Jun 2012):
    - tangent on linode StackScripts for SDC... with gist integration, etc.
      cloudapi does the userscript aggregation. This is a good potential
      backstop for IMGAPI in SDC 6.
    - Q: EOL'ing large imported zfs datasets for space savings when no longer
      used?
    - cross-region copy: is this a manta push?
    - pre-SDC-7
    - need UFDS groups?
    - drop URNs?  Yes. One Cloud Alliance wtf's with two bobs... tho the cloud_name *does* help
      still not worth it
        - drop version -> confusion, it can be duplicated (and is), so already
          lost the battle for URN as unique identifier
        - **** UUID is generated on the server side
        - cloudapi GetMachine/CreateMachine uses dataset URN. Fuck.
          Josh suggestion: need to support the old URNs (snapshot of that
          URN -> UUID mapping at the time of upgrade).
          use X-Api-Version header to distinguish
    - images.joyent.com cut over: copy datasets from datasets.joyent.com and
      make the latter read-only or slowly end of life.
        - dsadm update to api changes: /datasets/:uuid -> /images/:uuid
        - dsadm -> imgadm?  (dsadm bash wrapper with warning on stderr for new name)
        - vmadm: dataset_uuid -> image_uuid
    - dsmanifest files: only allow one (because the tool chain on ever does) but doc that it is a list
      for future possible
    - action by dcapi to import an image: arg is a url to the manifest

- integrate these notes from dataset/image call with Bryan, Jonathan, Filip, Josh:
    - imgapi requirement/request from Bryan: allow non-op images to be on local
      storage (i.e. non-manta) Have a whitelist of UUIDs.
    - ... some talk of zoneinit. No resolution.
    - long chat with Josh afterwards about how to handle compat btwn 6.5 and 7
      for images with/without zoneinit and/or zoneinit reboot. No resolution
      yet. See adium chatlog with josh Jun 13th.

- 2012-Jun-18 discussion with Drew and Josh:
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

- old old notes:
    - Q: "images" and IAPI? Or still use dsapi internally?
      "I" probably good if API is to be exposed to users at all.
    - https://gist.github.com/eae17c1f396deec369fa and
      https://devhub.joyent.com/jira/browse/DATASET-323
    - ignorant Q: how do I create an image from an ISO. Say a slackware, debian
      or whatever ISO?
    - deliverable: step #6 of https://mail.google.com/mail/u/1/?ui=2&shva=1#inbox/13777a989f974731
      "6) User uses CloudAPI to create an image from a snapshot"
    - deliverables: Trevor's additions to dsapi.git/README.md
    - Q: regarding this:
            * We should never prevent someone from deleting an image
            * To maintain a "guarantee" that an image is always available, a user has
              to create their own from an existing image using the "Creating & Publishing
              Datasets" instructions / flow
      Do we perhaps want a "copy this image to my own"? Rather than obtuse
      process of going via a custom image creation.
    - additional fields: homepage, icon(s), deprecated/obsoleted, ...
    - Q: auto-updating of deprecated/obsoleted? I.e. how do we notify operators
      of deprecated version of an image?
    - Q: Still have a central "these are from joyent" images? E.g. how do we get
      a new smartos dataset from Joyent to SDC operators? Full auto-update
      system? (notifications, UI message centre in adminui, regular checks,
      etc.)
