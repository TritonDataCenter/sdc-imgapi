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

