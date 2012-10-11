
# overview

- get a clear error handling story (vError? long stack traces. documented errors)
    - get current in
        - ensure verror and restify patches get in
    - errors.js -> ruhroh.js
    - errors restdown generation
    - full traceback in audit log (also need me to do restify patch for
      formatter usage of error output?)
- implement basic endpoints:
    - validation lib -> perhaps generic version of assert-plus
- Fill out each of the use cases in index.restdown.
- move datasets.joyent.com to JPC2
- get headnode.sh starter images into IMGAPI
- get storage (local and manta) working
- re-write imgadm to be reliable
- Spec the cloudapi endpoints.
- Compat with SDC6 cloudapi dataset endpoints.
- Review usage with customer image creation plan DATASET-323.
  Trent ref: https://mail.google.com/mail/u/1/?ui=2&shva=1#inbox/1379fad460845d56
- usageapi/billing issues
- what else?


# general todos

- cacheKey in ufdsmodel.js for modelList is wrong, needs to be
  request-specific. Perhaps Model.cacheKeyFromReq()?
- smartos-live/issues for imgadm and dsadm
- npm shrinkwrap
- convert dsapi test suite to a "bwcompat" test suite for
- update imgadm man page
- manifest "files" field: only allow one (because the tool chain only ever
  does) but doc that it is a list for future possible
- DCLS handling once wdp has DCLS ready
- understand the zoneinit reboot compat (6.5 CN) issues (see design)


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
