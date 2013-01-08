
# overview

- Fill out each of the use cases in index.restdown. Do those use cases cover
  all of UpdateImage, DisableImage, EnableImage, MigrateImage, AdminImportImage?
  Tickets for each.
- imgadm2
- get storage (local and manta) working:
    - local needs to have a formal separate delegated dataset ... which
      only works for HN. What's the HA plan? We doing DCLS or no?
- fill in all missing attributes for zvols and add those to images.joyent.com
- test cloudapi compat
- Compat with SDC6 cloudapi dataset endpoints.
- SDC 6.5 provisioner changes for SDC7 headnode: AGENT-534
- Review usage with customer image creation plan DATASET-323.
  Trent ref: https://mail.google.com/mail/u/1/?ui=2&shva=1#inbox/1379fad460845d56
- CRUD on image traits per <https://gist.github.com/1484f5712530f5075044#gistcomment-596222>
- usageapi/billing issues
- multi-dc and support for adminui and portal
- node-smartdc update: new "--image" options, deprecate "--dataset"
- what else?


# general todos

- manifest fields:
    TODO: the optional ones (any more left?)
    TODO: bwcompat ones and new ones from datasets.joyent.com/docs
    TODO: new ones from design.restdown section
    TODO: compare validtion with rules in mapi/models/dataset.rb
- images.joyent.com:
    - ask about the restricted_to_uuid single example (fca6434e-da62-11e1-8e93-af79adacd365)
    - redir / -> /images (perhaps later to keep it obscure)
- public docs for images.joyent.com: docs/public.restdown and a deploy
  task to put serve those (and *not* the other html files) on
  images.joyent.com
- add this use case: Don't break this usage:
    http://datasets.at/#/about
  IOW, imgadm2 should still use sources.list?! Update compat is more important
  than back-and-forth compat.
- smartos-live/issues for imgadm and dsadm
- error restdown table generation (TOOLS-204)
- error response audit log body fix (restify#225)
- npm shrinkwrap
- convert dsapi test suite to a "bwcompat" test suite for
- update imgadm man page
- manifest "files" field: only allow one (because the tool chain only ever
  does) but doc that it is a list for future possible
- DCLS handling once wdp has DCLS ready
- understand the zoneinit reboot compat (6.5 CN) issues (see design)

# testing

- test odd chars in 'name' and 'version': unicode, '\0', quoting chars, etc.


# someday/maybe

- partial/resumable file upload (large images), e.g. see
  "Uploading" section in http://docs.amazonwebservices.com/AmazonEC2/gsg/2006-06-26/creating-an-image.html
- Q: EOL'ing large imported zfs datasets for space savings when no longer
  used?
- verror
- vasync?
- tangent on linode StackScripts for SDC... with gist integration, etc.
  cloudapi does the userscript aggregation. This is a good potential
  backstop for IMGAPI in SDC 6.




# notes (CreateImage)

`POST /images (CreateImage)`


AWS:
- http://docs.amazonwebservices.com/AWSEC2/latest/CommandLineReference/ApiReference-cmd-DescribeImages.html
- http://docs.amazonwebservices.com/AWSEC2/latest/CommandLineReference/ApiReference-cmd-RegisterImage.html


Currently <https://datasets.joyent.com/docs#PUT-/datasets/:uuid>

    $ curl https://datasets.joyent.com/datasets/cc707720-359e-4d84-89a7-e50959ecba43 \
        -X PUT \
        -u joe:password \
        -F manifest=@nodejs-1.0.0.dsmanifest \
        -F nodejs-1.0.0.zfs.bz2=@nodejs-1.0.0.zfs.bz2

On EC2 you first upload the image file to S3, then "register" the image
(akin to our 'POST /images'). Perhaps we should do that same. I.e. separate
uploading the image file and adding an image manifest.

(a) /assets storage. Only for system usage and a configured set of allowed
    sdcPerson UUIDs.

(b) DCLS storage. Likewise only for a configured set of allowed sdcPerson UUIDs.

(c) Manta storage.

        MANTA-PUT /trent/stor/images/nodejs-1.2.8.zfs.bz2
        IMGAPI-POST /images -F manifest=@foo.manifest
            # foo.manifest:
            #   ...
            #   files: [{
            #       "content_md5": "EhrISAyeTxis9A+/T55qQg==",   // instead of sha?
            #       "manta_path": "/trent/stor/images/nodejs-1.2.8.zfs.bz2"
            #   }]
            #   ...
            # NO
        IMGAPI-POST /images
            -d name=ndoejs-1.2.8
            -d description="blah blah blah"
            -d os=smartos
            -d
            # foo.manifest:
            #   ...
            #   files: [{
            #       "content_md5": "EhrISAyeTxis9A+/T55qQg==",   // instead of sha?
            #       "manta_path": "/trent/stor/images/nodejs-1.2.8.zfs.bz2"
            #   }]
            #   ...


    Q: What about a multi-dc cloud where Manta is only in some of the DCs?
    Can that happen?
