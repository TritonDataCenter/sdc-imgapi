# IMGAPI changelog

## 3.1.3


## 3.1.2

- DOCKER-950 docker pull fails on registry that does not use authentication

## 3.1.1

- DOCKER-663 Support Amazon ECR Registry

## 3.1.0

- Updates to support using node v4 (IMGAPI-587).

## 3.0.0

This is a major ver bump because there was a significant re-write of
deployment/operational details for standalone IMGAPI (see the RFD 40 "M0"
section, IMGAPI-571, and the added Operator Guide at docs/operator-guide.md).
The REST API has *not* changed incompatibly.

- Many changes to support stock 'imgapi' image builds being usable for
  both DC-mode (i.e. a core instance in a Triton DC) and standalone
  IMGAPI deployments. Some of these affect DC-mode IMGAPI instances as
  well. Highlights:
    - The origin image is changing from the venerable sdc-smartos@1.6.3
      (fd2cc906-8938-11e3-beab-4359c665ac99) to the modern
      sdc-minimal-multiarch-lts@15.4.1 (18b094b0-eb01-11e5-80c1-175dac7ddf02).
      This follows plans from RFD 46 to move to origin images based on
      this. When "triton-origin" images are produced, it is the intent
      to switch imgapi to use those.
    - The node version has moved from node 0.10 to 0.12.
    - "bin/imgapi-standalone-*" scripts are provided for sane deployment,
      and an Operator Guide was written.
    - A standalone IMGAPI uses "boot/standalone/*" for booting,
      "etc/standalone/*" for config, "smf/manifests/*-standalone.xml" for extra
      services, and "tools/standalone" for extra scripts.
    - The config file is now always at "/data/imgapi/etc/imgapi.config.json".
      This is differs from most core Triton instances that render their
      config file to somewhere under "/opt/smartdc/$name/...". Having
      it under "/data/imgapi" means it is on the delegate dataset
      for the instance, which is necessary for standalone deployments.
      It doesn't hurt DC-mode deployments to have it there.
    - Some config file changes: "manta" object at the top level (Manta
      usage by IMGAPI isn't just about image storage), "databaseType"
      instead of "database.type", "authType" instead of "auth.type",
      etc. Generally, absolute paths have been removed from the *config*
      and added to a "lib/constants.js" to simplify code and remove
      clutter/featuritis from the config.
- "basic" auth support has been dropped. It hasn't been used for years
  and need not be supported.
- Update stud dependency for OpenSSL update (IMGAPI-567). This was mainly
  facilitated by the origin image update discussed above.
- "authkeys" refactor for signature auth, including the new `AdminReloadAuthKeys`
  endpoint (IMGAPI-586). Initial client support for this endpoint was added
  in IMGAPI-579: `imgapi-cli reload-auth-keys`.
- Dropped long obsolete, non-working, old migration scripts.


## 2.2.0

First version before I started a changelog.
