---
title: Image API (IMGAPI)
markdown2extras: tables, code-friendly, cuddled-lists, link-patterns
markdown2linkpatternsfile: link-patterns.txt
apisections: Images, Channels, Miscellaneous API
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2015, Joyent, Inc.
-->

# Image API (IMGAPI)

The Image API (IMGAPI) is the SmartDataCenter (SDC) service that manages
virtual machine images. Along with the SmartOS `imgadm` tool, various instances
of the IMGAPI manage images in the SDC and SmartOS ecosystem.


# Introduction

An "image" is virtual machine image content (e.g. a zfs dataset for a
SmartOS zone or a KVM machine image) plus [the metadata for the image (called
the "manifest")](#image-manifests). The following API instances and tools
are relevant for managing images in and for SmartOS and SDC.

The Joyent IMGAPI (https://images.joyent.com) is the central repository
of Joyent-vetted base images for usage in SmartOS. (Images from software
vendors may exist here, but are still vetted by Joyent.) All images here are
public -- no read auth, no private images. SmartOS' `imgadm` version 2
is configured to use this image repository by default. SDC's operator portal
(a.k.a. adminui) is configured by default to use this repository from which
to import images.

Administration of https://images.joyent.com is via the `joyent-imgadm`
tool (currently available in `git@github.com:joyent/sdc-imgapi-cli.git`).

There is an IMGAPI in each SDC datacenter that manages images available in
that datacenter. "IMGAPI" without scoping typically refers to this IMGAPI
in a given datacenter. This is the authority for which images are available
for provisioning in that DC. The provisioning process will lazily
`zfs receive` images on CNs as necessary -- streaming from the IMGAPI
(`imgadm` on that machine handles that). IMGAPI supports private images,
customer-owned images, etc. Cloud API speaks to IMGAPI for its
['/images'](https://mo.joyent.com/docs/cloudapi/master/#images) and legacy
['/datasets'](https://mo.joyent.com/docs/cloudapi/master/#datasets)
endpoints.


# Image manifests

An image manifest is all the data about an image except the image file itself.
Generally this is represented as a JSON object. For example:

    {
      "uuid": "01b2c898-945f-11e1-a523-af1afbe22822",
      "owner": "352971aa-31ba-496c-9ade-a379feaecd52",
      "name": "smartos",
      "version": "1.6.3",
      "state": "active",
      "disabled": false,
      "public": true,
      "published_at": "2012-05-02T15:14:45.805Z",
      "type": "zone-dataset",
      "os": "smartos",
      "files": [
        {
          "sha1": "97f20b32c2016782257176fb58a35e5044f05840",
          "size": 46271847,
          "compression": "bzip2"
        }
      ],
      "description": "Base template to build other templates on",
      "requirements": {
        "networks": [
          {
            "name": "net0",
            "description": "public"
          }
        ]
      }
    }


A summary of fields (details are provided below):

| Field                                                           | Type    | Always Present?               | Mutable? | Notes                                                                                                                                                                                           |
| --------------------------------------------------------------- | ------- | ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [v](#manifest-v)                                                | Integer | Yes                           | No       | Version of the manifest format/spec. The current value is **2**.                                                                                                                                |
| [uuid](#manifest-uuid)                                          | UUID    | Yes                           | No       | The unique identifier for a UUID. This is set by the IMGAPI server. See details below.                                                                                                          |
| [owner](#manifest-owner)                                        | UUID    | Yes                           | Yes      | The UUID of the owner of this image (the account that created it).                                                                                                                              |
| [name](#manifest-name)                                          | String  | Yes                           | No       | A short name for this image. Max 512 characters (though practical usage should be much shorter). No uniqueness guarantee.                                                                       |
| [version](#manifest-version)                                    | String  | Yes                           | No       | A version string for this image. Max 128 characters. No uniqueness guarantee.                                                                                                                   |
| [description](#manifest-description)                            | String  | No                            | Yes      | A short description of the image.                                                                                                                                                               |
| [homepage](#manifest-homepage)                                  | URL     | No                            | Yes      | Homepage URL where users can find more information about the image.                                                                                                                             |
| [eula](#manifest-eula)                                          | URL     | No                            | Yes      | URL of the End User License Agreement (EULA) for the image.                                                                                                                                     |
| [icon](#manifest-icon)                                          | Boolean | No                            | Yes (\*) | Indicates if the image has an icon file. If not present, then no icon is present.                                                                                                               |
| [state](#manifest-state)                                        | String  | Yes                           | No       | The current state of the image. One of 'active', 'unactivated', 'disabled', 'creating', 'failed'.                                                                                               |
| [error](#manifest-error)                                        | Object  | No                            | No       | An object with details on image creation failure. It only exists when `state=='failed'`.                                                                                                        |
| [disabled](#manifest-disabled)                                  | Boolean | Yes                           | No (\*)  | Indicates if this image is available for provisioning.                                                                                                                                          |
| [public](#manifest-public)                                      | Boolean | Yes                           | Yes (\*) | Indicates if this image is publicly available.                                                                                                                                                  |
| [published_at](#manifest-published_at)                          | Date    | Yes (if activated)            | No       | The date at which the image is activated. Set by the IMGAPI server.                                                                                                                             |
| [type](#manifest-type)                                          | String  | Yes                           | Yes      | The image type. One of "zone-dataset" for a ZFS dataset used to create a new SmartOS zone, "lx-dataset" for a Lx-brand image, "zvol" for a virtual machine image or "other" for image types that serve any other specific purpose. |
| [os](#manifest-os)                                              | String  | Yes                           | Yes      | The OS family this image provides. One of "smartos", "windows", "linux", "bsd", "illumos" or "other".                                                                                           |
| [origin](#manifest-origin)                                      | UUID    | No                            | No       | The origin image UUID if this is an incremental image.                                                                                                                                          |
| [files](#manifest-files)                                        | Array   | Yes (if activated)            | No       | An array with a single object describing the image file.                                                                                                                                        |
| [acl](#manifest-acl)                                            | Array   | No                            | Yes      | Access Control List. An array of account UUIDs given access to a private image. The field is only relevant to private images.                                                                   |
| [requirements](#manifest-requirements)                          | Object  | No                            | Yes      | A set of named requirements for provisioning a VM with this image                                                                                                                               |
| [requirements.networks](#manifest-requirementsnetworks)         | Array   | No                            | Yes      | Defines the minimum number of network interfaces required by this image.                                                                                                                        |
| [requirements.brand](#manifest-requirementsbrand)               | String  | No                            | Yes      | Defines the brand that is required to provision with this image.                                                                                                                                |
| [requirements.ssh_key](#manifest-requirementsssh_key)           | Boolean | No                            | Yes      | Indicates that provisioning with this image requires that an SSH public key be provided.                                                                                                        |
| [requirements.min_ram](#manifest-requirementsmin_ram)           | Integer | No                            | Yes      | Minimum RAM (in MiB) required to provision this image.                                                                                                                                          |
| [requirements.max_ram](#manifest-requirementsmax_ram)           | Integer | No                            | Yes      | Maximum RAM (in MiB) this image may be provisioned with.                                                                                                                                        |
| [requirements.min_platform](#manifest-requirementsmin_platform) | Object  | No                            | Yes      | Minimum platform requirement for provisioning with this image.                                                                                                                                  |
| [requirements.max_platform](#manifest-requirementsmax_platform) | Object  | No                            | Yes      | Maximum platform requirement for provisioning with this image.                                                                                                                                  |
| [users](#manifest-users)                                        | Array   | No                            | Yes      | A list of users for which passwords should be generated for provisioning. This may only make sense for some images. Example: `[{"name": "root"}, {"name": "admin"}]`                            |
| [billing_tags](#manifest-billing-tags)                          | Array   | No                            | Yes      | A list of tags that can be used by operators for additional billing processing.                                                                                                                 |
| [traits](#manifest-traits)                                      | Object  | No                            | Yes      | An object that defines a collection of properties that is used by other APIs to evaluate where should customer VMs be placed.                                                                   |
| [tags](#manifest-tags)                                          | Object  | No                            | Yes      | An object of key/value pairs that allows clients to categorize images by any given criteria.                                                                                                    |
| [generate_passwords](#manifest-generate-passwords)              | Boolean | No                            | Yes      | A boolean indicating whether to generate passwords for the users in the "users" field. If not present, the default value is true.                                                               |
| [inherited_directories](#manifest-inherited-directories)        | Array   | No                            | Yes      | A list of inherited directories (other than the defaults for the brand).                                                                                                                        |
| [nic_driver](#manifest-nic-driver)                              | String  | Yes (if `type==="zvol"`)      | Yes      | NIC driver used by this VM image.                                                                                                                                                               |
| [disk_driver](#manifest-disk-driver)                            | String  | Yes (if `type==="zvol"`)      | Yes      | Disk driver used by this VM image.                                                                                                                                                              |
| [cpu_type](#manifest-cpu-type)                                  | String  | Yes (if `type==="zvol"`)      | Yes      | The QEMU CPU model to use for this VM image.                                                                                                                                                    |
| [image_size](#manifest-image-size)                              | Number  | Yes (if `type==="zvol"`)      | Yes      | The size (in MiB) of this VM image's disk.                                                                                                                                                      |
| [channels](#manifest-channels)                                  | Array   | Yes (if server uses channels) | Yes      | Array of channel names to which this image belongs.                                                                                                                                             |

"Mutable?" refers to whether this field can be edited via
[UpdateImage](#UpdateImage). The `icon` boolean is effectively changed by
the [AddImageIcon](#AddImageIcon) and [DeleteImageIcon](#DeleteImageIcon)
endpoints. `disabled` can be modified via the [DisableImage](#DisableImage)
and [EnableImage](#EnableImage) endpoints. `public` cannot be set false for
an image on the "public mode" IMGAPI, e.g. <https://images.joyent.com>.


## Manifest: v

A single positive integer indicating the spec version of the image
manifest. The current version is **2**. Version history:

| v         | Date        | Notes                                                                                                                                                                                          |
| --------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| undefined | -           | All dataset manifests (commonly ".dsmanifest" files) before SDC 7 do not have a "v" field. Versioning of the manifest via `v` was added in SDC 7. This is commonly referred to as version "1". |
| 2         | 2013-Jan-31 | Adds many fields. Deprecates `urn`. Removes already deprecated fields (e.g. `platform_type`). See the "imgmanifest" library for full details.                                                  |


## Manifest: uuid

An image `uuid` is the unique identifier for this UUID. This is what you
use to provision a VM. (For backwards compatibility unique identification
via a `urn` field is supported for legacy images. See the [urn section
below](#manifest-urn).)

An image UUID is created by the server on the [CreateImage](#CreateImage).
There are two exceptions: (1) The [MigrateImage](#MigrateImage) endpoint will
copy an image between two datacenters in the same cloud and persist the
UUID. (2) SDC operators can use the [AdminImportImage](#AdminImportImage)
to add an image with a specified UUID. In the latter case it is the
responsibility of the operator to ensure a given UUID is not duplicated,
or refers to different image data between separate clouds. A common case
for the latter is importing "core" Joyent-provided images from
<https://images.joyent.com>.


## Manifest: urn

**Deprecated.**  In SDC versions before SDC 7, an image (then called a
"dataset") could be uniquely identified by its `uuid` *and* by its `urn`.
While this is still true (images with a URN imported into IMGAPI retain
their URN), new images do not get a URN. The assumptions for the components
of URN (`<cloud_name>:<creator_name>:<name>:<version>`) are not maintainable
in global ecosystem of SmartOS images. Therefore the URN has been dropped as
a supported mechanism of uniquely identifying images. Use the `uuid` field.


## Manifest: owner

The account UUID of the owner/creator of this image.
In non-"dc" mode IMGAPI repositories (where there is no user database) this
value has no meaning.


## Manifest: name

A name for this image. Maximum 512 characters. However, typical names should
be much shorter, e.g. 5-20 characters.

Note that image `name` and `version` do not make a unique identifier for
an image. Separate users (and even the same user) can create images with
the same name and version. The image `uuid` is the only unique identifier
for an image.


## Manifest: version

A version string for this image. Maximum 128 characters. This is an opaque
string, i.e. no particular format or structure is enforced and
no ordering with other versions is implied. However, it is strongly suggested
that the [semver](http://semver.org/) versioning scheme be
followed. Further, the simple `Major.Minor.Patch` semver subset is ideal.

Note that image `name` and `version` do not make a unique identifier for
an image. Separate users (and even the same user) can create images with
the same name and version. The image `uuid` is the only unique identifier
for an image.


## Manifest: description

A short prose description of this image. Maximum 512 characters.


## Manifest: homepage

Homepage URL where users can find more information about the image. Maximum 128
characters.

## Manifest: eula

URL of the End User License Agreement (EULA) for the image. Maximum 128
characters.

## Manifest: icon

A boolean indicates if the image has an icon file. If this field is not
present then the image does not have an icon. The actual icon file content
is available via the [GetImageIcon](#GetImageIcon) endpoint.


## Manifest: state

The current state of the image. One of the following values:

| State       | Description                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| active      | The image is ready for use, i.e. VMs can be provisioned using this image.                                                                                                |
| unactivated | The image has not yet been activated. See [ActivateImage](#ActivateImage).                                                                                               |
| disabled    | The image is disabled. This will be the state if the image is activated, but also `disabled == true`. See [EnableImage](#EnableImage) and [DisableImage](#DisableImage). |
| creating    | A state for a placeholder image while an image is being asynchronously created. This is used during [CreateImageFromVm](#CreateImageFromVm).                             |
| failed      | A state for a placeholder image indicating that asynchronous image creation failed. See the `error` field for details.                                                   |

Note that [`disabled`](#manifest-disabled) and [`state`](#manifest-state) can
seem like duplicate information. However `state` is a computed value from
`disabled` and whether an image has yet been activated.

Images with state `creating` or `failed` are called "placeholder images" --
there is no actual image. Placeholder images are reaped after one week to
prevent very old failures swamping data.



## Manifest: error

An object providing details on failure of some asynchronous image action.
Currently this is used during [CreateImageFromVm](#CreateImageFromVm). It is
only present with `state == 'failed'`. Error fields are as follows:

| Field   | Always Present? | Details                                                                                                                                                                |
| ------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| message | Yes             | String description of the error.                                                                                                                                       |
| code    | No              | A "CamelCase" string error code.                                                                                                                                       |
| stack   | No              | A stack trace giving context for the error. This is generally considered internal implementation detail, only there to assist with debugging and error classification. |

Possible `error.code` values from current SmartDataCenter and SmartOS:

| error.code            | Details                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PrepareImageDidNotRun | This typically means that the target KVM VM (e.g. Linux) has old guest tools that pre-date the image creation feature. Guest tools can be upgraded with installers at <https://download.joyent.com/pub/guest-tools/>. Other possibilities are: a boot time greater than the 5 minute timeout or a bug or crash in the image preparation script. |
| VmHasNoOrigin         | Origin image data could not be found for the VM. Either the link to the image from which the VM was created has been broken (e.g. via 'zfs promote' or migration, see SYSOPS-6491) or there is some problem in either the 'image_uuid' value from `vmadm get` or in imgadm's DB of manifest info for that image.                                |
| NotSupported          | Indicates an error due to functionality that isn't currently supported. One example is that custom image creation of a VM based on a custom image isn't currently supported.                                                                                                                                                                    |



## Manifest: disabled

A boolean indicating if this image is disabled. A disabled image is only
visible to its owner in cloudapi. A disabled image cannot be used for
provisioning.

The [DisableImage](#DisableImage) and [EnableImage](#EnableImage) api
endpoints can be used to update the disabled state of an image.

Note that [`disabled`](#manifest-disabled) and [`state`](#manifest-state) can
seem like duplicate information. However `state` is a computed value from
`disabled` and whether an image has yet been activated.


## Manifest: public

A boolean indicating if this image is publicly available. Public images are
visible (and usable for provisioning) to anyone in cloudapi. Private images
(`public === false`) are only visible to the image owner and accounts listed
in [`acl`](#manifest-acl).


## Manifest: published_at

The date (in ISO-8601 format, e.g. "2012-05-02T15:14:45.805Z") at which this
image was published (i.e. activated via [ActivateImage](#ActivateImage)).

An image UUID is create by the server on the [ActivateImage](#ActivateImage).
There are two exceptions: (1) The [MigrateImage](#MigrateImage) endpoint will
copy an image between two datacenters in the same cloud and persist the
`published_at`. (2) SDC operators can use the
[AdminImportImage](#AdminImportImage) to add an image with a specified uuid
and `published_at`. A common case for the latter is importing "core"
Joyent-provided images from <https://images.joyent.com>.


## Manifest: type

The type of the image file. Must be one of:

| TYPE         | DESCRIPTION                                     |
| ------------ | ----------------------------------------------- |
| zone-dataset | a ZFS dataset used to create a new SmartOS zone |
| lx-dataset   | a dataset used to create a Lx-brand zone        |
| zvol         | a KVM virtual machine image                     |
| docker       | a Docker image                                  |
| other        | an image that serves any other specific purpose |


## Manifest: os

The operating system of the image file. Must be one of:

| OS      | DESCRIPTION                              |
| ------- | ---------------------------------------- |
| smartos | SmartOS                                  |
| linux   | Linux, e.g. CentOS, Ubuntu, etc.         |
| windows | A Microsoft Windows OS image             |
| bsd     | FreeBSD/netBSD                           |
| illumos | Illumos                                  |
| other   | A catch-all for other operating systems. |


## Manifest: origin

If an image has an origin, then it is an **incremental image**. The origin is
the UUID of the origin image. Currenly only a single level of parentage is
allowed. I.e. an origin image cannot itself be incremental.


## Manifest: files

The array of image files that make up this image. Currently only a single
file is supported. An image cannot be activated until it has one file
uploaded. A "file" entry has the following fields:

| FIELD        | DESCRIPTION                                                                                                                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sha1         | SHA-1 hex digest of the file content. Used for upload/download corruption checking.                                                                                                                                                                                                                                                               |
| size         | Number of bytes. Maximum 20GiB. This maximum is meant to be a "you'll never hit it" cap, the purpose is to inform cache handling in IMGAPI servers.                                                                                                                                                                                               |
| compression  | The type of file compression used by the file. One of 'bzip2', 'gzip', 'none'.                                                                                                                                                                                                                                                                    |
| dataset_guid | Optional. The ZFS internal unique identifier for this dataset's snapshot (available via `zfs get guid SNAPSHOT`, e.g. `zfs get guid zones/f669428c-a939-11e2-a485-b790efc0f0c1@final`). If available, this is used to ensure a common base snapshot for incremental images (via `imgadm create -i`) and VM migrations (via `vmadm send/receive`). |

Example:

    {
        ...
        "files": [{
            "sha1": "97f20b32c2016782257176fb58a35e5044f05840",
            "size": 46271847,
            "compression": "bzip2"
        }],
        ...
    }

**Backward compatibility notes:** In the DSAPI (Dataset API) from SDC 6.5
that preceded this there were two more fields:

- `files.*.path`: **Obsolete.** This field is no longer provided. It served
  no safe purpose. There was no guarantee that that "path" value was unique
  across images, hence it should not be used client-side.
- `files.*.url`: **Obsolete.** This field is no longer provided. The download
  URL for the image file is
  [`GET /images/:uuid/file` GetImageFile](#GetImageFile).


## Manifest: acl

An array of user/account UUIDs to which to give read access to a private
image. I.e. this is only relevant for images with `public === false`.


## Manifest: requirements

A grouping of various requirements for provisioning a VM with this image.


## Manifest: requirements.networks

Optional. An array describing the minimum number of network interfaces. This
example shows an image that requires one VNIC:

    {
        ...
        "requirements": {
            "networks": [{"name": "net0", "description": "public"}]
            ...
        },
        ...
    }

## Manifest: requirements.brand

Optional. Defines the SmartOS "brand" that is required to provision with this
image.  Brands are related to the type of virtualization used among other
factors. Common brands are: 'joyent', 'joyent-minimal', 'lx', 'kvm'.

## Manifest: requirements.ssh_key

Optional. A boolean indicating that provisioning with this image requires
that an SSH public key be provided. For example, provisioning a Linux VM
requires an SSH key for initial SSH access. If not defined, it is presumed to
be false.

## Manifest: requirements.min_ram

Optional. `min_ram` is an integer number of MiB specifying the minimum RAM
required to provision this image. If `max_ram` is also specified, then
`min_ram <= max_ram` must be true.

## Manifest: requirements.max_ram

Optional. `max_ram` is an integer number of MiB specifying the maximum RAM
this image may provisioned with. If `min_ram` is also specified, then
`min_ram <= max_ram` must be true.

## Manifest: requirements.min_platform

Optional. `min_platform` defines the minimum required SmartOS platform on
which this image can be used (and hence in SDC on which it will be
provisioned). It is a mapping of major "SDC Version" to the SmartOS platform
timestamp. E.g.:

    "min_platform": {"6.5": "20120901T113025Z", "7.1": "20130308T102805Z"}

This says that the image can only be used on SDC 6.5 platforms later than or
equal to "20120901T113025Z" or SDC 7.1 platforms later than or equal to
"20130308T102805Z".

The SDC version and platform timestamp values correspond to the `sysinfo`
"SDC Version" and "Live Image" keys respectively, e.g.:

    $ sysinfo | json "SDC Version"
    7.0
    $ sysinfo | json "Live Image"
    20130309T172903Z

Note that SDC versions before 7.0 did not have a "SDC Version" key in
sysinfo. If necessary the following may be used to get the appropriate value:

    test -z "$(sysinfo | json "SDC Version")" \
        && echo "6.5" \
        || echo $(sysinfo | json "SDC Version")

If `min_platform` is set but does not contain a key for your SDC version,
then:

1. if SDC version is less than the lowest key, e.g. if "6.4" for the example
   above, then this image **may not** be used on this platform
2. if SDC version is greater than the lowest key, e.g. if "7.0" for the example
   above, then this image **may** be used on this platform. This rule could
   have gone either way, depending on circumstances, hence the decision to
   *allow* in the face of ambiguity.


## Manifest: requirements.max_platform

Optional. `max_platform` defines the maximum allowed SmartOS platform on
which this image can be used (and hence in SDC on which it will be
provisioned). It is a mapping of major "SDC Version" to the SmartOS platform
timestamp. E.g.:

    "max_platform": {"6.5": "20120901T113025Z", "7.1": "20130308T102805Z"}

This says that the image can only be used on SDC 6.5 platforms less than or
equal to "20120901T113025Z" or SDC 7.1 platforms less than or equal to
"20130308T102805Z".

The SDC version and platform timestamp values correspond to the `sysinfo`
"SDC Version" and "Live Image" keys respectively, e.g.:

    $ sysinfo | json "SDC Version"
    7.0
    $ sysinfo | json "Live Image"
    20130309T172903Z

Note that SDC versions before 7.0 did not have a "SDC Version" key in
sysinfo. If necessary the following may be used to get the appropriate value:

    test -z "$(sysinfo | json "SDC Version")" \
        && echo "6.5" \
        || echo $(sysinfo | json "SDC Version")

If `max_platform` is set but does not contain a key for your SDC version,
then:

1. if SDC version is greater than the highest key, e.g. if "7.2" for the example
   above, then this image **may not** be used on this platform
2. if SDC version is greater than the lowest key, e.g. if "7.0" for the example
   above, then this image **may** be used on this platform. This rule could
   have gone either way, depending on circumstances, hence the decision to
   *allow* in the face of ambiguity.


## Manifest: users

Optional. `users` is a list of users for which passwords should be generated
for provisioning. This may only make sense for some datasets. Example:

    "users": [{"name": "root"}, {"name": "admin"}]

## Manifest: billing_tags

Optional. A list of tags that can be used by operators for additional billing
processing. This attribute can be useful for derivative images when the child
image object needs to be related to the parent image for billing or licensing
purposes. Example:

    "billing_tags": ["oracle", "rhel"]

## Manifest: traits

Optional. An object that defines a collection of properties that is used by
other APIs to evaluate where should customer VMs be placed. The keys allowed in
this object are application specific, but only strings, booleans or arrays of
strings are allowed for their values. Example:

    "traits": {
        "users": ["ef5d70c0-5281-154a-9f05-fad0ff43181e],
        "hw": ["richmond-a"],
        "over-provision-ram": "2.5"
    }

## Manifest: tags

Optional. An object of key/value pairs that allows clients to categorize images
by any given criteria. The keys allowed in this object are application specific,
but only strings, numbers or booleans are allowed for their values.
Example:

    "tags": {
      "role": "db",
      "license": "gpl"
    }

## Manifest: generate_passwords

Optional. `generate_passwords` is a boolean indicating whether to generate
passwords for the users in the "users" field. If not present, the default
value is true.

## Manifest: inherited_directories

Optional. `inherited_directories` is a list of inherited directories (other
than the defaults for the brand). This can be left out or the empty list if
the dataset need not inherit directories. This field only makes sense for
datasets of type "zone-dataset". Example:

    {
        ...
        "inherited_directories": ["/opt/support"],
        ...
    }


## Manifest: nic_driver

The NIC driver used by this VM image. Examples are 'virtio', 'ne2k_pci',
'rtl8139', 'e1000', 'pcnet'.
This is a required field for `type === "zvol"` images.


## Manifest: disk_driver

The disk driver used by this VM image. Examples are 'virtio', 'ide', 'scsi'.
This is a required field for `type === "zvol"` images.


## Manifest: cpu_type

The QEMU CPU model to use for this VM. Examples are: "qemu64", "host".
This is a required field for `type === "zvol"` images.


## Manifest: image_size

The size (in MiB) of the VM's disk, and hence the required size of allocated
disk for provisioning.
This is a required field for `type === "zvol"` images.


## Manifest: channels

Array of channel names to which this image belongs. This is only present
and relevant for images in an IMGAPI server that uses [channels](#channels).


# API Summary

| Name                                              | Endpoint                                                   | Notes                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [ListImages](#ListImages)                         | GET /images                                                | List available images.                                                        |
| [GetImage](#GetImage)                             | GET /images/:uuid                                          | Get a particular image manifest.                                              |
| [GetImageFile](#GetImageFile)                     | GET /images/:uuid/file                                     | Get the file for this image.                                                  |
| [DeleteImage](#DeleteImage)                       | DELETE /images/:uuid                                       | Delete an image (and its file).                                               |
| [CreateImage](#CreateImage)                       | POST /images                                               | Create a new (unactivated) image from a manifest.                             |
| [AddImageFile](#AddImageFile)                     | PUT /images/:uuid/file                                     | Upload the image file.                                                        |
| [ActivateImage](#ActivateImage)                   | POST /images/:uuid?action=activate                         | Activate the image.                                                           |
| [UpdateImage](#UpdateImage)                       | POST /images/:uuid?action=update                           | Update image manifest fields. This is limited. Some fields are immutable.     |
| [DisableImage](#DisableImage)                     | POST /images/:uuid?action=disable                          | Disable the image.                                                            |
| [EnableImage](#EnableImage)                       | POST /images/:uuid?action=enable                           | Enable the image.                                                             |
| [AddImageAcl](#AddImageAcl)                       | POST /images/:uuid/acl?action=add                          | Add account UUIDs to the image ACL.                                           |
| [RemoveImageAcl](#RemoveImageAcl)                 | POST /images/:uuid/acl?action=remove                       | Remove account UUIDs from the image ACL.                                      |
| [AddImageIcon](#AddImageIcon)                     | POST /images/:uuid/icon                                    | Add the image icon.                                                           |
| [GetImageIcon](#GetImageIcon)                     | GET /images/:uuid/icon                                     | Get the image icon file.                                                      |
| [DeleteImageIcon](#DeleteImageIcon)               | DELETE /images/:uuid/icon                                  | Remove the image icon.                                                        |
| [CreateImageFromVm](#CreateImageFromVm)           | POST /images?action=create-from-vm                         | Create a new (activated) image from an existing VM.                           |
| [ExportImage](#ExportImage)                       | POST /images/:uuid?action=export                           | Exports an image to the specified Manta path.                                 |
| [CopyRemoteImage](#CopyRemoteImage)               | POST /images/$uuid?action=copy-remote&dc=us-west-1         | **NYI (IMGAPI-278)** Copy one's own image from another DC in the same cloud.  |
| [AdminImportRemoteImage](#AdminImportRemoteImage) | POST /images/$uuid?action=import-remote&source=$imgapi-url | Import an image from another IMGAPI                                           |
| [AdminImportImage](#AdminImportImage)             | POST /images/$uuid?action=import                           | Only for operators to import an image and maintain `uuid` and `published_at`. |
| [AdminGetState](#AdminGetState)                   | GET /state                                                 | Dump internal server state (for dev/debugging)                                |
| [ListChannels](#ListChannels)                     | GET /channels                                              | List image channels (if the server uses channels).                            |
| [ChannelAddImage](#ChannelAddImage)               | POST /images/:uuid?action=channel-all                      | Add an existing image to another channel.                                     |
| [Ping](#Ping)                                     | GET /ping                                                  | Ping if the server is up.                                                     |



# Errors

Error codes that can be returned from IMGAPI endpoints.

<!-- This table is generated by `make doc-update-error-table`. -->
<!-- ERROR TABLE START -->

| Code | HTTP status code | Description |
| ---- | ---------------- | ----------- |
| ValidationFailed | 422 | Validation of parameters failed. |
| InvalidParameter | 422 | Given parameter was invalid. |
| ImageFilesImmutable | 422 | Cannot modify files on an activated image. |
| ImageAlreadyActivated | 422 | Image is already activated. |
| NoActivationNoFile | 422 | Image must have a file to be activated. |
| OperatorOnly | 403 | Operator-only endpoint called by a non-operator. |
| ImageUuidAlreadyExists | 409 | Attempt to import an image with a conflicting UUID |
| Upload | 400 | There was a problem with the upload. |
| StorageIsDown | 503 | Storage system is down. |
| StorageUnsupported | 503 | The storage type for the image file is unsupported. |
| RemoteSourceError | 503 | Error contacting the remote source. |
| OwnerDoesNotExist | 422 | No user exists with the UUID given in the "owner" field for image creation or import. |
| AccountDoesNotExist | 422 | No account exists with the UUID/login given. |
| NotImageOwner | 422 | The caller is not the owner of this image. |
| NotMantaPathOwner | 422 | The caller is not the owner of this Manta path. |
| OriginDoesNotExist | 422 | No image exists with the UUID given in the "origin" field for image creation or import. |
| InsufficientServerVersion | 422 | Image creation is not supported for this VM because the host server version is not of a recent enough version. |
| ImageHasDependentImages | 422 | An error raised when attempting to delete an image which has dependent incremental images (images whose "origin" is this image). |
| NotAvailable | 501 | Functionality is not available. |
| InternalError | 500 | Internal Server Error |
| ResourceNotFound | 404 | Not Found |
| InvalidHeader | 400 | An invalid header was given in the request. |
| ServiceUnavailableError | 503 | Service Unavailable |
| UnauthorizedError | 401 | Unauthorized |
| BadRequestError | 400 | Bad Request |

<!-- ERROR TABLE END -->


# Images

An "image" object is the metadata for an image file, also called the manifest.
See [Image manifest data](#image-manifest-data) above for a summary of all
fields.


## ListImages (GET /images)

List images. Without query params this returns all active
(`state === "active"`) images.

There are two typical calling styles to this endpoint: with 'account=$UUID' and
without. The former is what cloudapi uses to ask on behalf of a particular
authenticated account. The latter is for operator-only querying.

### Inputs

| Field                 | Type       | Required? | Notes |
| --------------------- | ---------- | --------- | ----- |
| account (query param) | UUID       | No        | Only allow access to images visible to this account. A user can only see: (a) active public images, (b) active private images for which they are on the ACL, and (c) their own images. This field is only relevant for ['mode=dc'](#configuration) IMGAPI servers. |
| channel (query param) | String     | No        | The image channel to use. If not provided the server-side default channel is used. Use '*' to list in all channels. (Only relevant for servers using [channels](#channels).) |
| owner                 | UUID       | No        | Only list images owned by this account.                                                                                                                                                                                                                            |
| state                 | String     | No        | List images with the given state. Can be one of 'active' (the default), 'disabled', 'unactivated' or 'all'.                                                                                                                                                        |
| name                  | String     | No        | List images with the given name. Prefix with `~` to do a substring match (case-*sensitive*). E.g., `~foo`.                                                                                                                                                         |
| version               | String     | No        | List images with the given version. Prefix with `~` to do a substring match (case-*sensitive*). E.g., `~foo`.                                                                                                                                                      |
| public                | Boolean    | No        | List just public or just private images.                                                                                                                                                                                                                           |
| os                    | String     | No        | List images with the given os.                                                                                                                                                                                                                                     |
| type                  | String     | No        | List images of the given type. The value can be prefixed with `!` to *exclude* that type.                                                                                                                                                                          |
| tag.{key}             | String     | No        | List images by tags. See below                                                                                                                                                                                                                                     |
| billing_tag           | String     | No        | List images by billing tags. See below                                                                                                                                                                                                                             |
| limit                 | Number     | No        | Maximum number of images to return. Images are sorted by creation date (ASC) by default. The default (and maximum) limit value is 1000                                                                                                                             |
| marker                | UUID, Date | No        | Only return images with a `published_at` >= that of the given image (if a UUID is given) or >= the given date (if a date string is given). |

### Filtering Images

Resuls from ListImages can be paginated by using the limit and marker query
parameters. Both can be used together or separately. Here are a couple of
examples that demostrate their usage:

    Get only 10 images
      GET /images?limit=10

    Get images created after image d0f6f1a8-aef5-11e3-8002-28cfe91a33c9
      GET /images?marker=d0f6f1a8-aef5-11e3-8002-28cfe91a33c9

    Get the next 2 images after image d0f6f1a8-aef5-11e3-8002-28cfe91a33c9
      GET /images?limit=3&marker=d0f6f1a8-aef5-11e3-8002-28cfe91a33c9

ListImages allows sorting the resulting collection by their published_at date.
The *sort* direction can be 'asc' (ascending) or 'desc' (descending), and it is
'asc' by default. It means that the default behavior in ListImages is to return
older images first. At the moment published_at is the only supported sortable
attribute for images. The following are some examples of valid values for the
*sort* query parameter:

    sort=published_at (results in 'published_at ASC', default behavior)
    sort=published_at.desc (results in 'published_at DESC')
    sort=published_at.asc (results in 'published_at ASC')

    Get all images ordered by newest images first
      GET /images?sort=published_at.desc


### Searching Images by Tags or Billing Tags

Images can be searched by tags. If an Image is tagged as 'cloud=private', then
the filter to be added to the request params should be 'tag.cloud=private' and
the full path for the query would look like "/images?tag.cloud=private". More
than one tag can be specified for the same search. Multiple tags are interpreted
as a logical AND, meaning that each of the Images returned is tagged with each of
the values provided.

In contrast, billing tags are not key/value objects but a single array of values.
This means that a query filter for billing_tags is constructed in a conventional
way. As an example, the following queries show the usage of tags and billing_tags
when filtering images.

    One matching tag
      GET /images?tag.cloud=private

    Multiple matching tags
      GET /images?tag.cloud=private&tag.dc=east

    One matching billing tag
      GET /images?billing_tag=promo

    Multiple matching billing tags
      GET /images?biling_tag=promo&billing_tag=smallinstance


### Returns

An array of image objects.

### Errors

See [Errors](#errors) section above.

### Example

Raw curl (from images.joyent.com):

    $ curl -kisS https://images.joyent.com/images | json
    HTTP/1.1 200 OK
    Date: Tue, 08 Jan 2013 01:07:25 GMT
    Content-Type: application/json
    Connection: keep-alive
    Content-Length: 60203
    Server: IMGAPI/1.0.0
    x-request-id: c3993970-592f-11e2-8ef6-f7e53a279942
    x-response-time: 44
    x-server-name: b908c5b2-ccd9-4f43-b5ff-2997eb6bd682.local

    [
      {
        "uuid": "01b2c898-945f-11e1-a523-af1afbe22822",
        "owner": "352971aa-31ba-496c-9ade-a379feaecd52",
        "name": "smartos",
        "version": "1.6.3",
        "state": "active",
        "disabled": false,
        "public": true,
        "published_at": "2012-05-02T15:14:45.805Z",
        "type": "zone-dataset",
        "os": "smartos",
        "files": [
          {
            "sha1": "97f20b32c2016782257176fb58a35e5044f05840",
            "size": 46271847,
            "compression": "bzip2"
          }
        ],
        "description": "Base template to build other templates on",
    ...

CLI tool (from images.joyent.com):

    $ joyent-imgadm list
    UUID                                  NAME           VERSION  OS       STATE   PUBLISHED
    febaa412-6417-11e0-bc56-535d219f2590  smartos        1.3.12   smartos  active  2011-04-11
    7456f2b0-67ac-11e0-b5ec-832e6cf079d5  nodejs         1.1.3    smartos  active  2011-04-15
    ...

    $ joyent-imgadm list name=~base   # filter on substring in name
    UUID                                  NAME    VERSION  OS       STATE   PUBLISHED
    8418dccc-c9c6-11e1-91f4-5fb387d839c5  base    1.7.0    smartos  active  2012-07-09
    d0eebb8e-c9cb-11e1-8762-2f01c4acd80d  base64  1.7.0    smartos  active  2012-07-10
    ...

In an SDC headnode GZ to talk to that data center's IMGAPI:

    $ sdc-imgapi /images
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 515
    Date: Tue, 08 Jan 2013 01:08:19 GMT
    Server: IMGAPI/1.0.0
    x-request-id: e3b681e0-592f-11e2-b638-4b6ffa4ca56f
    x-response-time: 1
    x-server-name: 70f0978d-7efa-4c45-8ebf-8cb9e3a887f7
    Connection: keep-alive

    [
      {
        "uuid": "01b2c898-945f-11e1-a523-af1afbe22822",
        "owner": "352971aa-31ba-496c-9ade-a379feaecd52",
        "name": "smartos",
        "version": "1.6.3",
    ...

CLI tool (from an SDC's IMGAPI):

    $ sdc-imgadm list state=all
    UUID                                  NAME     VERSION  OS       STATE        PUBLISHED
    e70502b0-705e-498e-a810-53a03980eabf  foo      1.0.0    smartos  unactivated  -
    01b2c898-945f-11e1-a523-af1afbe22822  smartos  1.6.3    smartos  active       2012-05-02
    ...


## GetImage (GET /images/:uuid)

Get a image by uuid.

There are two typical calling styles to this endpoint: with 'account=$UUID' and
without. The former is what cloudapi uses to ask on behalf of a particular
authenticated account. The latter is for operator-only querying.

### Inputs

| Field                 | Type   | Required? | Notes                                                                                                                                                                                                                                                              |
| --------------------- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| account (query param) | UUID   | No        | Only allow access to images visible to this account. A user can only see: (a) active public images, (b) active private images for which they are on the ACL, and (c) their own images. This field is only relevant for ['mode=dc'](#configuration) IMGAPI servers. |
| channel (query param) | String | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                 |

### Returns

An image object.

### Errors

See [Errors](#errors) section above.

### Example

Raw curl (from images.joyent.com):

    $ curl -sS https://images.joyent.com/images/01b2c898-945f-11e1-a523-af1afbe22822
    {
      "uuid": "01b2c898-945f-11e1-a523-af1afbe22822",
    ...

CLI tool (from images.joyent.com):

    $ joyent-imgadm get 01b2c898-945f-11e1-a523-af1afbe22822
    {
      "uuid": "01b2c898-945f-11e1-a523-af1afbe22822",
    ...

Raw API tool (from an SDC's IMGAPI):

    $ sdc-imgapi /images/01b2c898-945f-11e1-a523-af1afbe22822
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 513
    Date: Tue, 08 Jan 2013 01:10:06 GMT
    Server: IMGAPI/1.0.0
    x-request-id: 2383aaf0-5930-11e2-b638-4b6ffa4ca56f
    x-response-time: 71
    x-server-name: 70f0978d-7efa-4c45-8ebf-8cb9e3a887f7
    Connection: keep-alive

    {
      "uuid": "01b2c898-945f-11e1-a523-af1afbe22822",
      "owner": "352971aa-31ba-496c-9ade-a379feaecd52",
      "name": "smartos",
      "version": "1.6.3",
      "state": "active",
      "disabled": false,
      "public": true,
      "published_at": "2012-05-02T15:14:45.805Z",
      "type": "zone-dataset",
      "os": "smartos",
      "files": [
        {
          "sha1": "97f20b32c2016782257176fb58a35e5044f05840",
          "size": 46271847,
          "compression": "bzip2"
        }
      ],
      "description": "Base template to build other templates on",
      "urn": "sdc:sdc:smartos:1.6.3",
      "requirements": {
        "networks": [
          {
            "name": "net0",
            "description": "public"
          }
        ]
      }
    }

CLI tool (from an SDC's IMGAPI):

    $ sdc-imgadm get 01b2c898-945f-11e1-a523-af1afbe22822
    {
      "uuid": "01b2c898-945f-11e1-a523-af1afbe22822",
    ...



## GetImageFile (GET /images/:uuid/file)

Get the image file.

### Inputs

| Field                 | Type   | Required? | Notes                                                                                                                                                                                                                                                                |
| --------------------- | ------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account (query param) | UUID   | No        | Only allow access to an image visible to this account. A user can only see: (a) active public images, (b) active private images for which they are on the ACL, and (c) their own images. This field is only relevant for ['mode=dc'](#configuration) IMGAPI servers. |
| channel (query param) | String | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                   |

### Returns

The (typically large) image file content.

### Errors

Any errors produced while transferring the image data will result in the connection
being closed. Clients should compare the returned data's SHA-1 against the value
found in the manifest files object in order to check if the received file is corrupt.

For request validation errors, see [Errors](#errors) section above.

### Example

Raw curl (from images.joyent.com):

    $ curl -kfsS https://images.joyent.com/images/01b2c898-945f-11e1-a523-af1afbe22822/file -o file.bz2

CLI tool (from images.joyent.com):

    $ joyent-imgadm get-file 01b2c898-945f-11e1-a523-af1afbe22822 -O
    100% [=============================]  time 43.4s  eta 0.0s
    Saved "01b2c898-945f-11e1-a523-af1afbe22822.bz2".

Raw API tool (from an SDC's IMGAPI):

    $ sdc-imgapi /images/01b2c898-945f-11e1-a523-af1afbe22822/file -o file.bz2

CLI tool (from an SDC's IMGAPI):

    $ sdc-imgadm get-file 01b2c898-945f-11e1-a523-af1afbe22822 -O
    100% [=============================]  time 43.4s  eta 0.0s
    Saved "01b2c898-945f-11e1-a523-af1afbe22822.bz2".


## GetImageIcon (GET /images/:uuid/icon)

Get the image icon file.

### Inputs

| Field                 | Type   | Required? | Notes                                                                                                                                                                                                                                                                |
| --------------------- | ------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account (query param) | UUID   | No        | Only allow access to an image visible to this account. A user can only see: (a) active public images, (b) active private images for which they are on the ACL, and (c) their own images. This field is only relevant for ['mode=dc'](#configuration) IMGAPI servers. |
| channel (query param) | String | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                   |

### Returns

The image icon file content.

### Errors

Any errors produced while transferring the image icon will result in the connection
being closed. Clients should compare the returned data's SHA-1 against the value
found in the manifest files object in order to check if the received icon file is
corrupt.

For request validation errors, see [Errors](#errors) section above.

### Example

Raw curl:

    $ curl -kfsS https://localhost/images/01b2c898-945f-11e1-a523-af1afbe22822/icon -o icon.png

CLI tool:

    $ joyent-imgadm get-icon 01b2c898-945f-11e1-a523-af1afbe22822 -O
    100% [=============================]  time 0.4s  eta 0.0s
    Saved "01b2c898-945f-11e1-a523-af1afbe22822.png".

Raw API tool:

    $ sdc-imgapi /images/01b2c898-945f-11e1-a523-af1afbe22822/icon -o icon.png


## DeleteImageIcon (DELETE /images/:uuid/icon)

Delete the image icon file.

There are two typical calling styles to this endpoint: with 'account=$UUID' and
without. The former is what cloudapi uses to ask on behalf of a particular
authenticated account. The latter is for operator-only querying.

### Inputs

| Field                 | Type   | Required? | Notes                                                                                                                               |
| --------------------- | ------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| account (query param) | UUID   | No        | Only allow deletion for images *owned* by this account. This field is only relevant for ['mode=dc'](#configuration) IMGAPI servers. |
| channel (query param) | String | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                  |

### Returns

The image object with the 'icon' field now false.

### Errors

See [Errors](#errors) section above.

### Example

CLI tool:

    $ joyent-imgadm delete-icon 01b2c898-945f-11e1-a523-af1afbe22822
    Deleted icon from image 01b2c898-945f-11e1-a523-af1afbe22822

Raw API tool:

    $ sdc-imgapi /images/01b2c898-945f-11e1-a523-af1afbe22822/icon -X DELETE


## DeleteImage (DELETE /images/:uuid)

Delete this image (and its file and icon, if any).

There are two typical calling styles to this endpoint on DC mode IMGAPI servers:
with 'account=$UUID' and without. The former is what cloudapi uses to ask on
behalf of a particular authenticated account. The latter is for operator-only
querying.

For IMGAPI servers that support image channels (e.g. updates.joyent.com)

### Inputs

| Field                            | Type    | Required? | Notes                                                                                                                                        |
| -------------------------------- | ------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| account (query param)            | UUID    | No        | Only allow deletion for images *owned* by this account. This field is only relevant for ['mode=dc'](#configuration) IMGAPI servers.          |
| channel (query param)            | String  | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                           |
| force_all_channels (query_param) | Boolean | No        | Set this true to force deletion even if the image exists in multiple channels. Only relevant for IMGAPI servers using [channels](#channels). |

### Returns

Responds with HTTP 204 (No Content).

### Errors

See [Errors](#errors) section above.

### Example

CLI tool (from images.joyent.com):

    $ joyent-imgadm delete 69d8bd69-db68-a54c-bec5-8c934822cfa9
    Deleted image 69d8bd69-db68-a54c-bec5-8c934822cfa9

Raw API tool (from an SDC's IMGAPI):

    $ sdc-imgapi /images/f9bbbc9f-d281-be42-9651-72c6be875874 -X DELETE

CLI tool (from an SDC's IMGAPI):

    $ sdc-imgadm delete 7a1b1967-6ecf-1e4c-8f09-f49094cc36ad
    Deleted image 7a1b1967-6ecf-1e4c-8f09-f49094cc36ad

Cloud API:

    $ sdc-cloudapi /my/images/7a1b1967-6ecf-1e4c-8f09-f49094cc36ad -X DELETE


## CreateImage (POST /images)

Create a new (unactivated) image from a manifest. The typical process is to
subsequently call [AddImageFile](#AddImageFile) and then
[ActivateImage](#ActivateImage) to finish with an image available for
provisioning.

### Inputs

| Field                                                    | Type    | Required?                | Notes                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account (query param)                                    | UUID    | Yes\*                    | The account UUID on behalf of whom this request is being made. If given and if relevant, authorization will be done for this account. At least one of `account` or `owner` is required. It is expected that all calls originating from a user (e.g. from cloudapi) will provide this parameter. This field is only relevant for ['mode=dc'](#configuration) IMGAPI servers. |
| channel (query param)                                    | String  | No                       | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                                                                                                                          |
| [owner](#manifest-owner)                                 | UUID    | Yes\*                    | The UUID of the owner of this image (the account that created it). If not given, the given `account` is used. At least one of `account` or `owner` is required.                                                                                                                                                                                                             |
| [name](#manifest-name)                                   | String  | Yes                      | A short name (and optionally version) for this image. Max 512 characters. No uniqueness guantee.                                                                                                                                                                                                                                                                            |
| [version](#manifest-version)                             | String  | Yes                      | A version string for this image. Max 128 characters. No uniqueness guarantee.                                                                                                                                                                                                                                                                                               |
| [description](#manifest-description)                     | String  | No                       | A short description of the image.                                                                                                                                                                                                                                                                                                                                           |
| [homepage](#manifest-homepage)                           | URL     | No                       | Homepage URL where users can find more information about the image.                                                                                                                                                                                                                                                                                                         |
| [eula](#manifest-eula)                                   | URL     | No                       | URL of the End User License Agreement (EULA) for the image.                                                                                                                                                                                                                                                                                                                 |
| [disabled](#manifest-disabled)                           | Boolean | No                       | Indicates if this image should be available for provisioning. Default is `false`.                                                                                                                                                                                                                                                                                           |
| [public](#manifest-public)                               | Boolean | No                       | Indicates if this image is publicly available. Default is `false`.                                                                                                                                                                                                                                                                                                          |
| [type](#manifest-type)                                   | String  | Yes                      | The image type. One of "zone-dataset" for a ZFS dataset used to create a new SmartOS zone, "lx-dataset" for a Lx-brand image, "zvol" for a virtual machine image or "other" for image types that serve any other specific purpose. |
| [os](#manifest-os)                                       | String  | Yes                      | The OS family this image provides. One of "smartos", "windows", and "linux".                                                                                                                                                                                                                                                                                                |
| [origin](#manifest-origin)                               | UUID    | No                       | The origin image UUID if this is an incremental image.                                                                                                                                                                                                                                                                                                                      |
| [acl](#manifest-acl)                                     | Array   | No                       | Access Control List. An array of account UUIDs given access to a private image. The field is only relevant to private images.                                                                                                                                                                                                                                               |
| [requirements](#manifest-requirements)                   | Object  | No                       | A set of named requirements for provisioning a VM with this image. See [the requirements docs](#manifest-requirements) above for supported fields.                                                                                                                                                                                                                          |
| [users](#manifest-users)                                 | Array   | No                       | A list of users for which passwords should be generated for provisioning. This may only make sense for some images. Example: `[{"name": "root"}, {"name": "admin"}]`                                                                                                                                                                                                        |
| [billing_tags](#manifest-billing-tags)                   | Array   | No                       | A list of tags that can be used by operators for additional billing processing.                                                                                                                                                                                                                                                                                             |
| [traits](#manifest-traits)                               | Object  | No                       | An object that defines a collection of properties that is used by other APIs to evaluate where should customer VMs be placed.                                                                                                                                                                                                                                               |
| [tags](#manifest-tags)                                   | Object  | No                       | An object of key/value pairs that allows clients to categorize images by any given criteria.                                                                                                                                                                                                                                                                                |
| [generate_passwords](#manifest-generate-passwords)       | Boolean | No                       | A boolean indicating whether to generate passwords for the users in the "users" field. If not present, the default value is true.                                                                                                                                                                                                                                           |
| [inherited_directories](#manifest-inherited-directories) | Array   | No                       | A list of inherited directories (other than the defaults for the brand).                                                                                                                                                                                                                                                                                                    |
| [nic_driver](#manifest-nic-driver)                       | String  | Yes (if `type==="zvol"`) | NIC driver used by this VM image.                                                                                                                                                                                                                                                                                                                                           |
| [disk_driver](#manifest-disk-driver)                     | String  | Yes (if `type==="zvol"`) | Disk driver used by this VM image.                                                                                                                                                                                                                                                                                                                                          |
| [cpu_type](#manifest-cpu-type)                           | String  | Yes (if `type==="zvol"`) | The QEMU CPU model to use for this VM image.                                                                                                                                                                                                                                                                                                                                |
| [image_size](#manifest-image-size)                       | Number  | Yes (if `type==="zvol"`) | The size (in MiB) of this VM image's disk.                                                                                                                                                                                                                                                                                                                                  |

### Returns

The (unactivated) image object.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool (against an SDC's IMGAPI). This creates a new unactivated
image:

    $ sdc-imgapi /images -X POST \
        --data-binary '{
            "name": "foo",
            "version": "1.0.0",
            "type": "zone-dataset",
            "os": "smartos",
            "owner": "b5c5c13d-ccc0-5a43-9a46-245ff960cd81"
        }'
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 236
    Date: Tue, 08 Jan 2013 20:04:01 GMT
    Server: IMGAPI/1.0.0
    x-request-id: 8b547800-59ce-11e2-b638-4b6ffa4ca56f
    x-response-time: 52
    x-server-name: 70f0978d-7efa-4c45-8ebf-8cb9e3a887f7
    Connection: keep-alive

    {
      "uuid": "e70502b0-705e-498e-a810-53a03980eabf",
      "owner": "b5c5c13d-ccc0-5a43-9a46-245ff960cd81",
      "name": "foo",
      "version": "1.0.0",
      "state": "unactivated",
      "disabled": false,
      "public": false,
      "type": "zone-dataset",
      "os": "smartos",
      "files": [],
      "acl": []
    }

CLI tool (against an SDC's IMGAPI):

    $ echo '{
        "name": "foo",
        "version": "1.0.0",
        "type": "zone-dataset",
        "os": "smartos",
        "owner": "b5c5c13d-ccc0-5a43-9a46-245ff960cd81"
    }' | sdc-imgadm create
    Imported image 25ab9ddf-96e8-4157-899d-1dc8be7b9810 (foo, 1.0.0, state=unactivated)


## CreateImageFromVm (POST /images?action=create-from-vm)

Create a new (activated) image from an existing VM. The VM from which the Image
will be created must be stopped. This endpoint has a subset of allowed inputs
compared to [CreateVm](#CreateVm), as many of the Image manifest fields are
going to be directly computed from the source VM.

### Query String Inputs

| Field            | Type    | Required? | Default                                                                                                                                                                                                                                                                                         | Notes |
| ---------------- | ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| account          | UUID    | Yes       | The account UUID on behalf of whom this request is being made. If given and if relevant, authorization will be done for this account. At least one of `account` or `owner` is required. It is expected that all calls originating from a user (e.g. from cloudapi) will provide this parameter. |
| channel          | String  | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                                              |
| vm_uuid          | UUID    | Yes       | The UUID of the source VM.                                                                                                                                                                                                                                                                      |
| incremental      | Boolean | No        | Whether to create an incremental image. Default is `false`.                                                                                                                                                                                                                                     |
| max_origin_depth | Number  | No        | If the image is incremental, this number allows setting a limit in the number of child incremental images. E.g. a value of 3 means that the image will only be created if there are no more than 3 parent images in the origin chain.                                                           |

### Manifest Inputs

The following is the list of inputs that can be specified for a new Image created
from an existing VM:

| Field                                | Type    | Required? | Default | Notes                                                                                                                                                           |
| ------------------------------------ | ------- | --------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [uuid](#manifest-uuid)               | UUID    | No        | -       | UUID of the new Image. A new one will be generated if not specified                                                                                             |
| [owner](#manifest-owner)             | UUID    | Yes\*     | -       | The UUID of the owner of this image (the account that created it). If not given, the given `account` is used. At least one of `account` or `owner` is required. |
| [name](#manifest-name)               | String  | Yes       | -       | A short name (and optionally version) for this image. Max 512 characters. No uniqueness guantee.                                                                |
| [version](#manifest-version)         | String  | Yes       | -       | A version string for this image. Max 128 characters. No uniqueness guarantee.                                                                                   |
| [description](#manifest-description) | String  | No        | -       | A short description of the image.                                                                                                                               |
| [homepage](#manifest-homepage)       | URL     | No        | -       | Homepage URL where users can find more information about the image.                                                                                             |
| [disabled](#manifest-disabled)       | Boolean | No        | false   | Indicates if this image should be available for provisioning.                                                                                                   |
| [public](#manifest-public)           | Boolean | No        | false   | Indicates if this image is publicly available.                                                                                                                  |
| [acl](#manifest-acl)                 | Array   | No        | -       | Access Control List. An array of account UUIDs given access to a private image. The field is only relevant to private images.                                   |
| [tags](#manifest-tags)               | Object  | No        | -       | An object of key/value pairs that allows clients to categorize images by any given criteria.                                                                    |


### Inherited Fields

The following is the list of fields that the new Image will inherit from the source
Image of the VM in question and therefore cannot be specified:

| Field                                                    | Type    | Notes                                                                                                                                                                                           |
| -------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [type](#manifest-type)                                   | String  | The image type. One of "zone-dataset" for a ZFS dataset used to create a new SmartOS zone, "lx-dataset" for a Lx-brand image, "zvol" for a virtual machine image or "other" for image types that serve any other specific purpose. |
| [os](#manifest-os)                                       | String  | The OS family this image provides. One of "smartos", "windows", and "linux".                                                                                                                    |
| [requirements](#manifest-requirements)                   | Object  | A set of named requirements for provisioning a VM with this image. See [the requirements docs](#manifest-requirements) above for supported fields.                                              |
| [users](#manifest-users)                                 | Array   | A list of users for which passwords should be generated for provisioning. This may only make sense for some images. Example: `[{"name": "root"}, {"name": "admin"}]`                            |
| [billing_tags](#manifest-billing-tags)                   | Array   | A list of tags that can be used by operators for additional billing processing.                                                                                                                 |
| [traits](#manifest-traits)                               | Object  | An object that defines a collection of properties that is used by other APIs to evaluate where should customer VMs be placed.                                                                   |
| [generate_passwords](#manifest-generate-passwords)       | Boolean | A boolean indicating whether to generate passwords for the users in the "users" field. If not present, the default value is true.                                                               |
| [inherited_directories](#manifest-inherited-directories) | Array   | A list of inherited directories (other than the defaults for the brand).                                                                                                                        |
| [nic_driver](#manifest-nic-driver)                       | String  | NIC driver used by this VM image.                                                                                                                                                               |
| [disk_driver](#manifest-disk-driver)                     | String  | Disk driver used by this VM image.                                                                                                                                                              |
| [cpu_type](#manifest-cpu-type)                           | String  | The QEMU CPU model to use for this VM image.                                                                                                                                                    |
| [image_size](#manifest-image-size)                       | Number  | The size (in MiB) of this VM image's disk.                                                                                                                                                      |


### Returns

A Job object. The location of the workflow API where the status of the job can
be polled is available in the workflow-api header of the response.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool (against an SDC's IMGAPI). This queues the creation of a new Image
from an existing VM:

    $ sdc-imgapi '/images?action=create-from-vm&vm_uuid=56b107b9-9277-4a6a-bcd3-17c497041bee' \
        -X POST \
        --data-binary '{
            "name": "foo",
            "version": "1.0.0",
            "uuid": "4e88c673-f3ab-4a55-9f5d-b54379cf2d8a",
            "owner": "b5c5c13d-ccc0-5a43-9a46-245ff960cd81"
        }'
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 236
    Date: Tue, 08 Jan 2013 20:04:01 GMT
    Server: IMGAPI/1.0.0
    workflow-api: http://workflow.coal.joyent.us
    x-request-id: 8b547800-59ce-11e2-b638-4b6ffa4ca56f
    x-response-time: 52
    x-server-name: 70f0978d-7efa-4c45-8ebf-8cb9e3a887f7
    Connection: keep-alive

    {
      "image_uuid": "4e88c673-f3ab-4a55-9f5d-b54379cf2d8a",
      "job_uuid": "4c831bba-68ed-4fe8-a54b-a5b5acefd7ac"
    }


## ExportImage (POST /images/:uuid?action=export)

Exports an image to the specified Manta path. Only images that already live
in Manta can be exported, locally stored images are not supported.

### Inputs

| Field                 | Type   | Required? | Notes                                                                                                                                                                                                                                                                           |
| --------------------- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account (query param) | UUID   | No\*      | The account UUID on behalf of whom this request is being made. If given then the manta_path prefix must resolve to a location that is owned by the account. If not given then the manta_path prefix is assumed to (and must) resolve to a path that is owned by the admin user. |
| channel (query param) | String | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                              |
| manta_path            | String | Yes\*     | Manta path prefix where the image file and manifest should be exported to. If "manta_path" is a dir, then the files are saved to it. If the basename of "PATH" is not a dir, then "PATH.imgmanifest" and "PATH.zfs[.EXT]" are created.                                          |

### Returns

A Manta location response object. It provides the properties that allow the
IMGAPI user to retrieve the image file and manifest from Manta: manta_url,
image_path, manifest_path.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool:

    $ sdc-imgapi /images/a93fda38-80aa-11e1-b8c1-8b1f33cd9007?action=export&manta_path=/user/stor/imgapi -X POST
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 200
    Date: Fri, 30 Aug 2013 00:19:11 GMT
    Server: IMGAPI/1.1.1
    x-request-id: cac4f490-1109-11e3-a1a5-012c46265014
    x-response-time: 1225
    x-server-name: 9243385e-9975-4a74-a68e-ce601af89e76
    Connection: keep-alive

    {
      "manta_url": "https://us-east.manta.joyent.com",
      "image_path": "/user/stor/imgapi/smartos-1.6.2.zfs.bz2",
      "manifest_path": "/user/stor/imgapi/smartos-1.6.2.imgmanifest"
    }

CLI tool:

    $ sdc-imgadm export a93fda38-80aa-11e1-b8c1-8b1f33cd9007
    Image a93fda38-80aa-11e1-b8c1-8b1f33cd9007 exported to Manta path /user/stor/imgapi



## AddImageFile (PUT /images/:uuid/file)

Add the image file. If the image already has a file, it will be overwritten.
A file can only be added to an image that has not yet been activated. The
typical process is to call this after [CreateImage](#CreateImage), and then
subsequently call [ActivateImage](#ActivateImage) to make the image available
for provisioning, `state == "active"`.

### Inputs

| Field                          | Type       | Required? | Notes                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ---------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account (query param)          | UUID       | No        | The account UUID on behalf of whom this request is being made. If given and if relevant, authorization will be done for this account. It is expected that all calls originating from a user (e.g. from cloudapi) will provide this parameter.                                                                                                      |
| channel (query param)          | String     | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                                                                                                 |
| storage                        | String     | No        | The type of storage preferred for this image file. Storage can only be specified if the request is being made by an operator. The only two possible values for storage are **local** and **manta**. When the request is made on behalf of a customer then IMGAPI will try to use manta as the storage backend, otherwise default to local storage. |
| [compression](#manifest-files) | UUID       | Yes       | The type of compression used for the file content. One of 'none', 'gzip' or 'bzip2'.                                                                                                                                                                                                                                                               |
| [sha1](#manifest-files)        | SHA-1 Hash | No        | SHA-1 of the uploaded file to allow the server to check for data corruption.                                                                                                                                                                                                                                                                       |
| dataset_guid                   | GUID       | No        | The ZFS internal unique identifier for this dataset's snapshot (available via `zfs get guid SNAPSHOT`, e.g. `zfs get guid zones/f669428c-a939-11e2-a485-b790efc0f0c1@final`). If available, this is used to ensure a common base snapshot for incremental images (via `imgadm create -i`) and VM migrations (via `vmadm send/receive`).            |
| (file content in the body)     | binary     | Yes       | The image file content.                                                                                                                                                                                                                                                                                                                            |

### Returns

The updated image object.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool (against an SDC's IMGAPI). This example is using curl's
`-T/--upload-file <file>` option, which results in a PUT.

    $ sdc-imgapi /images/e70502b0-705e-498e-a810-53a03980eabf/file?compression=bzip2 \
        -T image.bz2
    HTTP/1.1 100 Continue

    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 319
    Date: Tue, 08 Jan 2013 20:17:46 GMT
    Server: IMGAPI/1.0.0
    x-request-id: 773c5b10-59d0-11e2-b638-4b6ffa4ca56f
    x-response-time: 106
    x-server-name: 70f0978d-7efa-4c45-8ebf-8cb9e3a887f7
    Connection: keep-alive

    {
      "uuid": "e70502b0-705e-498e-a810-53a03980eabf",
      "owner": "b5c5c13d-ccc0-5a43-9a46-245ff960cd81",
      "name": "foo",
      "version": "1.0.0",
      "state": "unactivated",
      "disabled": false,
      "public": false,
      "type": "zone-dataset",
      "os": "smartos",
      "files": [
        {
          "sha1": "cd0e0510c4a0799551687901077d7c4c06a4ebd8",
          "size": 46271847,
          "compression": "bzip2"
        }
      ],
      "acl": []
    }

CLI tool:

    $ sdc-imgadm add-file 25ab9ddf-96e8-4157-899d-1dc8be7b9810 -f file.bz2
    100% [=============================]  time 5.6s  eta 0.0s
    Added file "file.bz2" to image 25ab9ddf-96e8-4157-899d-1dc8be7b9810


## AddImageIcon (PUT /images/:uuid/icon)

Add the image icon. If the image already has an icon file, it will be overwritten.
Icons must have a maximum file size of 128Kb pixels and be in one of the following
formats: PNG, GIF or JPG.

### Inputs

| Field                      | Type       | Required? | Notes                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account (query param)      | UUID       | No        | The account UUID on behalf of whom this request is being made. If given and if relevant, authorization will be done for this account. It is expected that all calls originating from a user (e.g. from cloudapi) will provide this parameter.                                                                                                     |
| channel (query param)      | String     | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                                                                                                |
| [sha1](#manifest-files)    | SHA-1 Hash | No        | SHA-1 of the uploaded icon file to allow the server to check for data corruption.                                                                                                                                                                                                                                                                 |
| storage                    | String     | No        | The type of storage preferred for the image icon. Storage can only be specified if the request is being made by an operator. The only two possible values for storage are **local** and **manta**. When the request is made on behalf of a customer then IMGAPI will try to use manta as the storage backend, otherwise default to local storage. |
| (file content in the body) | binary     | Yes       | The icon file content.                                                                                                                                                                                                                                                                                                                            |

### HTTP Request Headers

| Header Name  | Required? | Notes                                                                           |
| ------------ | --------- | ------------------------------------------------------------------------------- |
| Content-Type | Yes       | Content type of the icon file. One of 'image/jpeg', 'image/png' or 'image/gif'. |

### Returns

The updated image object.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool (against an SDC's IMGAPI). This example is using curl's
`-T/--upload-file <file>` option, which results in a PUT.

    $ sdc-imgapi /images/e70502b0-705e-498e-a810-53a03980eabf/icon \
        -H 'content-type: image/png'
        -T icon.png
    HTTP/1.1 100 Continue

    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 319
    Date: Tue, 08 Jan 2013 20:17:46 GMT
    Server: IMGAPI/1.0.0
    x-request-id: 773c5b10-59d0-11e2-b638-4b6ffa4ca56f
    x-response-time: 106
    x-server-name: 70f0978d-7efa-4c45-8ebf-8cb9e3a887f7
    Connection: keep-alive

    {
      "uuid": "e70502b0-705e-498e-a810-53a03980eabf",
      "owner": "b5c5c13d-ccc0-5a43-9a46-245ff960cd81",
      "name": "foo",
      "version": "1.0.0",
      "state": "unactivated",
      "disabled": false,
      "public": false,
      "type": "zone-dataset",
      "os": "smartos",
      "icon": true,
      "files": [
        {
          "sha1": "cd0e0510c4a0799551687901077d7c4c06a4ebd8",
          "size": 46271847,
          "compression": "bzip2"
        }
      ],
      "acl": []
    }

CLI tool:

    $ sdc-imgadm add-icon 25ab9ddf-96e8-4157-899d-1dc8be7b9810 -f icon.png
    100% [=============================]  time 0.4s  eta 0.0s
    Added file "icon.png" to image 25ab9ddf-96e8-4157-899d-1dc8be7b9810


## ActivateImage (POST /images/:uuid?action=activate)

Activate the image. This makes the image available for provisioning -- the
`state` field will be "active". The image must already have had a file
uploaded via [AddImageFile](#AddImageFile). Once activated, an image cannot
be "deactivated". However it can be [*disabled*](#DisableImage) temporarily
or [*deleted*](#DeleteImage) permanently.

### Inputs

| Field                 | Type   | Required? | Notes                                                                                                                                                                                                                                                                |
| --------------------- | ------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account (query param) | UUID   | No        | Only allow access to an image visible to this account. A user can only see: (a) active public images, (b) active private images for which they are on the ACL, and (c) their own images. This field is only relevant for ['mode=dc'](#configuration) IMGAPI servers. |
| channel (query param) | String | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                   |

### Returns

The updated image object.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool:

    $ sdc-imgapi /images/e70502b0-705e-498e-a810-53a03980eabf?action=activate -X POST
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 356
    Date: Tue, 08 Jan 2013 20:21:17 GMT
    Server: IMGAPI/1.0.0
    x-request-id: f5645880-59d0-11e2-b638-4b6ffa4ca56f
    x-response-time: 110
    x-server-name: 70f0978d-7efa-4c45-8ebf-8cb9e3a887f7
    Connection: keep-alive

    {
      "uuid": "e70502b0-705e-498e-a810-53a03980eabf",
      "owner": "930896af-bf8c-48d4-885c-6573a94b1853",
      "name": "foo",
      "version": "1.0.0",
      "state": "active",
      "disabled": false,
      "public": false,
      "published_at": "2013-01-08T20:21:17.932Z",
      "type": "zone-dataset",
      "os": "smartos",
      "files": [
        {
          "sha1": "cd0e0510c4a0799551687901077d7c4c06a4ebd8",
          "size": 42,
          "compression": "bzip2"
        }
      ],
      "acl": []
    }

CLI tool:

    $ sdc-imgadm activate 25ab9ddf-96e8-4157-899d-1dc8be7b9810
    Activated image 25ab9ddf-96e8-4157-899d-1dc8be7b9810


## DisableImage (POST /images/:uuid?action=disable)

Disables the image. This makes the image unavailable for provisioning -- the
`state` field will be "disabled".

### Inputs

| Field                 | Type   | Required? | Notes                                                                                                                                                                                                                                                                |
| --------------------- | ------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account (query param) | UUID   | No        | Only allow access to an image visible to this account. A user can only see: (a) active public images, (b) active private images for which they are on the ACL, and (c) their own images. This field is only relevant for ['mode=dc'](#configuration) IMGAPI servers. |
| channel (query param) | String | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                   |

### Returns

The updated image object.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool:

    $ sdc-imgapi /images/e70502b0-705e-498e-a810-53a03980eabf?action=disable -X POST
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 356
    Date: Tue, 08 Jan 2013 20:21:17 GMT
    Server: IMGAPI/1.0.0
    x-request-id: f5645880-59d0-11e2-b638-4b6ffa4ca56f
    x-response-time: 110
    x-server-name: 70f0978d-7efa-4c45-8ebf-8cb9e3a887f7
    Connection: keep-alive

    {
      "uuid": "e70502b0-705e-498e-a810-53a03980eabf",
      "owner": "930896af-bf8c-48d4-885c-6573a94b1853",
      "name": "foo",
      "version": "1.0.0",
      "state": "disabled",
      "disabled": true,
      "public": false,
      "published_at": "2013-01-08T20:21:17.932Z",
      "type": "zone-dataset",
      "os": "smartos",
      "files": [
        {
          "sha1": "cd0e0510c4a0799551687901077d7c4c06a4ebd8",
          "size": 42,
          "compression": "bzip2"
        }
      ],
      "acl": []
    }

CLI tool:

    $ sdc-imgadm disable 25ab9ddf-96e8-4157-899d-1dc8be7b9810
    Disabled image 25ab9ddf-96e8-4157-899d-1dc8be7b9810


## EnableImage (POST /images/:uuid?action=enable)

Enables the image. This makes the image available for provisioning once again --
the `state` field will be "active".

### Inputs

| Field                 | Type   | Required? | Notes                                                                                                                                                                                                                                                                |
| --------------------- | ------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account (query param) | UUID   | No        | Only allow access to an image visible to this account. A user can only see: (a) active public images, (b) active private images for which they are on the ACL, and (c) their own images. This field is only relevant for ['mode=dc'](#configuration) IMGAPI servers. |
| channel (query param) | String | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                   |

### Returns

The updated image object.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool:

    $ sdc-imgapi /images/e70502b0-705e-498e-a810-53a03980eabf?action=enable -X POST
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 356
    Date: Tue, 08 Jan 2013 20:21:17 GMT
    Server: IMGAPI/1.0.0
    x-request-id: f5645880-59d0-11e2-b638-4b6ffa4ca56f
    x-response-time: 110
    x-server-name: 70f0978d-7efa-4c45-8ebf-8cb9e3a887f7
    Connection: keep-alive

    {
      "uuid": "e70502b0-705e-498e-a810-53a03980eabf",
      "owner": "930896af-bf8c-48d4-885c-6573a94b1853",
      "name": "foo",
      "version": "1.0.0",
      "state": "active",
      "disabled": false,
      "public": false,
      "published_at": "2013-01-08T20:21:17.932Z",
      "type": "zone-dataset",
      "os": "smartos",
      "files": [
        {
          "sha1": "cd0e0510c4a0799551687901077d7c4c06a4ebd8",
          "size": 42,
          "compression": "bzip2"
        }
      ],
      "acl": []
    }

CLI tool:

    $ sdc-imgadm enable 25ab9ddf-96e8-4157-899d-1dc8be7b9810
    Enabled image 25ab9ddf-96e8-4157-899d-1dc8be7b9810


## AddImageAcl (POST /images/:uuid/acl?action=add)

Adds more UUIDs to the Image ACL (access control list). If any of the account
UUIDs is already in the image ACL it gets ignored. For convenience, when the
action parameter is not present it will default to action=add. This means that
the **AddImageAcl** action is valid in either of the two following forms:

    POST /images/:uuid/acl
    POST /images/:uuid/acl?action=add

### Inputs

| Field                 | Type   | Required? | Notes                                                                                                                                                                                                                                                                                           |
| --------------------- | ------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account (query param) | UUID   | No        | The account UUID on behalf of whom this request is being made. If given and if relevant, authorization will be done for this account. At least one of `account` or `owner` is required. It is expected that all calls originating from a user (e.g. from cloudapi) will provide this parameter. |
| channel (query param) | String | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                                              |
| [acl](#manifest-acl)  | Array  | Yes       | Access Control List. An array of account UUIDs to give access to a private image. The field is only relevant to private images.                                                                                                                                                                 |

### Returns

The updated image object.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool:

    $ sdc-imgapi /images/e70502b0-705e-498e-a810-53a03980eabf/acl -X POST
        -d '[ "669a0e24-5e8a-11e2-8c11-7c6d6290281a" ]'
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 356
    Date: Tue, 08 Jan 2013 20:21:17 GMT
    Server: IMGAPI/1.0.0
    x-request-id: f5645880-59d0-11e2-b638-4b6ffa4ca56f
    x-response-time: 110
    x-server-name: 70f0978d-7efa-4c45-8ebf-8cb9e3a887f7
    Connection: keep-alive

    {
      "uuid": "e70502b0-705e-498e-a810-53a03980eabf",
      "owner": "930896af-bf8c-48d4-885c-6573a94b1853",
      "name": "foo",
      "version": "1.0.0",
      "state": "active",
      "disabled": false,
      "public": false,
      "published_at": "2013-01-08T20:21:17.932Z",
      "type": "zone-dataset",
      "os": "smartos",
      "files": [
        {
          "sha1": "cd0e0510c4a0799551687901077d7c4c06a4ebd8",
          "size": 42,
          "compression": "bzip2"
        }
      ],
      "acl": [
        "669a0e24-5e8a-11e2-8c11-7c6d6290281a"
      ]
    }

CLI tool:

    $ sdc-imgadm add-acl 25ab9ddf-96e8-4157-899d-1dc8be7b9810 669a0e24-5e8a-11e2-8c11-7c6d6290281a
    Updated ACL for image 25ab9ddf-96e8-4157-899d-1dc8be7b9810


## RemoveImageAcl (POST /images/:uuid/acl?action=remove)

Removes UUIDs from the Image ACL. Any of the account UUIDs that is not in the
image ACL gets ignored. In contrast to [AddImageAcl](#AddImageAcl), RemoveImageAcl
requires the action parameter to be present and to be equal to 'remove'.

### Inputs

| Field                 | Type   | Required? | Notes                                                                                                                                                                                                                                                                                           |
| --------------------- | ------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account (query param) | UUID   | No        | The account UUID on behalf of whom this request is being made. If given and if relevant, authorization will be done for this account. At least one of `account` or `owner` is required. It is expected that all calls originating from a user (e.g. from cloudapi) will provide this parameter. |
| channel (query param) | String | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                                              |
| [acl](#manifest-acl)  | Array  | Yes       | Access Control List. An array of account UUIDs to remove access to a private image. The field is only relevant to private images.                                                                                                                                                               |

### Returns

The updated image object.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool:

    $ sdc-imgapi /images/e70502b0-705e-498e-a810-53a03980eabf/acl?action=remove -X POST
        -d '[ "669a0e24-5e8a-11e2-8c11-7c6d6290281a" ]'
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 356
    Date: Tue, 08 Jan 2013 20:21:17 GMT
    Server: IMGAPI/1.0.0
    x-request-id: f5645880-59d0-11e2-b638-4b6ffa4ca56f
    x-response-time: 110
    x-server-name: 70f0978d-7efa-4c45-8ebf-8cb9e3a887f7
    Connection: keep-alive

    {
      "uuid": "e70502b0-705e-498e-a810-53a03980eabf",
      "owner": "930896af-bf8c-48d4-885c-6573a94b1853",
      "name": "foo",
      "version": "1.0.0",
      "state": "active",
      "disabled": false,
      "public": false,
      "published_at": "2013-01-08T20:21:17.932Z",
      "type": "zone-dataset",
      "os": "smartos",
      "files": [
        {
          "sha1": "cd0e0510c4a0799551687901077d7c4c06a4ebd8",
          "size": 42,
          "compression": "bzip2"
        }
      ],
      "acl": [
      ]
    }

CLI tool:

    $ sdc-imgadm remove-acl 25ab9ddf-96e8-4157-899d-1dc8be7b9810 669a0e24-5e8a-11e2-8c11-7c6d6290281a
    Updated ACL for image 25ab9ddf-96e8-4157-899d-1dc8be7b9810


## UpdateImage (POST /images/:uuid?action=update)

Update some fields in the image manifest. Not all fields can be updated. The
inputs section lists every image attribute that can be modified.
Any input is optional but at least one attribute must be updated.

**NOTE** Public images residing on a public mode server cannot be made private.

### Inputs

| Field                                                    | Type    | Required? | Notes                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account (query param)                                    | UUID    | No        | Only allow access to an image visible to this account. A user can only see: (a) active public images, (b) active private images for which they are on the ACL, and (c) their own images. This field is only relevant for ['mode=dc'](#configuration) IMGAPI servers. |
| channel (query param)                                    | String  | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                   |
| [description](#manifest-description)                     | String  | No        | A short description of the image.                                                                                                                                                                                                                                    |
| [homepage](#manifest-homepage)                           | URL     | No        | Homepage URL where users can find more information about the image.                                                                                                                                                                                                  |
| [eula](#manifest-eula)                                   | URL     | No        | URL of the End User License Agreement (EULA) for the image.                                                                                                                                                                                                          |
| [public](#manifest-public)                               | Boolean | false     | Indicates if this image is publicly available.                                                                                                                                                                                                                       |
| [type](#manifest-type)                                   | String  | No        | The image type. One of "zone-dataset" for a ZFS dataset used to create a new SmartOS zone, "lx-dataset" for a Lx-brand image, "zvol" for a virtual machine image or "other" for image types that serve any other specific purpose. |
| [os](#manifest-os)                                       | String  | No        | The OS family this image provides. One of "smartos", "windows", and "linux".                                                                                                                                                                                         |
| [acl](#manifest-acl)                                     | Array   | No        | Access Control List. An array of account UUIDs given access to a private image. The field is only relevant to private images.                                                                                                                                        |
| [requirements](#manifest-requirements)                   | Object  | No        | A set of named requirements for provisioning a VM with this image. See [the requirements docs](#manifest-requirements) above for supported fields.                                                                                                                   |
| [users](#manifest-users)                                 | Array   | No        | A list of users for which passwords should be generated for provisioning. This may only make sense for some images. Example: `[{"name": "root"}, {"name": "admin"}]`                                                                                                 |
| [billing_tags](#manifest-billing-tags)                   | Array   | No        | A list of tags that can be used by operators for additional billing processing.                                                                                                                                                                                      |
| [traits](#manifest-traits)                               | Object  | No        | An object that defines a collection of properties that is used by other APIs to evaluate where should customer VMs be placed.                                                                                                                                        |
| [tags](#manifest-tags)                                   | Object  | No        | An object of key/value pairs that allows clients to categorize images by any given criteria.                                                                                                                                                                         |
| [inherited_directories](#manifest-inherited-directories) | Array   | No        | A list of inherited directories (other than the defaults for the brand).                                                                                                                                                                                             |
| [generate_passwords](#manifest-generate-passwords)       | Boolean | No        | A boolean indicating whether to generate passwords for the users in the "users" field.                                                                                                                                                                               |
| [nic_driver](#manifest-nic-driver)                       | String  | No        | NIC driver used by this VM image.                                                                                                                                                                                                                                    |
| [disk_driver](#manifest-disk-driver)                     | String  | No        | Disk driver used by this VM image.                                                                                                                                                                                                                                   |
| [cpu_type](#manifest-cpu-type)                           | String  | No        | The QEMU CPU model to use for this VM image.                                                                                                                                                                                                                         |
| [image_size](#manifest-image-size)                       | Number  | No        | The size (in MiB) of this VM image's disk.                                                                                                                                                                                                                           |

### Returns

The updated image object.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool:

    $ sdc-imgapi /images/f9bbbc9f-d281-be42-9651-72c6be875874?action=update -X POST
        --data-binary '{
            "description": "updated description"
        }'

CLI tool:

    $ sdc-imgadm update f9bbbc9f-d281-be42-9651-72c6be875874 -f data.json
    $ sdc-imgadm update f9bbbc9f-d281-be42-9651-72c6be875874 description='new description'
    $ cat data.json | sdc-imgadm update f9bbbc9f-d281-be42-9651-72c6be875874



## AdminImportImage (POST /images/:uuid?action=import)

Import an image (preserving its `uuid` and `published_at` fields).

This may only be used by operators. This is enforced by requiring that
`account=UUID` is NOT provided. All usage of IMGAPI on behalf of end users
is required to use `account=UUID`; operator usage (e.g. from AdminUI) is
not.

This creates an unactivated image. The typical process is to subsequently
call [AddImageFile](#AddImageFile) and then [ActivateImage](#ActivateImage)
to finish with an image available for provisioning.

This endpoint is similar in spirit to CreateImage, but called by the operator
to preserve `uuid` et al. Typically it is called by the 'import-remote-image'
workflow job initiated by [AdminImportRemoteImage](#AdminImportRemoteImage).

### Inputs

The request body includes the same fields as for [CreateImage](#CreateImage),
including the SDC6-era backward compat fields, with the following additions
and changes:

| Field        | Type | Required? | Default | Notes                                                |
| ------------ | ---- | --------- | ------- | ---------------------------------------------------- |
| account      | UUID | No\*      | -       | This must NOT be provided. See the discussion above. |
| uuid         | UUID | Yes       | -       | The existing image UUID.                             |
| published_at | Date | No        | -       | The published date/time of the image.                |
| ...          | ...  | ...       | ...     | Other fields from [CreateImage](#CreateImage).       |

Other inputs:

| Field                 | Type    | Required? | Notes                                                                                                                                                                                                                 |
| --------------------- | ------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| channel (query param) | String  | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                    |
| action                | String  | Yes       | "import"                                                                                                                                                                                                              |
| skip_owner_check      | Boolean | No        | Defaults to `false`. Pass in 'true' to skip the check that the image "owner" UUID exists in the user database (in SDC this database is UFDS). Note: The owner check is only done for `mode == "dc"` IMGAPI instances. |
| source                | URL     | No        | URL of the source IMGAPI repository. If the source IMGAPI uses channels, a channel may be given via `...?channel=<channel>`. If called with a `source` then only the `uuid` input field is relevant.                  |

### Returns

The (unactivated) image object.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool:

    $ sdc-imgapi /images/01b2c898-945f-11e1-a523-af1afbe22822?action=import \
        -X POST --data-binary @base-14.1.0.imgmanifest
    ...

CLI tool. This example uses the '-f FILE' argument, which will handle
AddImageFile and ActivateImage calls after the AdminImportImage.

    $ sdc-imgadm import -m manifest -f file.bz2
    Imported image 84cb7edc-3f22-11e2-8a2a-3f2a7b148699 (base, 1.8.4, state=unactivated)
    100% [=============================]  time 0.6s  eta 0.0s
    Added file "file.bz2" to image 84cb7edc-3f22-11e2-8a2a-3f2a7b148699
    Activated image 84cb7edc-3f22-11e2-8a2a-3f2a7b148699


## AdminImportRemoteImage (POST /images/:uuid?action=import-remote)

Import an image from another IMGAPI repository. This is typically used for
importing an image from <https://images.joyent.com>, but can be used for any
other valid Image repository. It is mainly a convenience method to allow IMGAPI
to execute the five import steps (get manifest, get file, import manifest,
add file, activate image) on the user's behalf.

This may only be used by operators. All usage of IMGAPI on behalf of end users
is required to use `account=UUID`; operator usage (e.g. from AdminUI) is
not.

This creates an active image ready for consumption.

### Inputs

| Field                 | Type    | Required? | Notes |
| --------------------- | ------- | --------- | ----- |
| channel (query param) | String  | No        | The image channel to use. (Only relevant if the local IMGAPI is using [channels](#channels).) Note: This is the channel for the *local* IMGAPI. To specify the channel on the *remote* IMGAPI, see the `source` param. |
| action                | String  | Yes       | "import-remote" |
| source                | URL     | No        | URL of the source IMGAPI repository. If the source IMGAPI uses channels, a channel may be given via `...?channel=<channel>`. |
| skip_owner_check      | Boolean | No        | Defaults to `false`. Pass in 'true' to skip the check that the image "owner" UUID exists in the user database (in SDC this database is UFDS). Note: The owner check is only done for `mode == "dc"` IMGAPI instances. |


### Returns

A job response object with the following fields:

| Field      | Type | Notes                                                               |
| ---------- | ---- | ------------------------------------------------------------------- |
| image_uuid | UUID | UUID of the image being imported                                    |
| job_uuid   | UUID | The job UUID. In SDC use `sdc-workflow /jobs/$job_uuid` to inspect. |

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool:

    $ sdc-imgapi /images/01b2c898-945f-11e1-a523-af1afbe22822?action=import-remote&source=https://images.joyent.com
    HTTP/1.1 200 OK
    workflow-api: http://workflow.coal.joyent.us
    content-type: application/json
    content-length: 112
    date: Thu, 25 Jul 2013 05:23:23 GMT
    server: IMGAPI/1.0.3
    x-request-id: 4e71ed70-f4ea-11e2-b255-75716000a01d
    x-response-time: 8307
    x-server-name: ba928081-1e9f-49dc-8900-0239956fda7b

    {
      "image_uuid": "a93fda38-80aa-11e1-b8c1-8b1f33cd9007",
      "job_uuid": "b45be0ae-778a-474e-8e41-9793f09ffde1"
    }

CLI tool:

    $ sdc-imgadm import 84cb7edc-3f22-11e2-8a2a-3f2a7b148699 -S https://images.joyent.com
    Imported image 84cb7edc-3f22-11e2-8a2a-3f2a7b148699 (base, 1.8.4, state=active)



## AdminImportDockerImage (POST /images?action=import-docker-image)

Import an image from a *Docker* repository. This endpoint maintains an open
connection and streams out progress messages (single-line JSON objects) during
the import process. On successful completion, the result is an active image
ready for consumption. Typically this is never called by anyone other
than sdc-docker, which uses the output stream to update sdc-docker-specific
data.

This endpoint is intended to only be called by operators. Typically it is
called by the 'pull-image' workflow defined in
[sdc-docker](https://github.com/joyent/sdc-docker).

### Inputs

Query params:

| Field   | Type    | Required? | Notes |
| ------  | ------- | --------- | ----- |
| action  | String  | Yes       | "import-docker-image" |
| repo    | String  | Yes       | The repository from which to pull, e.g. 'busybox' (implies docker hub), 'docker.io/foo/bar', 'my-reg.example.com:1234/busybox'. |
| tag     | String  | Yes       | A Docker tag name, e.g. 'latest', in the given repository. |
| public  | Boolean | No        | Whether to make the imported image public. Default is true. |

Headers:

| Header          | Required? | Notes |
| --------------- | --------- | ----- |
| x-registry-auth | No        | Optional target registry auth formatted as is the 'x-registry-auth' header from the Docker docker client: a base64 encoded JSON object. |


### Returns

A stream of progress messages.
<!-- TODO: spec the messages -->

### Errors

See [Errors](#errors) section above.

### Example

Raw `curl`:

    $ curl -4 --connect-timeout 10 -sS -i -H accept:application/json -H content-type:application/json --url 'http://imgapi.coal.joyent.us/images?action=import-docker-image&repo=busybox&tag=latest' -X POST
    HTTP/1.1 200 OK
    Content-Type: application/json
    Date: Tue, 12 May 2015 00:52:58 GMT
    Server: imgapi/2.1.0
    x-request-id: 3aeada30-f841-11e4-b9d9-2338e30ff146
    x-response-time: 1483
    x-server-name: ec0cd67d-7731-422a-a6c2-f91eb98c6c52
    Connection: keep-alive
    Transfer-Encoding: chunked

    {"type":"status","payload":{"status":"Pulling repository busybox"},"id":"docker.io/busybox"}
    {"type":"head","head":"8c2e06607696bd4afb3d03b687e361cc43cf8ec1a4a725bc96e39f05ba97dd55","id":"docker.io/busybox"}
    {"type":"progress","payload":{"id":"8c2e06607696","status":"Pulling dependent layers"},"id":"docker.io/busybox"}
    {"type":"data","id":"docker.io/busybox","payload":{...}}
    {"type":"progress","id":"docker.io/busybox","payload":{"id":"8c2e06607696","status":"Pulling metadata."}}
    {"type":"progress","id":"docker.io/busybox","payload":{"id":"cf2616975b4a","status":"Pulling metadata."}}
    ...
    {"type":"progress","id":"docker.io/busybox","payload":{"id":"8c2e06607696","status":"Download complete."}}
    {"type":"status","id":"docker.io/busybox","payload":{"status":"Status: Downloaded newer image for busybox:latest"}}


## ListImageJobs (GET /images/:uuid/jobs)

List all jobs created for an image.

### Inputs

| Field     | Type   | Description                                                                                                                   |
| --------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| task      | String | List all jobs of the given task. Currently, task can be any of the following values: 'create-from-vm', 'import-remote-image'. |
| execution | String | Filter jobs that match the given execution state. It can be any of: 'running', 'succeeded', 'failed', 'canceled' or 'queued'. |

### Returns

An array of image job objects.

### Errors

See [Errors](#errors) section above.

### Example

    $ sdc-imgapi /images/0084dad6-05c1-11e3-9476-8f8320925eea/jobs?execution=succeeded
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 3253
    Date: Wed, 11 Sep 2013 23:13:52 GMT
    Server: IMGAPI/1.1.1
    x-request-id: d2924780-1b37-11e3-895c-876b1f3f0171
    x-response-time: 23
    x-server-name: f62ea923-eec8-4c0a-b9e0-fe4feec3bd3e
    Connection: keep-alive

    [
      {
        "execution": "succeeded",
        "chain_results": [
          {
            "result": "No origin (skipping origin image import)",
            "error": "",
            "name": "origin_import_image",
            "started_at": "2013-09-11T23:12:36.993Z",
            "finished_at": "2013-09-11T23:12:37.086Z"
          },
    ...



# Channels

An IMGAPI server can use "channels". Each channel is an independent set of
images in the same server. The set of channels is a [static
configured](#configuration) set of channel names, optionally with a default
channel. Use [ListChannels](#ListChannels) to see the server's configured
channels.

Each relevant IMGAPI endpoint has a `?channel=<channel>` query param to work
with images in that channel. Without it the server's configured default channel
is implied. The [IMGAPI
client](https://mo.joyent.com/node-sdc-clients/blob/master/lib/imgapi.js) takes
a new `channel` constructor option. Image manifests have a new "channels"
field that is an array of the channel names to which the image belongs.

In a server that uses channels, an image can be in one or more channels. An
existing image is added to additional channels via
[ChannelAddImage](#ChannelAddImage). An image is removed from a channel via
[DeleteImage](#DeleteImage) -- the image is not fully deleted from the
repository until it is removed from its last channel.

The current canonical example of an IMGAPI server using channels is the
SmartDataCenter updates server (https://updates.joyent.com). The
[`updates-imgadm`](https://mo.joyent.com/imgapi-cli/blob/channels/bin/updates-imgadm)
CLI takes a `-C <channel>` option or `UPDATES_IMGADM_CHANNEL=<channel>`
environment variable to specify the channel. Additionally on a SmartDataCenter
headnode the `updates-imgadm` will default to the DC's configured update
channel (see the `update_channel` SDC config var).

A channel object has the following fields:

| Field       | Description                                         |
| ----------- | --------------------------------------------------- |
| name        | The channel name. This is the unique id.            |
| default     | Boolean. Only set for the default channel, if any.  |
| description | A short prose description of the channel's purpose. |


## ListChannels (GET /channels)

List the IMGAPI server's channels.

### Inputs

None.

### Returns

An array of channel objects (see above).

### Errors

See [Errors](#errors) section above.

### Example


CLI tool:

    $ updates-imgadm channels
    NAME     DEFAULT  DESCRIPTION
    dev      true     all development builds
    staging  -        builds for testing in staging in prep for production release
    release  -        release gold bits

Raw curl (from updates.joyent.com):

    $ curl -kisS https://updates.joyent.com/channels
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 280
    Date: Tue, 29 Jul 2014 21:56:17 GMT
    Server: IMGAPI/1.2.0
    x-request-id: 2aa89bb0-176b-11e4-b4fe-f1422f0ce754
    x-response-time: 1
    x-server-name: ...
    Connection: keep-alive

    [
      {
        "name": "dev",
        "description": "all development builds",
        "default": true
      },
      {
        "name": "staging",
        "description": "builds for testing in staging in prep for production release"
      },
      {
        "name": "release",
        "description": "release gold bits"
      }
    ]


## ChannelAddImage (POST /images/:uuid?action=channel-add)

Add an image (on the current channel) to a new channel.

### Inputs

| Field                 | Type   | Required? | Notes                                                                              |
| --------------------- | ------ | --------- | ---------------------------------------------------------------------------------- |
| uuid (path)           | UUID   | Yes       | The existing image UUID.                                                           |
| action (query param)  | String | Yes       | "channel-add"                                                                      |
| channel (query param) | String | No        | The image channel to use. (Only relevant for servers using [channels](#channels).) |
| channel (body)        | String | Yes       | The channel to which to add the image.                                             |

Note: Somewhat confusingly, this endpoint uses *two* independent `channel`
field inputs:

1. The "channel" query param, used to find the given image (as with
   most other endpoints), and
2. the "channel" param in the *body*, giving the channel to which to
   add image.

### Returns

The updated image object. The new channel should now be a member of the
image object's [`channels`](#manifest-channels) array.

### Errors

See [Errors](#errors) section above.

### Example

CLI tool:

    $ updates-imgadm channel-add staging 25ab9ddf-96e8-4157-899d-1dc8be7b9810
    Added image 25ab9ddf-96e8-4157-899d-1dc8be7b9810 to channel "staging"



# Miscellaneous API

## Ping (GET /ping)

A simple ping to check to health of the IMGAPI server. Here "pid" is the PID
of the IMGAPI server process. This is helpful for the test suite.

### Inputs

| Field   | Type   | Description                                                                                 |
| ------- | ------ | ------------------------------------------------------------------------------------------- |
| error   | String | Optional. An error code name, e.g. "ResourceNotFound" to simulate an error response.        |
| message | String | Optional. The error message to include in the simulated error response. Defaults to "pong". |

### Returns

When not simulating an error response, a "pong" object is returned:

| Field   | Type    | Description                                                                         |
| ------- | ------- | ----------------------------------------------------------------------------------- |
| ping    | String  | "pong"                                                                              |
| pid     | String  | The PID of IMGAPI server process. Only for non-"public" mode IMGAPI configurations. |
| version | String  | The version of the IMGAPI app.                                                      |
| imgapi  | Boolean | true                                                                                |

When simulating an error, the HTTP response code depends on the error type
and the response body is an JSON object with:

| Field   | Type   | Description                                                     |
| ------- | ------ | --------------------------------------------------------------- |
| code    | String | A restify error code, e.g. "ResourceNotFound", "InternalError". |
| message | String | Error message.                                                  |

### Examples

    $ sdc-imgapi /ping
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 45
    Date: Tue, 08 Jan 2013 19:52:42 GMT
    Server: IMGAPI/1.0.0
    x-request-id: f6f24850-59cc-11e2-b638-4b6ffa4ca56f
    x-response-time: 0
    x-server-name: 70f0978d-7efa-4c45-8ebf-8cb9e3a887f7
    Connection: keep-alive

    {
      "ping": "pong",
      "pid": 23097,
      "version": "1.0.0"
    }

Ping can also be used to simulate error responses from the IMGAPI:

    $ sdc-imgapi /ping?error=ValidationFailed
    HTTP/1.1 422 Unprocessable Entity
    Content-Type: application/json
    Content-Length: 56
    Date: Tue, 08 Jan 2013 19:53:31 GMT
    Server: IMGAPI/1.0.0
    x-request-id: 143dfa30-59cd-11e2-b638-4b6ffa4ca56f
    x-response-time: 0
    x-server-name: 70f0978d-7efa-4c45-8ebf-8cb9e3a887f7
    Connection: keep-alive

    {
      "code": "ValidationFailed",
      "message": "boom",
      "errors": []
    }



## AdminGetState (GET /state)

Return server internal state. For debugging/dev only.

### Inputs

None.

### Returns

A JSON representation of some internal state.

### Example

    $ sdc-imgapi /state
    {
      "cache": {
        ...
      },
      "log": {
        "level": 20
      },
      ...
    }


# Image file storage

There are two possible storage mechanisms for the (large) image files (and image
icon files). Which are in use depend on the IMGAPI configuration (and
availability in the DC).

1. manta: Requires an available Manta. All files are stored in the configured
   user's Manta area (e.g. under "/a-dc-operator/stor/imgapi/"), as opposed
   to storing images own by Bob under Bob's area in Manta.
   Manta storage may be local (i.e. within the same region, this is preferred)
   or remote (a Manta across the WAN).
2. local: A local dir (or locally mounted dir). Only really meant for testing,
   development and bootstrapping. Generally 'local' usage is insufficient
   for producion usage because a locally mounted dir can't handle HA (imgapi
   zones on more than one server).

The set of available storages is set in the [configuration](#configuration).
For example:

    "storage": {
        "manta": {
            "url": "https://us-east.manta.joyent.com",
            "user": "admin",
            "insecure": false,
            "remote": true,
            "key": "/root/.ssh/imgapi.id_rsa",
            "keyId": "59:8a:63:3f:9d:5d:69:5f:cf:37:2e:0d:84:80:91:da"
        },
        "local": {
            "baseDir": "/data/imgapi"
        }
    }

The [`<imgapi-zone>:/opt/smartdc/imgapi/bin/imgapi-manta-setup`](https://github.com/joyent/sdc-imgapi/blob/master/bin/imgapi-manta-setup)
and [`<imgapi-zone>:/opt/smartdc/imgapi/bin/imgapi-external-manta-setup`](https://github.com/joyent/sdc-imgapi/blob/master/bin/imgapi-external-manta-setup)
scripts are intended for use in setting up an IMGAPI to use a Manta.

Local Manta storage, if available, is used in preference to "local" storage.
Manta storage is *required* for user custom image creation, i.e. CloudAPI's
[CreateImageFromMachine](http://apidocs.joyent.com/cloudapi/#CreateImageFromMachine),
unless [overriden](howto-enable-custom-image-creation-without-manta).

If Manta storage is available *but is remote*, then which storage is used is a
little more complicated. The intention is that user-created custom images
(i.e. IMGAPI's CreateImageFromVm, aka CreateImageFromMachine on cloudapi) go
to Manta. However, admin-managed public images for the DC are typically large
and can't practically live in a remote Manta. Therefore the algorithm is that
"admin"-owned images prefer local storage to "remote Manta" storage. Images
owned by others prefer remote Manta storage to local storage.


# Configuration

Reference docs on configuration vars to imgapi. Default values are in
"etc/defaults.json". Custom values are provided in a JSON file passed in with
the "-f CFG-FILE" command-line option. By default this is
"./etc/imgapi.config.json". Note that given custom values override full
top-level keys in the factory settings. For example: if providing
'ufds', one must provide the whole 'ufds' object.

| var | type | default | description |
| --- | ---- | ------- | ----------- |
| port | Number | 8080 | Port number on which to listen. |
| serverName | String | IMGAPI/$version | Name of the HTTP server. This value is present on every HTTP response in the 'server' header. |
| logLevel | String/Number | debug | Level at which to log. One of the supported Bunyan log levels. This is overridden by the `-d,--debug` switch. |
| maxSockets | Number | 100 | Maximum number of sockets for external API calls |
| mode | String | public | One of 'public' (default, running as a public server e.g. images.joyent.com), 'private' (a ironically "public" server that only houses images marked `public=false`), or 'dc' (running as the IMGAPI in an SDC datacenter). |
| datacenterName | String | - | Name of the SDC datacenter on which IMGAPI is running. |
| adminUuid | String | - | The UUID of the admin user in this SDC. |
| channels | Array | - | Set this make this IMGAPI server support [channels](#channels). It must be an array of channel definition objects of the form `{"name": "<name>", "description": "<desc>"[, "default": true]}`. See the example in "etc/imgapi.config.json.in". |
| placeholderImageLifespanDays | Number | 7 | The number of days after which a "placeholder" image (one with state 'failed' or 'creating') is purged from the database. |
| allowLocalCreateImageFromVm | Boolean | false | Whether to allow CreateImageFromVm using local storage (i.e. if no manta storage is configured). This should only be enabled for testing. For SDC installations of IMGAPI `"IMGAPI_ALLOW_LOCAL_CREATE_IMAGE_FROM_VM": true` can be set on the metadata for the 'imgapi' SAPI service to enable this. |
| minImageCreationPlatform | Array | see defaults.json | The minimum platform version, `["<sdc version>", "<platform build timestamp>"]`, on which the proto VM for image creation must reside. This is about the minimum platform with sufficient `imgadm` tooling. This is used as an early failure guard for [CreateImageFromVm](#CreateImageFromVm). |
| ufds.url | String | - | LDAP URL to connect to UFDS. Required if `mode === 'dc'`. |
| ufds.bindDN | String | - | UFDS root dn. Required if `mode === 'dc'`. |
| ufds.bindPassword | String | - | UFDS root dn password. Required if `mode === 'dc'`. |
| auth | Object | - | If in 'public' mode, then auth details are required. 'dc' mode does no auth. |
| auth.type | String | - | One of 'basic' (HTTP Basic Auth) or 'signature' ([HTTP Signature auth](https://github.com/joyent/node-http-signature)). |
| auth.users | Object | - | Required if `auth.type === 'basic'`. A mapping of username to bcrypt-hashed password. Use the `bin/hash-basic-auth-password` tool to create the hash. |
| auth.keys | Object | - | Required if `auth.type === 'signature'`. A mapping of username to an array of ssh public keys. |
| database | Object | - | Database info. The "database" is how the image manifest data is stored. |
| database.type | String | ufds | One of 'ufds' (the default, i.e. use an SDC UFDS directory service) or 'local'. The 'local' type is a quick implementation appropriate only for smallish numbers of images. |
| database.dir | String | - | The base directory for the database `database.type === 'local'`. |
| storage | Object | - | The set of available storage mechanisms for the image *files*. There must be at least one. See the [Image file storage](#image-file-storage) section for discussion. |
| storage.local | Object | - | Object holding config information for "local" disk storage. |
| storage.local.baseDir | String | - | The base directory in which to store image files and archived manifests for "local" storage. This is required even if "storage.manta" is setup for primary storage, because image manifest archives are first staged locally before upload to manta. |
| storage.manta | Object | - | Object holding config information for Manta storage. |
| storage.manta.baseDir | String | - | The base directory, relative to '/${storage.manta.user}/stor', under which image files are stored in Manta. |
| storage.manta.url | String | - | The Manta API URL. |
| storage.manta.insecure | Boolean | false | Ignore SSL certs on the Manta URL. |
| storage.manta.remote | Boolean | - | Whether this Manta is remote to this IMGAPI. This helps IMGAPI determine practical issues on whether manta or local storage is used for large files. |
| storage.manta.user | String | - | The Manta user under which to store data. |
| storage.manta.key | String | - | Path to the SSH private key file with which to authenticate to Manta. |
| storage.manta.keyId | String | - | The SSH public key ID (signature). |
| wfapi.url | String | - | The Workflow API URL. |
| wfapi.workflows | String | - | Array of workflows to load. |
| wfapi.forceReplace | Boolean | - | Wether to replace all workflows loaded every time the IMGAPI service is started. Ideal for development environments |



# Operator Guide

This section is intended to give necessary information for diagnosing and
dealing with issues with Image API in a SmartDataCenter installation.

There is one IMGAPI service per datacenter. There might actually be more than
one "imgapi" zone for HA. Use this to list the imgapi zones in a DC:

    sdc-vmapi /vms?owner_uuid=$(bash /lib/sdc/config.sh -json | json ufds_admin_uuid) \
        | json -H -c "this.tags.smartdc_role=='imgapi'"


## Logs

| service/path | where | format | tail -f |
| ------------ | ----- | ------ | ------- |
| imgapi | in each "imgapi" zone | [Bunyan](https://github.com/trentm/node-bunyan) | `` sdc-login imgapi; tail -f `svcs -L imgapi` | bunyan `` |


## HOWTO: Enable custom image creation without Manta

By default, an IMGAPI in SDC only allows custom image creation (via the
CreateImageFromVm endpoint) if it is configured with Manta storage for
custom image files. However for *test* SDC standups you can hack IMGAPI
to allow local custom image storage.

The symptom of needing to do this from cloudapi or the node-smartdc CLI is:

    $ sdc-createimagefrommachine --machine 3d68ee48-d1fa-685c-9c33-e23064141138 --imageVersion 1.0.0 --name image1 --description "Does this work"
    sdc-createimagefrommachine: error (NotAvailable): custom image creation is not currently available


To allow custom images using *local* storage, run the following in your
SDC headnode global zone:

    echo '{"metadata": {"IMGAPI_ALLOW_LOCAL_CREATE_IMAGE_FROM_VM": true}}' \
      | sapiadm update $(sdc-sapi /services?name=imgapi | json -H 0.uuid)

When the 'config-agent' running in the imgapi zone picks up this change
(after about 30s), the imgapi service will be restarted with
`"allowLocalCreateImageFromVm": true` (see [the Configuration
section](#configuration) above).


## HOWTO: Dig into IMGAPI's Manta storage

If this IMGAPI is setup to use Manta.

        HN=stage2    # my SDC headnode login

        # Get one of the Manta LB IPs:
        export MANTA_URL=https://$(ssh $HN "/opt/smartdc/bin/sdc-vmapi /vms?tag.manta_role=loadbalancer | json -H -c 'this.state==\"running\"' 0.nics | json -c 'this.nic_tag==\"external\"' 0.ip" 2>/dev/null)

        # Get a local copy of the admin SSH key being used for Manta access
        # (or add your own to the admin user).
        ZONENAME=$(ssh $HN vmadm lookup -1 alias=imgapi0)
        mkdir -p /var/tmp/$HN
        cd /var/tmp/$HN
        scp $HN:/zones/$ZONENAME/root/root/.ssh/id_rsa* .

        # This would be sufficient for python-manta and mantash:
        #    export MANTA_KEY_ID=`pwd`/id_rsa
        # However, node-manta tools are a little more picky. You need to
        # have your id_rsa in ~/.ssh or in your agent. So we'll do the
        # latter:
        chmod 0600 id_rsa*
        ssh-add `pwd`/id_rsa
        MANTA_KEY_ID=$(ssh-keygen -l -f id_rsa.pub | awk '{print $2}')

        export MANTA_USER=admin
        set | grep MANTA_

        # With mantash from python-manta:
        mantash -k find /admin/stor/imgapi

        # With node-manta tools:
        # TODO: I think node-manta tools don't support a non-default path
        # to the ssh key?


## Configuring IMGAPI for HTTPS

This section is for setting up an IMGAPI that lives *outside* of an SDC
installation. Examples of this are for <https://images.joyent.com> and
<https://updates.joyent.com>.

On SmartOS, IMGAPI can be deployed to support HTTPS with the use of Stud
(https://github.com/bumptech/stud) as a SSL/TLS termination proxy. Because of the
way Stud works we need to put an additional reverse proxy between Stud and IMGAPI:
HAProxy. The only caveat here is that the latest version of HAProxy doesn't
fully understand the traffic coming from Stud, so we use a patched version of
the package.

### Prerequisites and Assumptions

* IMGAPI running on an Image with at least a 2012Q2 release of pkgsrc
* IMGAPI running on port 8080 if using configuration defaults
* Generated certficate file
* gmake

### Installing and Configuring HAProxy

The IMGAPI repository contains the patched copy of HAProxy under the deps/
directory. cd to that directory and proceed to compile HAProxy as follows:

    cd $IMGAPI_REPO/deps/haproxy-1.4.21/
    gmake TARGET=solaris

It's not necessary to move the resulting binary to another location. Now, we need
to configure HAProxy. This repository contains a sample configuration file (on
etc/haproxy.cfg.in) that will make the proxy listen on port 8443 and redirect
its traffic to port 8080.

The final step is to import the HAProxy SMF file in order to run the proxy as a
service. The IMGAPI repository contains a sample service definition file that
can be imported after updating the exec_method tag and config_file values to
reflect the current install setup. With a valid SMF file we can proceed to
import it and start running HAProxy:

    cp $IMGAPI_REPO/smf/manifests/haproxy.xml.in $IMGAPI_REPO/smf/manifests/haproxy.xml
    # --- Replace variables ---
    svccfg import $IMGAPI_REPO/smf/manifests/haproxy.xml
    svcadm enable haproxy:default

### Installing and configuring Stud

Configuring Stud is easier since it doesn't require a custom binary, we use the
version provided by pksrc. Additionally, pkgsrc provides a sample SMF and
configuration file to use for Stud. Begin by installing the package:

    # Install Stud
    pkgin -y in stud-0nb20120827

This package will write a sample configuration file to /opt/local/etc/stud.conf.
For this guide we assume that Stud will terminate and redirect its traffic to a
service listening on port 8443. The only additional value we need to modify
is pem-file, which specifies the location of the SSL certificate to use. After
updating the configuration file we enable the Stud SMF service, since the sample
SMF file was already imported (assuming we are OK with using
/opt/local/etc/stud.conf as the location for our configuration file):

    svcadm enable stud:default

At this point Stud, HAProxy and IMGAPI should all be running correctly. We can
confirm this with the help of the netstat command:

    netstat -f inet -an

    TCP: IPv4
       Local Address        Remote Address    Swind Send-Q Rwind Recv-Q    State
    -------------------- -------------------- ----- ------ ----- ------ -----------
          *.8080               *.*                0      0 128000      0 LISTEN
          *.8443               *.*                0      0 128000      0 LISTEN
    127.0.0.1.8081             *.*                0      0 128000      0 LISTEN
          *.443                *.*                0      0 128000      0 LISTEN
