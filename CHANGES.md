# Image API (IMGAPI) change log

# 1.1.1

- PUBAPI-659: Add support for '?account=UUID' on DeleteImage to guard
  against CloudAPI's DeleteImage allowing users to delete images that
  are not owned by them.

# 1.1.0

- IMGAPI-214: Incremental image support. New "origin" manifest field.

# 1.0.3

- IMGAPI-244: Fix possible crash in audit logging

# 1.0.2

- IMGAPI-201: "sdc-imgadm enable" does not enable images in us-east-1


# 1.0.1

- [HEAD-1665] Update imgmanifest dep to ensure proper upgrade of "disabled"
  in manifests, and hence proper import of disabled images using a pre-v2
  manifest.

# 1.0.0

(Will start filling this in after a first real release.)

