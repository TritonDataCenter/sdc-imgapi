#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

#
# Makefile for IMGAPI
#

#
# Vars, Tools, Files, Flags
#
NAME		:= imgapi

DOC_FILES	 = index.md design.md search.md
EXTRA_DOC_DEPS += deps/restdown-brand-remora/.git
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
	NPM=npm
	NODE=node
	NPM_EXEC=$(shell which npm)
	NODE_EXEC=$(shell which node)
endif
include ./tools/mk/Makefile.smf.defs

RELEASE_TARBALL	:= $(NAME)-pkg-$(STAMP).tar.bz2
RELSTAGEDIR       := /tmp/$(STAMP)



#
# Targets
#
.PHONY: all
all: $(SMF_MANIFESTS) images.joyent.com-node-hack updates.joyent.com-node-hack docs | $(NODEUNIT) $(REPO_DEPS) sdc-scripts
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


.PHONY: test-coal
COAL=root@10.99.99.7
test-coal:
	./tools/rsync-to $(COAL)
	ssh $(COAL) "/opt/smartdc/bin/sdc-login imgapi /opt/smartdc/imgapi/test/runtests"


# We get the IMGAPI errors table from "lib/errors.js". This should be re-run
# for "lib/errors.js" changes!
.PHONY: doc-update-error-table
doc-update-error-table: lib/errors.js | node_modules/restify $(NODE_EXEC)
	$(NODE) lib/errors.js > build/errors.md
	$(NODE) -e ' \
	    fs = require("fs"); \
	    enc = {encoding: "utf8"}; \
	    index = fs.readFileSync("docs/index.md", enc); \
	    errors = fs.readFileSync("build/errors.md", enc); \
	    start = "<!-- ERROR TABLE START -->\n"; \
	    end = "<!-- ERROR TABLE END -->\n"; \
	    startIdx = index.indexOf(start); \
	    if (startIdx === -1) \
		throw new Error("cannot find start marker in build/errors.md"); \
	    endIdx = index.indexOf(end); \
	    if (endIdx === -1) \
		throw new Error("cannot find end marker in build/errors.md"); \
	    index = ( \
		index.slice(0, startIdx + start.length) \
		+ "\n" \
		+ errors \
		+ "\n" \
		+ index.slice(endIdx)); \
	    fs.writeFileSync("docs/index.md", index, enc);'
	@echo "'docs/index.md' updated"

DOC_CLEAN_FILES = docs/{index,design}.{html,json} \
	build/errors.md \
	build/docs
.PHONY: clean-docs
clean-docs:
	-$(RMTREE) $(DOC_CLEAN_FILES)
clean:: clean-docs

# See IMGAPI-445 for why this symlink.
build/docs/public/docs:
	mkdir -p build/docs/public
	(cd build/docs/public && rm -f docs && ln -s . docs)

docs:: build/docs/public/docs


.PHONY: release
release: all
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
	cp -PR \
		$(TOP)/build/node \
		$(TOP)/build/docs \
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
endif
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ

sdc-scripts: deps/sdc-scripts/.git
