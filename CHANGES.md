# IMGAPI changelog

## 4.12.1

- TRITON-2326 CVE-2020-7712 Command injection in json
- TRITON-2327 CVE-2018-3737 Regular Expression Denial of Service in sshpk
- TRITON-2332 imgapi tests broken due to outdated alpine image

## 4.12.0

- TRITON-2304 New image server names

## 4.11.2

- TRITON-2287 update sdc-imgapi base image to `triton-origin-x86_64-21.4.0`

  This release also removes stud and uses haproxy directly for TLS termination.
  No API changes.

## 4.11.1

- TRITON-2271 lxc "images:" repo changed the URL

## 4.11.0

- TRITON-2228: Linux CN minimum viable product

  Imgapi now supports importing LXC images for Linux compute nodes.

## 4.10.0

- TRITON-2005 imgapi needs to stop using snaplinks

  There should be no external functional change to IMGAPI due to this change,
  other than CloneImage and ExportImage taking slightly longer.

  There were a number of IMGAPI endpoints that would use snaplinks for moving
  image files around for those that were stored in Manta (non-admin-owned images
  in an IMGAPI configured to use a Manta). These have been changed to instead
  stream the file out and stream the file back into Manta at the wanted path.

  The one exception to that change is ImportImage: This *used* to write a
  temporary object path (`.../$uuid/file0.$req_id`) and then get linked to its
  final location (`.../$uuid/file0`). Now, for MantaStorage, it just writes
  directly to the final location. Manta semantics are such that a failed partial
  write does *not* blow away an existing object already at that location, which
  was the original reason for that temporary path write.

  Endpoints affected by this change:
  - AddImageFile (used by typical 'sdc-imgadm import ...' commands)
  - AddImageFileFromUrl
  - UpdateImage (when changing the UUID, as used only by 'docker build')
  - CloneImage ('triton image clone ...')
  - ImportFromDatacenter ('triton image copy ...')
  - AdminChangeImageStor ('sdc-imgadm change-stor ...')
  - ExportImage ('triton image export ...')
  - AddImageIcon

## 4.9.0

- TRITON-2053 standalone imgapi could be easier to test with

## 4.8.0

- TRITON-2052 sdc-imgadm import should import from any channel by default

## 4.7.0

- TRITON-1738 update imgapi base image to triton-origin-x86_64-18.4.0
- TRITON-1737 imgapi should use node v6

## 4.6.2

- TRITON-1227 Windows snapshot script needs to be under 3000 bytes long

## 4.6.1

- TRITON-760 Fix imgapi-manta-setup (again, missed some cases) tooling
  broken in v4.4.0 by TRITON-53.

## 4.6.0

- TRITON-774 imgapi should allow admin-only file-add from URLs, adds a new
  AddImageFileFromUrl endpoint /images/:uuid/file/from-url (POST).

## 4.5.2

- TRITON-682 imgapi support for requirements.bootrom

## 4.5.1

- TRITON-760 Fix imgapi-external-manta-setup and imgapi-manta-setup tooling
  broken in v4.4.0 by TRITON-53.

## 4.5.0

- TRITON-52 x-DC image copy. This adds a new ImportImageFromDatacenter
  endpoint, which will allow a user to copy an image between datacenters in the
  same cloud. As an optimization (and when configured by the cloud operator),
  images that use the same Manta storage will be able to take advantage of snap
  linking, instead of directly copying the file bits, which greatly speeds up
  the image copying process.

## 4.4.0

- TRITON-53 x-account image clone, adds a new CloneImage
  /images/:uuid/clone endpoint.

## 4.3.1

- TRITON-489 Add metricPort metadata to IMGAPI for cmon-agent

## 4.3.0

- TRITON-178 Add support for image creation with bhyve brand (requires platform
  support)

## 4.2.2

- TRITON-222 Use node-triton-metrics for IMGAPI metrics collection

## 4.2.1

- TRITON-221 sdc-imgadm import broken for lx images

## 4.2.0

- TRITON-98 Add artedi metrics collection to IMGAPI

## 4.1.1

- TRITON-134 imgapi docker push allows insecure docker pushes

## 4.1.0

- DOCKER-524: Implement docker push. This adds a new AdminPushDockerImage
  /images/:uuid/push endpoint that the sdc-docker zone will use to push docker
  images.

## 4.0.14

- TRITON-114 cloudapi test failing on image create from vm

## 4.0.13

- DOCKER-1095 add redirect handling for docker registry client getManifest

## 4.0.12

- IMGAPI-651 for lx-dataset images `imgadm publish ...` inherits min_platform
  from the origin image (or removes it for non-incremental images) when an
  older imgadm version < 3.7.4 is used.
- Dropped obsolete IMGAPI-312 workaround, which would set min_platform for
  SmartOS images when the version of imgadm did not already set min_platform.
- Dropped obsolete IMGAPI-251 workaround, which ensured incremental images set
  min_platform to a version that included imgadm incremental image support.

## 4.0.11

- joyent/node-docker-registry-client#23 Namespace validation too strict
- DOCKER-1095 docker pull should distinguish between auth error and not found
  error

## 4.0.10

- DOCKER-1104 support docker manifest lists

## 4.0.9

- IMGAPI-645 create a simple and fast imgapiadm check-files

## 4.0.8

- IMGAPI-644 the docker image cache must clear activated image entries

## 4.0.7

- IMGAPI-642 missing file0 from imgapi docker image causing container provision
  failure

## 4.0.6

- IMGAPI-643 docker pull crashes if an unexpected x-registry-config header is
  used

## 4.0.5

- DOCKER-1097 docker pull fails for registry server that has no auth setup

## 4.0.4

- joyent/sdc-imgapi#13 imgapi crash when pulling from docker.io with invalid
  credentials

## 4.0.3

- IMGAPI-637: correctly report when docker image is update to date

## 4.0.2

- IMGAPI-636: docker pull retry not working for v2.1 images

## 4.0.1

- IMGAPI-635: imgapi crashing on 'docker pull holzi/quine-relay:latest'

## 4.0.0

- DOCKER-929 Support the docker v2.2 manifest format.

This is a major version bump because of the significant changes to the docker
image pull handling, which is incompatible with previous versions of IMGAPI.

## 3.3.1

- IMGAPI-632 Fix potential crash from in static served URLs.

## 3.3.0

- IMGAPI-627 With this change, a standalone IMGAPI will use an ECDSA key for
  auth to its Manta storage (if any). Before this a 4k RSA key was used, which,
  for node at least, is slow so put a significant limit on req/s.

## 3.2.2

- IMGAPI-621 handling of query params with '.' broken since IMGAPI-587

## 3.2.1

- DOCKER-984 'docker pull some-unreachable-ip/name:tag' takes a LONG time to fail
- DOCKER-983 'docker --tls pull nope.example.com/nope' is way too slow

## 3.2.0

- IMGAPI-601 IMGAPI should allow '+' in a manifest version

## 3.1.3

- DOCKER-959 Unable to pull from registry when registry response sends multiple
  Docker-Distribution-Api-Version headers
- IMGAPI-600 AdminImportDockerImage 'error' progress message should use
  restify-errors err.name as a fallback code

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
