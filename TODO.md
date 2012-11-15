
# overview

- implement basic endpoints:
    - change ?user=UUID to ?account=UUID ??? to avoid confusion with 'users' field?
      Yes. Having 'users' and 'user' in play in images.js is too confusing.
        sdc-imgapi /images?account=$uuid    <--- this one
        sdc-imgapi /images?co=$uuid
        sdc-imgapi /images?onbehalfof=$uuid
        sdc-imgapi /images?who=$uuid
    - amon for log.fatal|error|warn in imgapi
    - ListImages: cache invalidation testing
    - TICKET for 6.5 compat: add provisioner for 6.5 ability to take
      a "dataset_url" field from which to install a dataset. This instead
      of "dataset_name". Then CNAPI should send dataset_uuid and dataset_url
      to 6.5 CNs' provisioner.
            Incoming message was:
            { max_lwps: 4000,
              ram_in_bytes: 4294967296,
              hostname: '69da8ace-5b5b-4730-8ae8-65a48eabb18e',
              virtualmin_pw: 'Tc,X+Ey}8G',
              disk_in_gigabytes: 120,
              _deliveryTag: 1,
              lightweight_processes: 4000,
              tmpfs: '4096',
              cpu_cap: 400,
              dataset_uuid: 'fcc5996a-1d34-11e1-899e-7bd98b87947a',
              admin_pw: 'LuEd_bN<Dp',
              inherited_directories: null,
              jill_pw: 'tNaB?VyD#j',
              client_id: 'mapi-task-agent',
              resolvers: [ '4.2.2.2', '216.52.1.1', [length]: 2 ],
              zfs_io_priority: 40,
              teardown_on_failure: true,
              nics:
               [ { ip: '165.225.128.10',
                   nic: 'external',
                   mac: '90:b8:d0:1f:4c:d9',
                   netmask: '255.255.254.0',
                   vlan_id: 1102,
                   nic_tag: 'external',
                   gateway: '165.225.128.1',
                   interface: 'net0' },
                 { ip: '10.112.0.10',
                   nic: 'internal',
                   mac: '90:b8:d0:56:50:c1',
                   netmask: '255.255.248.0',
                   vlan_id: 1301,
                   nic_tag: 'internal',
                   gateway: '10.112.0.1',
                   interface: 'net1' },
                 [length]: 2 ],
              root_pw: 'kwAY}kx*D3',
              uuid: '69da8ace-5b5b-4730-8ae8-65a48eabb18e',
              mysql_pw: '~BdG#+EHvb',
              task_id: 'e6b92f7c-d049-42d3-b5bb-6391a49ab75d',
              max_swap: 8192,
              customer_metadata:
               { mysql_pw: '~BdG#+EHvb',
                 root_pw: 'kwAY}kx*D3',
                 jill_pw: 'tNaB?VyD#j',
                 admin_pw: 'LuEd_bN<Dp',
                 pgsql_pw: 'Kv;QWybRgr',
                 virtualmin_pw: 'Tc,X+Ey}8G' },
              dataset_url_path: 'smartosplus-3.0.7.zfs.bz2',
              package_version: '1.0.0',
              _routingKey: 'provisioner-v2.44454c4c-5a00-1051-8036-b2c04f485331.task.machine_create',
              owner_uuid: '867485d8-e010-4bab-ba20-a684d82b7938',
              quota: 120,
              zonename: '69da8ace-5b5b-4730-8ae8-65a48eabb18e',
              brand: 'joyent',
              cpu_shares: 4096,
              template_version: '[VERSION]',
              swap_in_bytes: 8589934592,
              default_gateway: '165.225.128.1',
              zfs_storage_pool_name: 'zones',
              max_physical_memory: 4096,
              pgsql_pw: 'Kv;QWybRgr',
              zone_template: 'smartosplus-3.0.7',
              package_name: 'Medium 4GB' }
- get headnode.sh starter images into IMGAPI
- get storage (local and manta) working
- Fill out each of the use cases in index.restdown. Do those use cases cover
  all of UpdateImage, DisableImage, EnableImage, MigrateImage, AdminImportImage?
  Tickets for each.
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
- error restdown table generation (TOOLS-204)
- error response audit log body fix (restify#225)
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
