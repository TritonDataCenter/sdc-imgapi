#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
#
# Makefile for IMGAPI
#

#
# Vars, Tools, Files, Flags
#
NAME		:= imgapi
DOC_FILES	 = index.restdown public.restdown design.restdown search.restdown
RESTDOWN_FLAGS   = --brand-dir=deps/restdown-brand-remora
JS_FILES	:= $(shell ls *.js) \
	$(shell find lib test -name '*.js' | grep -v '/tmp/') \
	bin/imgapi-external-manta-setup \
	bin/imgapi-manta-setup \
	bin/hash-basic-auth-password
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
SMF_MANIFESTS_IN = smf/manifests/imgapi.xml.in
NODEUNIT	:= ./node_modules/.bin/nodeunit
CLEAN_FILES += ./node_modules

NODE_PREBUILT_VERSION=v0.10.26
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_TAG=zone
	# Allow building on a SmartOS image other than sdc-smartos@1.6.3.
	NODE_PREBUILT_IMAGE=fd2cc906-8938-11e3-beab-4359c665ac99
endif
IMAGES_JOYENT_COM_NODE=/root/opt/node-0.10.29
UPDATES_JOYENT_COM_NODE=/root/opt/node-0.10.29


include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	include ./tools/mk/Makefile.node.defs
endif
include ./tools/mk/Makefile.smf.defs

RELEASE_TARBALL	:= $(NAME)-pkg-$(STAMP).tar.bz2
RELSTAGEDIR       := /tmp/$(STAMP)



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
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)
	mkdir -p $(RELSTAGEDIR)/site
	touch $(RELSTAGEDIR)/site/.do-not-delete-me
	mkdir -p $(RELSTAGEDIR)/root
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
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/tools
	cp -r \
		$(TOP)/tools/seed-packages \
		$(TOP)/tools/prepare-image \
		$(TOP)/tools/get-image-dataset-guid.sh \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/tools/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(TOP)/deps/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R $(TOP)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build
	cp -r \
		$(TOP)/build/node \
		$(TOP)/build/public-docs \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build
	# Trim node
	rm -rf \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build/node/bin/npm \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build/node/lib/node_modules \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build/node/include \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build/node/share
	# Trim node_modules (this is death of a 1000 cuts, try for some
	# easy wins).
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name test | xargs -n1 rm -rf
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name tests | xargs -n1 rm -rf
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name examples | xargs -n1 rm -rf
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name "draft-*" | xargs -n1 rm -rf  # draft xml stuff in json-schema
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name libusdt | xargs -n1 rm -rf  # dtrace-provider
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name obj.target | xargs -n1 rm -rf  # dtrace-provider
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name deps | grep 'extsprintf/deps$$' | xargs -n1 rm -rf  # old extsprintf shipped dev bits
	# Tar
	(cd $(RELSTAGEDIR) && $(TAR) -jcf $(TOP)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)

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
		&& svcadm clear imgapi 2>/dev/null || svcadm restart imgapi'

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
		&& svcadm clear imgapi 2>/dev/null || svcadm restart imgapi'

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

sdc-scripts: deps/sdc-scripts/.git
