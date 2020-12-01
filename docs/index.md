---
title: Image API (IMGAPI)
markdown2extras: tables, code-friendly, cuddled-lists, link-patterns
markdown2linkpatternsfile: link-patterns.txt
apisections: Images, Channels, Miscellaneous API
---

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
| [type](#manifest-type)                                          | String  | Yes                           | Yes      | The image type. One of "zone-dataset" for a ZFS dataset used to create a new SmartOS zone, "lx-dataset" for a Lx-brand image, "lxd" for a LXD image, "zvol" for a virtual machine image or "other" for image types that serve any other specific purpose. |
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
| [requirements.bootrom](#manifest-requirementsbootrom)           | String  | No                            | Yes      | Bootrom image to use with this image.                                                                                                                                  |
| [users](#manifest-users)                                        | Array   | No                            | Yes      | A list of users for which passwords should be generated for provisioning. This may only make sense for some images. Example: `[{"name": "root"}, {"name": "admin"}]`                            |
| [billing_tags](#manifest-billing_tags)                          | Array   | No                            | Yes      | A list of tags that can be used by operators for additional billing processing.                                                                                                                 |
| [traits](#manifest-traits)                                      | Object  | No                            | Yes      | An object that defines a collection of properties that is used by other APIs to evaluate where should customer VMs be placed.                                                                   |
| [tags](#manifest-tags)                                          | Object  | No                            | Yes      | An object of key/value pairs that allows clients to categorize images by any given criteria.                                                                                                    |
| [generate_passwords](#manifest-generate_passwords)              | Boolean | No                            | Yes      | A boolean indicating whether to generate passwords for the users in the "users" field. If not present, the default value is true.                                                               |
| [inherited_directories](#manifest-inherited_directories)        | Array   | No                            | Yes      | A list of inherited directories (other than the defaults for the brand).                                                                                                                        |
| [nic_driver](#manifest-nic_driver)                              | String  | Yes (if `type==="zvol"`)      | Yes      | NIC driver used by this VM image.                                                                                                                                                               |
| [disk_driver](#manifest-disk_driver)                            | String  | Yes (if `type==="zvol"`)      | Yes      | Disk driver used by this VM image.                                                                                                                                                              |
| [cpu_type](#manifest-cpu_type)                                  | String  | Yes (if `type==="zvol"`)      | Yes      | The QEMU CPU model to use for this VM image.                                                                                                                                                    |
| [image_size](#manifest-image_size)                              | Number  | Yes (if `type==="zvol"`)      | Yes      | The size (in MiB) of this VM image's disk.                                                                                                                                                      |
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
followed.

Note that image `name` and `version` do not make a unique identifier for
an image. Separate users (and even the same user) can create images with
the same name and version. The image `uuid` is the only unique identifier
for an image.

Starting in IMGAPI v3.2.0, support was added to allow '+' in the "version"
field, because this is one of the characters [allowed by
semver](http://semver.org/#spec-item-10). However, it wasn't until OS-5798 that
`imgadm` (v3.7.0) in the platform was update to allow '+' in a version.
Therefore a **warning**: do not use '+' in an image version until you know that
the minimum platform version for any server in your target DC(s) is greater than
or equal to 20161118T231131Z (when OS-5798 was
[integrated](https://github.com/joyent/smartos-live/commit/fc5816a)).


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

A boolean indicating if this image is disabled. A disabled image cannot be used
for provisioning. Disabling an image will remove it from the default list of
images returned by [ListImages](#ListImages). However, a user can still list
it via with the `state=all` parameter.

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
| lxd          | a LXD image                                     |
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
| stor         | Only included if `?inclAdminFields=true` is passed to GetImage/ListImages. The IMGAPI storage type used to store this file. |
| digest       | Optional. Docker digest of the file contents. Only used when manifest.type is 'docker'. This field gets set automatically by the AdminImportDockerImage call. |
| uncompressedDigest | Optional. Docker digest of the uncompressed file contents. Only used when manifest.type is 'docker'. This field gets set automatically by the AdminImportDockerImage call. Note that this field will be removed in a future version of IMGAPI. |

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


## Manifest: requirements.bootrom

Optional. `bootrom` defines the boot ROM image to use. May take values `"bios"`
or `"uefi"`. Only valid when `brand` is `bhyve`.


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

The NIC driver used by this VM image. Examples are 'virtio' and 'e1000'.
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
| [AddImageFileFromUrl](#AddImageFileFromUrl)       | POST /images/:uuid/file/from-url                           | Upload the image file using a URL source.                                     |
| [ActivateImage](#ActivateImage)                   | POST /images/:uuid?action=activate                         | Activate the image.                                                           |
| [UpdateImage](#UpdateImage)                       | POST /images/:uuid?action=update                           | Update image manifest fields. This is limited. Some fields are immutable.     |
| [DisableImage](#DisableImage)                     | POST /images/:uuid?action=disable                          | Disable the image.                                                            |
| [EnableImage](#EnableImage)                       | POST /images/:uuid?action=enable                           | Enable the image.                                                             |
| [AddImageAcl](#AddImageAcl)                       | POST /images/:uuid/acl?action=add                          | Add account UUIDs to the image ACL.                                           |
| [RemoveImageAcl](#RemoveImageAcl)                 | POST /images/:uuid/acl?action=remove                       | Remove account UUIDs from the image ACL.                                      |
| [CloneImage](#CloneImage)                         | POST /images/:uuid/clone                                   | Clone this image.                                                             |
| [AddImageIcon](#AddImageIcon)                     | POST /images/:uuid/icon                                    | Add the image icon.                                                           |
| [GetImageIcon](#GetImageIcon)                     | GET /images/:uuid/icon                                     | Get the image icon file.                                                      |
| [DeleteImageIcon](#DeleteImageIcon)               | DELETE /images/:uuid/icon                                  | Remove the image icon.                                                        |
| [CreateImageFromVm](#CreateImageFromVm)           | POST /images?action=create-from-vm                         | Create a new (activated) image from an existing VM.                           |
| [ExportImage](#ExportImage)                       | POST /images/:uuid?action=export                           | Exports an image to the specified Manta path.                                 |
| [ImportFromDatacenter](#ImportFromDatacenter)     | POST /images/$uuid?action=import-from-datacenter&datacenter=us-west-1  | Copy one's own image from another datacenter in the same cloud.   |
| [AdminImportRemoteImage](#AdminImportRemoteImage) | POST /images/$uuid?action=import-remote&source=$imgapi-url | Import an image from another IMGAPI                                           |
| [AdminImportImage](#AdminImportImage)             | POST /images/$uuid?action=import                           | Only for operators to import an image and maintain `uuid` and `published_at`. |
| [AdminGetState](#AdminGetState)                   | GET /state                                                 | Dump internal server state (for dev/debugging)                                |
| [ListChannels](#ListChannels)                     | GET /channels                                              | List image channels (if the server uses channels).                            |
| [ChannelAddImage](#ChannelAddImage)               | POST /images/:uuid?action=channel-all                      | Add an existing image to another channel.                                     |
| [Ping](#Ping)                                     | GET /ping                                                  | Ping if the server is up.                                                     |
| [AdminReloadAuthKeys](#AdminReloadAuthKeys)       | POST /authkeys/reload                                      | (Added in v2.3.0.) Tell server to reload its auth keys. This is only relevant for servers using HTTP Signature auth. |



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
| Download | 400 | There was a problem with the download. |
| StorageIsDown | 503 | Storage system is down. |
| StorageUnsupported | 503 | The storage type for the image file is unsupported. |
| RemoteSourceError | 503 | Error contacting the remote source. |
| OwnerDoesNotExist | 422 | No user exists with the UUID given in the "owner" field for image creation or import. |
| AccountDoesNotExist | 422 | No account exists with the UUID/login given. |
| NotImageOwner | 422 | The caller is not the owner of this image. |
| NotMantaPathOwner | 422 | The caller is not the owner of this Manta path. |
| OriginDoesNotExist | 422 | No image exists with the UUID given in the "origin" field for image creation or import. |
| OriginIsNotActive | 422 | An origin image of the given image exists, but is not active. |
| InsufficientServerVersion | 422 | Image creation is not supported for this VM because the host server version is not of a recent enough version. |
| ImageHasDependentImages | 422 | An error raised when attempting to delete an image which has dependent incremental images (images whose "origin" is this image). |
| NotAvailable | 501 | Functionality is not available. |
| NotImplemented | 400 | Attempt to use a feature that is not yet implemented |
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

List images. Without query params this returns all active (`state === "active"`)
images.

There are two typical calling styles to this endpoint: with 'account=$UUID' and
without. The former is what cloudapi uses to ask on behalf of a particular
authenticated account. The latter is for operator-only querying.


### Inputs

| Field                 | Type       | Required? | Notes |
| --------------------- | ---------- | --------- | ----- |
| account (query param) | UUID       | No        | Only allow access to images visible to this account. A user can see: (a) their own images, (b) activated public images, and (c) activated private images for which they are on the ACL. Note that "activated" is different than "active" (see [state](#manifest-state)). This field is only relevant for ['mode=dc'](#configuration) IMGAPI servers. |
| channel (query param) | String     | No        | The image channel to use. If not provided the server-side default channel is used. Use '*' to list in all channels. (Only relevant for servers using [channels](#channels).) |
| inclAdminFields (query param) | Bool | No      | Pass `true` to include administrative fields (e.g. `files.*.stor`) in the returned image objects. For IMGAPI servers using ['mode'](./operator-guide.md#configuration) other than `dc`, auth is required to use `admin=true`. Otherwise, `UnauthorizedError` is returned. |
| owner                 | UUID       | No        | Only list images owned by this account.                                                                                                                                                                                                                            |
| state                 | String     | No        | List images with the given state. Can be one of 'active' (the default), 'disabled', 'unactivated' or 'all'. Note that for standalone IMGAPI instances, unauthenticated requests are limited to 'active' images. |
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

| Field                 | Type   | Required? | Notes |
| --------------------- | ------ | --------- | ----- |
| account (query param) | UUID   | No        | Only allow access to images visible to this account. A user can see: (a) their own images, (b) activated public images, and (c) activated private images for which they are on the ACL. Note that "activated" is different than "active" (see [state](#manifest-state)). This field is only relevant for ['mode=dc'](#configuration) IMGAPI servers. |
| channel (query param) | String | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                 |
| inclAdminFields (query param) | Bool | No  | Pass `true` to include administrative fields (e.g. `files.*.stor`) in the returned image objects. For IMGAPI servers using ['mode'](./operator-guide.md#configuration) other than `dc`, auth is required to use `admin=true`. Otherwise, `UnauthorizedError` is returned. |

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



## GetImageFile (GET /images/:uuid/file?filepos=0)

Get the image file.

### Inputs

| Field                 | Type   | Required? | Notes                                                                                                                                                                                                                                                                |
| --------------------- | ------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| account (query param) | UUID   | No        | Only allow access to an image visible to this account. A user can only see: (a) active public images, (b) active private images for which they are on the ACL, and (c) their own images. This field is only relevant for ['mode=dc'](./operator-guide.md#configuration) IMGAPI servers. |
| channel (query param) | String | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                   |
| index (query param)   | Integer | No | The files array index to use. Defaults to index 0. |

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
| account (query param) | UUID   | No        | Only allow access to an image visible to this account. A user can only see: (a) active public images, (b) active private images for which they are on the ACL, and (c) their own images. This field is only relevant for ['mode=dc'](./operator-guide.md#configuration) IMGAPI servers. |
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
| account (query param) | UUID   | No        | Only allow deletion for images *owned* by this account. This field is only relevant for ['mode=dc'](./operator-guide.md#configuration) IMGAPI servers. |
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
| account (query param)            | UUID    | No        | Only allow deletion for images *owned* by this account. This field is only relevant for ['mode=dc'](./operator-guide.md#configuration) IMGAPI servers.          |
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
| account (query param)                                    | UUID    | Yes\*                    | The account UUID on behalf of whom this request is being made. If given and if relevant, authorization will be done for this account. At least one of `account` or `owner` is required. It is expected that all calls originating from a user (e.g. from cloudapi) will provide this parameter. This field is only relevant for ['mode=dc'](./operator-guide.md#configuration) IMGAPI servers. |
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

The following is the list of fields that the new image will inherit either
(a) from the origin image (i.e. the image used to create this VM), or
(b) from properites of the VM itself.

| Field                                                    | Type    | Notes                                                                                                                                                                                           |
| -------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [type](#manifest-type)                                   | String  | The image type. One of "zone-dataset" for a ZFS dataset used to create a new SmartOS zone, "lx-dataset" for a Lx-brand image, "lxd" for LXD image, "zvol" for a virtual machine image or "other" for image types that serve any other specific purpose. |
| [os](#manifest-os)                                       | String  | The OS family this image provides. One of "smartos", "windows", and "linux".                                                                                                                    |
| [requirements](#manifest-requirements)                   | Object  | A set of named requirements for provisioning a VM with this image. `requirements.min_platform` is set to the VM server's platform version for SmartOS VMs (where `vm.brand` is either "joyent" or "joyent-minimal"). `requirements.brand` is set to the VM's `brand` value for "lx", "kvm", and "bhyve" VMs. See [the requirements section](#manifest-requirements) above for details. |
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
| account (query param) | UUID   | No\*      | The account UUID on behalf of whom this request is being made. If given then the manta_path prefix must resolve to a location that is owned by the account. |
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


## AddImageFileFromUrl (POST /images/:uuid/file/from-url)

Almost identical to the AddImageFile PUT method, this POST method allows users
to specify a URL from which the imgapi instance should retrieve the image file.

HTTPS is the only scheme supported by this method. Note that as URLs are
typically quite long, the URL is passed in the body of the POST.

If the image already has a file, it will be overwritten. A file can only
be added to an image that has not yet been activated. The typical process
is to call this after [CreateImage](#CreateImage), and then subsequently
call [ActivateImage](#ActivateImage) to make the image available
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
| file_url (body)                | String     | Yes       | A URL to the image file. HTTPS is the only supported URL scheme, and the HTTPS server must not use self-signed certificates.                                                                                                                                                                                                                       |

### Returns

The updated image object.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool (against an SDC's IMGAPI).

    $ sdc-imgapi '/images/2d74d0fb-8402-4e10-a145-86864b14bca7/file/from-url?compression=gzip&sha1=e6a828afa242ecad289f3114e6e2856ef2404a48' -X POST \
    -d '{"file_url": "https://us-east.manta.joyent.com/timf/public/builds/assets/master-20180925T100358Z-g3f3d1b8/assets/assets-zfs-master-20180925T100358Z-g3f3d1b8.zfs.gz"}'
    HTTP/1.1 200 OK
    Etag: 824d644a739bb659b86c24316864d7f56438d696
    Content-Type: application/json
    Content-Length: 646
    Date: Mon, 01 Oct 2018 11:09:47 GMT
    Server: imgapi/4.6.0
    x-request-id: 4fc4c29f-b568-408e-8019-54f0393b9025
    x-response-time: 162167
    x-server-name: 9b76732a-a75b-4ca5-b1a5-732974733639
    Connection: keep-alive

    {
      "v": 2,
      "uuid": "2d74d0fb-8402-4e10-a145-86864b14bca7",
      "owner": "930896af-bf8c-48d4-885c-6573a94b1853",
      "name": "assets",
      "version": "master-20180925T100358Z-g3f3d1b8",
      "state": "unactivated",
      "disabled": false,
      "public": false,
      "type": "zone-dataset",
      "os": "smartos",
      "files": [
        {
          "sha1": "e6a828afa242ecad289f3114e6e2856ef2404a48",
          "size": 69223039,
          "compression": "gzip"
        }
      ],
      "description": "SDC Assets",
      "requirements": {
        "min_platform": {
          "7.0": "20180830T001556Z"
        }
      },
      "origin": "04a48d7d-6bb5-4e83-8c3b-e60a99e0f48f",
      "tags": {
        "smartdc_service": true
      }
    }

CLI tool:

    $ sdc-imgadm add-file -s e6a828afa242ecad289f3114e6e2856ef2404a48 \
        -f https://us-east.manta.joyent.com//timf/public/builds/assets/master-20180925T100358Z-g3f3d1b8/assets/assets-zfs-master-20180925T100358Z-g3f3d1b8.zfs.gz \
        2d74d0fb-8402-4e10-a145-86864b14bca7
    Added file from url "https://us-east.manta.joyent.com//timf/public/builds/assets/master-20180925T100358Z-g3f3d1b8/assets/assets-zfs-master-20180925T100358Z-g3f3d1b8.zfs.gz" (compression "auto detected") to image 2d74d0fb-8402-4e10-a145-86864b14bca7


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
| account (query param) | UUID   | No        | Only allow access to an image visible to this account. A user can only see: (a) active public images, (b) active private images for which they are on the ACL, and (c) their own images. This field is only relevant for ['mode=dc'](./operator-guide.md#configuration) IMGAPI servers. |
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
| account (query param) | UUID   | No        | Only allow access to an image visible to this account. A user can only see: (a) active public images, (b) active private images for which they are on the ACL, and (c) their own images. This field is only relevant for ['mode=dc'](./operator-guide.md#configuration) IMGAPI servers. |
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
| account (query param) | UUID   | No        | Only allow access to an image visible to this account. A user can only see: (a) active public images, (b) active private images for which they are on the ACL, and (c) their own images. This field is only relevant for ['mode=dc'](./operator-guide.md#configuration) IMGAPI servers. |
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
| account (query param)                                    | UUID    | No        | Only allow access to an image visible to this account. A user can only see: (a) active public images, (b) active private images for which they are on the ACL, and (c) their own images. This field is only relevant for ['mode=dc'](./operator-guide.md#configuration) IMGAPI servers. |
| channel (query param)                                    | String  | No        | The image channel to use. (Only relevant for servers using [channels](#channels).)                                                                                                                                                                                   |
| [description](#manifest-description)                     | String  | No        | A short description of the image.                                                                                                                                                                                                                                    |
| [homepage](#manifest-homepage)                           | URL     | No        | Homepage URL where users can find more information about the image.                                                                                                                                                                                                  |
| [eula](#manifest-eula)                                   | URL     | No        | URL of the End User License Agreement (EULA) for the image.                                                                                                                                                                                                          |
| [public](#manifest-public)                               | Boolean | false     | Indicates if this image is publicly available.                                                                                                                                                                                                                       |
| [type](#manifest-type)                                   | String  | No        | The image type. One of "zone-dataset" for a ZFS dataset used to create a new SmartOS zone, "lx-dataset" for a Lx-brand image, "lxd" for LXD image, "zvol" for a virtual machine image or "other" for image types that serve any other specific purpose. |
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


## ImportFromDatacenter (POST /images?action=import-from-datacenter&datacenter=)

Import an image and all origin images (preserving the image `uuid` and
`published_at` fields) from the provided datacenter `datacenter`.

An end user can only import an image for which they are the image owner. Images
owned by the admin (operator images) or shared images (where `account` in on
the image ACL) cannot be imported from another datacenter.

All usage of IMGAPI on behalf of end users is required to use `account=UUID`.

### Query String Inputs

| Field            | Type    | Required? | Notes |
| ---------------- | ------- | --------- | ----- |
| account          | UUID    | Yes       | The account UUID on behalf of whom this request is being made. If given and if relevant, authorization will be done for this account. It is expected that all calls originating from a user (e.g. from cloudapi) will provide this parameter. |
| datacenter       | String  | Yes       | The datacenter name that holds the source image. |

### Returns

A Job object. The location of the workflow API where the status of the job can
be polled is available in the workflow-api header of the response.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool (against an SDC's IMGAPI). This queues the copying of an existing
Image in another datacenter to be copied into this datacenter:

    $ sdc-imgapi '/images/859eb57c-d969-4962-8a87-3e5980e237ee?action=import-from-datacenter&datacenter=us-west-1' \
        -X POST --data-binary '{}'
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 236
    Date: Tue, 08 Jan 2018 20:04:01 GMT
    Server: IMGAPI/1.0.0
    workflow-api: http://workflow.coal.joyent.us
    x-request-id: ed5f60d6-a66d-4ff5-9991-935a36636c8b
    x-response-time: 236
    x-server-name: 616a4e4b-7bdd-4d6b-87cb-7a4458dc08b0
    Connection: keep-alive

    {
      "image_uuid": "859eb57c-d969-4962-8a87-3e5980e237ee",
      "job_uuid": "ddc2ec53-2dd8-4b0d-a992-0a7cafda6e8d"
    }


## CloneImage (POST /images/:uuid/clone?account=:account)

Clone this image. This endpoint is only available when IMGAPI is in 'dc' mode.

This makes a copy of the given image (including origin images). The provided
`account` param must be on the image ACL in order to clone the image, see
[AddImageAcl](#AddImageAcl). The newly-cloned image(s) will have a different
uuid to the original, the `owner` field will be set to the `account` param, and
the cloned image will have an empty ACL.

### Inputs

| Field                 | Type | Required? | Default | Notes                                                |
| --------------------- | ---- | --------- | ------- | ---------------------------------------------------- |
| account (query param) | UUID | Yes       | -       | The owner the cloned image will be assigned to.      |

### Returns

The cloned image object.

### Errors

See [Errors](#errors) section above.

### Example

Raw API tool:

    $ sdc-imgapi /images/e70502b0-705e-498e-a810-53a03980eabf/clone?account=ab0896af-bf8c-48d4-885c-6573a94b1895 -X POST
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
      "owner": "ab0896af-bf8c-48d4-885c-6573a94b1895",
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

    $ sdc-imgapi /images/01b2c898-945f-11e1-a523-af1afbe22822?action=import-remote&source=https://images.joyent.com -X POST
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
| tag     | String  | Yes*      | A Docker tag name, e.g. 'latest', in the given repository. Exactly one of 'tag' or 'digest' is required. |
| digest  | String  | Yes*      | A Docker digest, e.g. 'sha256:a3ed95caeb02ffe68cdd9fd84406680ae93d633cb16422d00e8a7c22955b46d4', in the given repository. Exactly one of 'tag' or 'digest' is required. |
| public  | Boolean | No        | Whether to make the imported image public. Default is true. |

Headers:

| Header            | Required? | Notes |
| ----------------- | --------- | ----- |
| x-registry-auth   | No        | Optional target registry auth formatted as is the 'x-registry-auth' header from the Docker docker client: a base64 encoded JSON object. See <https://github.com/docker/docker/blob/master/docs/reference/api/docker_remote_api_v1.23.md#create-an-image> |
| x-registry-config | No        | Optional target registry config formatted as is the 'x-registry-config' header from the Docker docker client: a base64 encoded JSON object. See <https://github.com/docker/docker/blob/master/docs/reference/api/docker_remote_api_v1.23.md#build-image-from-a-dockerfile> |


### Returns

A stream of messages in JSON format. These messages will be a mix of status and
action messages, some of which are used by sdc-docker and some of which are
sent back to the docker client. The messages will always have a 'type' (string)
field, which must be one the following:

* **status** - for status information regarding the pull. Example:

    {"type":"status","payload":{"status":"latest: Pulling from busybox (req f3b0c95c-461f-4ace-843b-f34cd21af3c3)"},"id":"docker.io/busybox"}

* **head** - information for which image layer is the top "head" layer. Example:

    {"type":"head","head":"bbed08f07a6bccc8aca4f6053dd1b5bdf1050f830e0989738e6532dd4a703a58","id":"docker.io/busybox"}

* **progress** - like status, but may also contain a payload.progressDetail field which shows the progress for downloading an image layer. Example:

    {"type":"progress","payload":{"id":"27144aa8f1b9","status":"Downloading","progressDetail":{"current":539527,"total":699243,"start":1497634554}},"id":"docker.io/busybox"}

* **create-docker-image** - message for sdc-docker to create an entry in the
    docker_images_v2 bucket. Example:

    {"type":"create-docker-image","config_digest":"sha256:c30178c5239f2937c21c261b0365efcda25be4921ccb95acd63beeeb78786f27", ...}

#### Error Event

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

    {"type":"status","payload":{"status":"latest: Pulling from busybox (req 7734c61d-ad6b-40f5-ac93-ecacd53e4387)"},"id":"docker.io/busybox"}
    {"type":"status","payload":{"id":"27144aa8f1b9","progressDetail":{},"status":"Pulling fs layer"},"id":"docker.io/busybox"}
    {"type":"progress","payload":{"id":"27144aa8f1b9","status":"Pulling fs layer"},"id":"docker.io/busybox"}
    {"type":"progress","payload":{"id":"27144aa8f1b9","status":"Downloading","progressDetail":{"current":539527,"total":699243,"start":1497634554}},"id":"docker.io/busybox"}
    {"type":"progress","payload":{"id":"27144aa8f1b9","status":"Download complete"},"id":"docker.io/busybox"}
    {"type":"create-docker-image","config_digest":"sha256:c30178c5239f2937c21c261b0365efcda25be4921ccb95acd63beeeb78786f27","head":true,...}
    {"type":"progress","payload":{"id":"27144aa8f1b9","status":"Activating image"},"id":"docker.io/busybox"}
    {"type":"progress","payload":{"id":"27144aa8f1b9","status":"Pull complete"},"id":"docker.io/busybox"}
    {"type":"status","payload":{"status":"Digest: sha256:be3c11fdba7cfe299214e46edc642e09514dbb9bbefcd0d3836c05a1e0cd0642"},"id":"docker.io/busybox"}
    {"type":"status","payload":{"status":"Status: Downloaded newer image for busybox:latest"},"id":"docker.io/busybox"}


## AdminChangeImageStor (POST /images/:uuid?action=change-stor&amp;stor=:newstor)

(Added in IMGAPI v2.2.0.)

Change which storage is used to store an image's file. An IMGAPI server is
[configured](./operator-guide.md#configuration) with one or more storage backends (e.g. "local"
and "manta"). This endpoint allows operators (servers in modes other
than "dc" require auth to use this endpoint), to control where image files
are stored. One use case is an operator of a "public" IMGAPI server moving
image files from local storage to manta storage for durability.

If the given image is already using the given storage this will be a no-op.


### Inputs

Query params:

| Field   | Type    | Required? | Notes |
| ------  | ------- | --------- | ----- |
| action  | String  | Yes       | "change-stor" |
| stor    | String  | Yes       | The new storage type (see "storage.*" fields in the IMGAPI server [config](./operator-guide.md#configuration)). |


### Returns

The updated image manifest object -- as would be returned by
[`GetImage?inclAdminFields=true`](#GetImage).

### Errors

See [Errors](#errors) section above.

### Example

With [imgapi-cli tools](https://github.com/joyent/imgapi-cli):

    $ updates-imgadm change-stor manta f342dcdc-e179-11e5-98a0-0f71c4796729
    Changed image f342dcdc-e179-11e5-98a0-0f71c4796729 (sapi@master-20160303T195116Z-g7fbf8d7) stor to "manta"

Raw `curl`:

    $ curl -4 --connect-timeout 10 -sS -i -H accept:application/json --url 'http://imgapi.coal.joyent.us/images/fc810fe4-e179-11e5-83e9-038750e25b16?action=change-stor&stor=manta' -X POST
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 798
    Date: Wed, 18 May 2016 21:11:58 GMT
    Server: imgapi/2.2.0
    x-request-id: 14dedfe0-1d3d-11e6-a572-6f1bdd1ba380
    x-response-time: 32356
    x-server-name: 3499c16b-c7b9-40f9-98be-b6cb8702c7bb
    Connection: keep-alive

    {
      "v": 2,
      "uuid": "fc810fe4-e179-11e5-83e9-038750e25b16",
      ...
      "os": "smartos",
      "files": [
        {
          "sha1": "f250fefb0356a4a8f3fdfb0ed318d4c0b9b6f402",
          "size": 28631145,
          "compression": "gzip",
          "stor": "manta"
        }
      ],
    }


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
configured](./operator-guide.md#configuration) set of channel names, optionally with a default
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
| version | String  | The version of the IMGAPI app.                                                      |
| imgapi  | Boolean | Always set `true`. This is to distinguish the server from the old Datasets API that IMGAPI replaced. |
| pid     | String  | The PID of IMGAPI server process. Only for "dc" mode IMGAPI configurations, or when providing auth. |
| user    | String  | Set to the authenticated username, if relevant. Note that "dc" mode servers don't use auth. |

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

## AdminReloadAuthKeys (POST /authkeys/reload)

Tells the IMGAPI server to reload its auth keys, if the server is using HTTP Signature auth
(`config.authType === "signature"`). This is an authenticated endpoint. This allows a
server administrator to add keys for users and have the server load those key changes
without having to restart.

Note that when this endpoint returns, the reload is not guaranteed to have completed.


### Inputs

None.

### Returns

An empty object: `{}`.

### Examples

    $ updates-imgadm reload-auth-keys


# Configuration

Details on IMGAPI instance configuration was moved to the [Operator
Guide](./operator-guide.md@configuration).
