
# channels

Process: Add tests to channels.public-test.js. Test with 'runtests -lp'.

- check that image import from channel-IMGAPI (local test first) still works
  (i.e. extra 'channels' field doesn't break things): nope -> IMGAPI versioning
    - test cases on api-versions: new api-versions.test.js
    - black book items
- hack migration to add 'dev' channel to current set of images on updates.jo
- update_channel in prompt-config.sh, SAPI 'sdc' app metadata,
  updates-imgadm.config.json manifest and updates-imgadm using that,
  sdcadm using that config var for channel. `sdcadm channel` command to list,
  show and set channel. Nightly switch to 'dev' channel.
- channel features like disallowing (name,version) repeats
- client work?
