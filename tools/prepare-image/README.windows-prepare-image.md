Due to TOOLS-2126, the upper limit on the number of bytes that can be retrieved
by mdata-get -- used to pull the prepare script into the VM for execution --
is 3000 bytes.

In order to reduce windows-prepare-image below 3000 bytes, the header comment
is moved here until TOOLS-2126 is fixed:

# Set Window's cleanmgr to (nearly) max, and run it. This cleans up most
# temporary (files, cache) and unneeded data (outdated installation data).
#
# In order for this script to work, a Windows image needs to have mdata-get.exe,
# mdata-put.exe and prepare_image_runner.ps1 installed in C:\smartdc\bin, and
# prepare_image_runner.ps1 should be run by Windows on every boot. Upon boot,
# prepare_image_runner.ps1 will then check if "sdc:operator-script" metadata
# (seen as internal_metadata."operator-script" in "vmadm get" output) is present
# over COM2, and run it. If it's not present, booting continues as normal.
#
# Apparently, the only way to get cleanmgr to run without displaying a final
# information dialog -- thus hanging image creation -- is through the /autoclean
# flag. We abuse this by setting all available cleanup options in the registry
# to be run by autoclean. Since the VM will be rolled back after image creation,
# this change is not a problem.
#
# There are also a couple very expensive cleanmgr checks that increase
# cleanmgr's run time up to 5x, which we cannot afford with the 5m time limit
# imposed on image creation between prepare-script 'running' and
# final 'error'/'success' calls. The only way to disable these checks outright
# is to temporarily move their registry keys, which we do as well.
#
# After that, cleanmgr is run, then moving the expensive registry keys back.
#
# Unfortunately, cleanmgr /autoclean appears to contain its own logic about when
# it will clean up something. As a result, we also empty recycle bins and clear
# most temp and log directories manually.

