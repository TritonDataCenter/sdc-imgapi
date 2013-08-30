#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
#
# Makefile for IMGAPI
#

#
# Vars, Tools, Files, Flags
#
NAME		:= imgapi
DOC_FILES	 = index.restdown public.restdown design.restdown
JS_FILES	:= $(shell ls *.js) \
	$(shell find lib test -name '*.js' | grep -v '/tmp/') \
	bin/imgapi-local-manta-setup \
	bin/imgapi-remote-manta-setup \
	bin/hash-basic-auth-password
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
SMF_MANIFESTS_IN = smf/manifests/imgapi.xml.in
NODEUNIT	:= ./node_modules/.bin/nodeunit
CLEAN_FILES += ./node_modules

NODE_PREBUILT_VERSION=v0.8.25
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_CC_VERSION=4.6.2
	NODE_PREBUILT_TAG=zone
endif
IMAGES_JOYENT_COM_NODE=/root/opt/node-0.8.25
UPDATES_JOYENT_COM_NODE=/root/opt/node-0.8.25


include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	include ./tools/mk/Makefile.node.defs
endif
include ./tools/mk/Makefile.smf.defs

RELEASE_TARBALL	:= $(NAME)-pkg-$(STAMP).tar.bz2
RELTMPDIR       := /tmp/$(STAMP)



#
# Targets
#
.PHONY: all
all: $(SMF_MANIFESTS) images.joyent.com-node-hack updates.joyent.com-node-hack public-docs | $(NODEUNIT) $(REPO_DEPS) sdc-scripts
	$(NPM) install

# Node hack for images.joyent.com and updates.joyent.com
#
# Fake out 'Makefile.node_prebuilt.*' by symlinking build/node
# to the node we want to use. We can't use sdcnode here because
# of GCC mismatch with current sdcnode builds.
.PHONY: images.joyent.com-node-hack
images.joyent.com-node-hack:
	if [[ -f "$(HOME)/THIS-IS-IMAGES.JOYENT.COM.txt" ]]; then \
		if [[ ! -d "$(TOP)/build/node" ]]; then \
			mkdir -p $(TOP)/build; \
			(cd $(TOP)/build && ln -s $(IMAGES_JOYENT_COM_NODE) node); \
			touch $(NODE_EXEC); \
			touch $(NPM_EXEC); \
		fi; \
	fi
.PHONY: updates.joyent.com-node-hack
updates.joyent.com-node-hack:
	if [[ -f "$(HOME)/THIS-IS-UPDATES.JOYENT.COM.txt" ]]; then \
		if [[ ! -d "$(TOP)/build/node" ]]; then \
			mkdir -p $(TOP)/build; \
			(cd $(TOP)/build && ln -s $(UPDATES_JOYENT_COM_NODE) node); \
			touch $(NODE_EXEC); \
			touch $(NPM_EXEC); \
		fi; \
	fi

$(NODEUNIT) node_modules/restify: | $(NPM_EXEC)
	$(NPM) install

.PHONY: test test-kvm7 test-images.joyent.com
test: | $(NODEUNIT)
	./test/runtests -lp  # test local 'public' mode
	./test/runtests -l   # test local 'dc' mode
test-kvm7: | $(NODEUNIT)
	./tools/rsync-to-kvm7
	./tools/runtests-on-kvm7
test-images.joyent.com: | $(NODEUNIT)
	./test/runtests -p -r default


# Doc preprocessing to get public and private IMGAPI docs out of the same
# docs/index.restdown.in.
build/errors.restdown: lib/errors.js | node_modules/restify $(NODE_EXEC)
	$(NODE) lib/errors.js > $@
docs/index.restdown: docs/index.restdown.in build/errors.restdown
	python tools/preprocess.py -o $@ -I. -D PRIVATE=1 $<
docs/public.restdown: docs/index.restdown.in build/errors.restdown
	python tools/preprocess.py -o $@ -I. $<

build/public/docs/index.html: build/docs/public/public.html
	$(MKDIR) build/public/docs
	$(CP) $< $@

.PHONY: public-docs
public-docs: docs
	$(RM) -r build/public-docs/docs
	$(MKDIR) build/public-docs/docs
	$(CP) $(DOC_BUILD)/public.html build/public-docs/docs/public.html
	$(CP) -PR $(DOC_BUILD)/media build/public-docs/docs/media

DOC_CLEAN_FILES = docs/{index,design,public}.{html,json} \
	docs/index.restdown \
	docs/public.restdown \
	build/errors.restdown \
	build/docs \
	build/public-docs
.PHONY: clean-docs
clean-docs:
	-$(RMTREE) $(DOC_CLEAN_FILES)
clean:: clean-docs


.PHONY: release
release: all public-docs
	@echo "Building $(RELEASE_TARBALL)"
	mkdir -p $(RELTMPDIR)/root/opt/smartdc/$(NAME)
	mkdir -p $(RELTMPDIR)/site
	touch $(RELTMPDIR)/site/.do-not-delete-me
	mkdir -p $(RELTMPDIR)/root
	cp -r \
		$(TOP)/bin \
		$(TOP)/main.js \
		$(TOP)/lib \
		$(TOP)/etc \
		$(TOP)/node_modules \
		$(TOP)/package.json \
		$(TOP)/sapi_manifests \
		$(TOP)/smf \
		$(TOP)/test \
		$(RELTMPDIR)/root/opt/smartdc/$(NAME)
	mkdir -p $(RELTMPDIR)/root/opt/smartdc/$(NAME)/tools
	cp -r \
		$(TOP)/tools/seed-packages \
		$(RELTMPDIR)/root/opt/smartdc/$(NAME)/tools/
	mkdir -p $(RELTMPDIR)/root/opt/smartdc/sdc-boot/scripts
	cp $(TOP)/sdc-boot/*.sh \
	    $(RELTMPDIR)/root/opt/smartdc/sdc-boot/
	cp $(TOP)/deps/sdc-scripts/*.sh \
	    $(RELTMPDIR)/root/opt/smartdc/sdc-boot/scripts/
	mkdir -p $(RELTMPDIR)/root/opt/smartdc/$(NAME)/build
	cp -r \
		$(TOP)/build/node \
		$(TOP)/build/public-docs \
		$(RELTMPDIR)/root/opt/smartdc/$(NAME)/build
	(cd $(RELTMPDIR) && $(TAR) -jcf $(TOP)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELTMPDIR)

.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
		@echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/$(NAME)
	cp $(TOP)/$(RELEASE_TARBALL) $(BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)

.PHONY: deploy-images.joyent.com
deploy-images.joyent.com:
	@echo '# Deploy to images.joyent.com. This is a *production* server.'
	@echo '# Press <Enter> to continue, <Ctrl+C> to cancel.'
	@read
	ssh root@images.joyent.com ' \
		set -x \
		&& export PATH=$(IMAGES_JOYENT_COM_NODE)/bin:$$PATH \
		&& which node && node --version && npm --version \
		&& test ! -d /root/services/imgapi.deploying \
		&& cd /root/services \
		&& cp -PR imgapi imgapi.deploying \
		&& cd /root/services/imgapi.deploying \
		&& git fetch origin \
		&& git pull --rebase origin master \
		&& git submodule update --init \
		&& PATH=/opt/local/gnu/bin:$$PATH make distclean all \
		&& mv /root/services/imgapi /root/services/imgapi.`date "+%Y%m%dT%H%M%SZ"` \
		&& mv /root/services/imgapi.deploying /root/services/imgapi \
		&& svcadm clear imgapi 2>/dev/null || svcadm restart imgapi \
		&& tail -f `svcs -L imgapi` | bunyan -o short'

.PHONY: deploy-updates.joyent.com
deploy-updates.joyent.com:
	@echo '# Deploy to updates.joyent.com. This is a *production* server.'
	@echo '# Press <Enter> to continue, <Ctrl+C> to cancel.'
	@read
	ssh root@updates.joyent.com ' \
		set -x \
		&& export PATH=$(UPDATES_JOYENT_COM_NODE)/bin:$$PATH \
		&& test ! -d /root/services/imgapi.deploying \
		&& cd /root/services \
		&& cp -PR imgapi imgapi.deploying \
		&& cd /root/services/imgapi.deploying \
		&& git fetch origin \
		&& git pull --rebase origin master \
		&& git submodule update --init \
		&& PATH=/opt/local/gnu/bin:$$PATH make distclean all \
		&& mv /root/services/imgapi /root/services/imgapi.`date "+%Y%m%dT%H%M%SZ"` \
		&& mv /root/services/imgapi.deploying /root/services/imgapi \
		&& svcadm clear imgapi 2>/dev/null || svcadm restart imgapi \
		&& tail -f `svcs -L imgapi` | bunyan -o short'

.PHONY: devrun
devrun:
	node-dev main.js -f etc/imgapi.config.json | bunyan -o short

.PHONY: dumpvar
dumpvar:
	@if [[ -z "$(VAR)" ]]; then \
		echo "error: set 'VAR' to dump a var"; \
		exit 1; \
	fi
	@echo "$(VAR) is '$($(VAR))'"

include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
else
	include ./tools/mk/Makefile.node.targ
endif
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ
