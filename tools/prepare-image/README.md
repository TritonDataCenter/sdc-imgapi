# SDC image management "prepare image" scripts

These scripts are used in the ultimate call to `imgadm create -s prepare-image
...` for image creation in SDC.


# warnings in linux-prepare-image

In early days prepare-image was a manually run process. The old code base
had some code checks that would only emit warnings. Those are pointless in an
automated prepare-image process that we have now. However here are snippets of
some of that code, should it be useful for a possible `check-image` facility.


First the `cleanup_other_users`. This bails on a "joyent" user. I don't know
why that is special. The warnings on any users with passwords is reasonable
for a `check-image` future tool.

    function cleanup_other_users() {
        # looks for list of users that should not be on system
        USERLIST='joyent'
        FILELIST='passwd passwd- shadow shadow-'
        for user in $USERLIST; do
            for file in $FILELIST; do
                local passwd=$(grep "^${user}:" /etc/${file} | awk -F ':' '{print $2}')
                if [[ -n $passwd ]] ; then
                    lib_smartdc_info "$user user exist in /etc/${file}. This is a potential vulnerability"
                    lib_smartdc_fatal "Need to remove $user user."
                fi
            done

            if [[ -d "/home/$user" ]] ; then
              lib_smartdc_info "/home/$user exist. This is a potential vulnerability"
              lib_smartdc_fatal "Need to remove /home/$user."
            fi

            GROUPFILELIST='gshadow gshadow- group'
            for groupfile in $GROUPFILELIST; do
                out=$(grep $user /etc/${groupfile} || true)
                if [[ -n $out ]]; then
                   addwarn "$user user exist /etc/${groupfile}. This is a potential vulnerability and user should be removed."
                fi
            done
        done

        # check for passwords set for any other user
        local USERLIST=$(grep -E "^[[:alpha:]]+:[^\*\!\:]" /etc/shadow | awk -F ':' '{print $1}')
        for user in $USERLIST; do
          addwarn "$user user exist with password set in /etc/shadow. This is a potential vulnerability"
        done

        local USERLIST=$(grep -E "^[[:alpha:]]+:[^\*\!\:]" /etc/shadow- | awk -F ':' '{print $1}')
        for user in $USERLIST; do
          addwarn "$user user exist with password set. This is a potential vulnerability"
        done
    }


Some of the self-checks for prod release of Joyent-built images could have
these in a `check-image`:

    # Make sure debugging is off on all scripts
    for OUT in `grep -e "^DEBUG=" /lib/smartdc/*`; do
        FILENAME=`echo $OUT | cut -d ':' -f 1`
        DEBUG_LEVEL=`echo $OUT | cut -d '=' -f 2`
        if [ $DEBUG_LEVEL -gt 0 ]; then
            addwarn "Debug level is set to $DEBUG_LEVEL in $FILENAME"
        fi
    done

Some Ubuntu/Debian worthwhile checks:

    if [[ -z `which arping` ]] ; then
        addwarn "arping not found!"
        addwarn "to install arping run 'apt-get install arping'."
    fi

    local dpkgbin=$(which dpkg 2>/dev/null)
    if [[ -e ${dpkgbin} ]] ; then
        out=$($dpkgbin -l acpid | grep ^ii | wc -l)
        if [[ ${out} == "0" ]]; then
            addwarn "ACPID not found. Lifecycle management will be degraded!"
            addwarn "To install acpid run 'apt-get install acpid'."
        fi
    fi

    if [ ! -e /proc/acpi/event ] ; then
        addwarn "ACPI-support not handling in /proc, acpid handler does not exists at /proc/acpi/event"
    fi

    if [ ! -f /etc/acpi/events/powerbtn-acpi-support ] ; then
        addwarn "ACPI-support not handling power button, acpid handler does not exists at /etc/acpi/events/powerbtn-acpi-support"
    fi


    # make sure logging is enabled for acpid
    out=$(grep "^OPTIONS=" /etc/default/acpid | cut -d "=" -f2 | grep "\-\-logevents" | wc -l)
    if [[ ${out} -eq 0 ]]; then
        addwarn "ACPID logging is not enabled in /etc/default/acpid"
        addwarn "this should be enabled so that acpi events are logged"
    fi

    out=$(grep "^MODULES=" /etc/default/acpid | cut -d "=" -f2 | grep -i "all" | wc -l)
    if [[ ${out} -eq 0 ]]; then
        addwarn "ACPID all module loading not enabled in /etc/default/acpid"
        addwarn "this should be enabled to ensure that API shutdown,reboot and restart to work"
    fi

    # check for logging when API power button press happens
    if [ ! -f /etc/acpi/events/powerbtn-acpi-support ]; then
        addwarn "ACPID powerbutton pressed file not found"
        addwarn "Need to have this for API shutdown,reboot and restart to work"
    else
        out=$(grep "^action=/lib/smartdc/debian-powerbtn-acpi-support.sh$" /etc/acpi/events/powerbtn-acpi-support | wc -l)
        if [[ ${out} -eq 0 ]]; then
            addwarn "ACPID powerbutton pressed not configured for Joyent API in /etc/acpi/events/powerbtn-acpi-support"
        fi
    fi

Some CentOS checks:

    if [[ -z `which arping` ]] ; then
        addwarn "arping not found!"
        addwarn "to install arping run 'yum install iputils'."
    fi

    local rpmbin=$(which rpm 2>/dev/null)
    if [[ -e ${rpmbin} ]] ; then
        out=$($rpmbin -qa acpid)
        if [[ -z ${out} ]]; then
            addwarn "ACPID not found. Lifecycle management will be degraded!"
            addwarn "To install acpid run 'yum install acpid'."
        fi
    fi

    if [ ! -e /proc/acpi/event ] ; then
        addwarn "ACPI-support not handling in /proc, acpid handler does not exists at /proc/acpi/event"
    fi

    if [ ! -f /etc/acpi/events/powerbtn-acpi-support ] ; then
        addwarn "ACPI-support not handling power button, acpid handler does not exists at /etc/acpi/events/powerbtn-acpi-support"
    fi

    # check for logging when API power button press happens
    if [ ! -f /etc/acpi/events/powerbtn-acpi-support ]; then
        addwarn "ACPID powerbutton pressed file not found"
        addwarn "Need to have this for API shutdown,reboot and restart to work"
    else
        out=$(grep "^action=/lib/smartdc/redhat-powerbtn-acpi-support.sh$" /etc/acpi/events/powerbtn-acpi-support | wc -l)
        if [[ ${out} -eq 0 ]]; then
            addwarn "ACPID powerbutton pressed not configured for Joyent API in /etc/acpi/events/powerbtn-acpi-support"
        fi
    fi
