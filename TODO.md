
# overview

- Fill out each of the use cases in index.restdown. Do those use cases cover
  all of UpdateImage, DisableImage, EnableImage, MigrateImage, AdminImportImage?
  Tickets for each.
- imgadm2
- get storage (local and manta) working:
    - local needs to have a formal separate delegated dataset ... which
      only works for HN. What's the HA plan? We doing DCLS or no?
- test cloudapi compat
- Compat with SDC6 cloudapi dataset endpoints.
- SDC 6.5 provisioner changes for SDC7 headnode: AGENT-534
- Review usage with customer image creation plan DATASET-323.
  Trent ref: https://mail.google.com/mail/u/1/?ui=2&shva=1#inbox/1379fad460845d56
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
- tangent on linode StackScripts for SDC... with gist integration, etc.
  cloudapi does the userscript aggregation. This is a good potential
  backstop for IMGAPI in SDC 6.



