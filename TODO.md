
# overview

- Fill out each of the use cases in index.restdown. Do those use cases cover
  all of UpdateImage, DisableImage, EnableImage, MigrateImage, AdminImportImage?
  Tickets for each.
- get storage (local and manta) working:
    - local needs to have a formal separate delegated dataset ... which
      only works for HN. What's the HA plan? We doing DCLS or no?
- test cloudapi compat
- Compat with SDC6 cloudapi dataset endpoints.
- SDC 6.5 provisioner changes for SDC7 headnode: AGENT-534
- Review usage with customer image creation plan DATASET-323.
  Trent ref: https://mail.google.com/mail/u/1/?ui=2&shva=1#inbox/1379fad460845d56
- usageapi/billing issues
- multi-dc
- support for adminui and portal
- node-smartdc update: new "--image" options, deprecate "--dataset"


# general todos

- need to handle cloudapi endpoints for creating images fail gracefully if
  don't have manta -> test case
- images.joyent.com/ -> /images ? or to /docs
- public docs for images.joyent.com
- smartos-live/issues for imgadm and dsadm
- error restdown table generation (TOOLS-204)
- error response audit log body fix (restify#225)
- DCLS handling once wdp has DCLS ready?
- understand the zoneinit reboot compat (6.5 CN) issues (see design)
- manifest fields:
    TODO: new ones from design.restdown section
    TODO: compare validtion with rules in mapi/models/dataset.rb

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
