#!/usr/bin/env python

"""
Take a imgapi_images-*.gz manatee table dump and emit a JSON array of images.

Usage:

    gzcat imgapi_images-2014-11-15-00-01-56.gz | ./manatee2images.py > images.json
"""

import json
import sys
import operator
from pprint import pprint
import codecs


# TODO: ideally we wouldn't hardcode types here. This should come from
# the imgapi_images bucket definition.
type_from_key = {
    'billing_tags': 'array',
    'published_at': 'string',
    'acl': 'array',
    'public': 'bool',
}


def update_img_from_index(img, entry, header, key):
    try:
        type = type_from_key[key]
        idx = header.index(key)   # cache this?
        val = entry[idx]

        # Postgres NULL
        if val == '\\N':
            if key in img:
                del img[key]
            return

        if type == 'array' and val.startswith('{') and val.endswith('}'):
            # Hack parsing of postgres arrays.
            val = [tag for tag in val[1:-1].split(',') if tag]
        elif type == 'bool':
            if val == 't':
                val = True
            elif val == 'f':
                val = False
            else:
                raise RuntimeError(
                    'unexpected index value for "%s" bool field: %r'
                    % (key, val))
        img[key] = val
    except ValueError:
        pass


header = None
published_at_idx = None
acl_idx = None
imgs = []
for line in sys.stdin:
    if header is None:
        header = json.loads(line)['keys']
        assert header[3] == '_value'
        continue

    entry = json.loads(line)['entry']
    img = json.loads(entry[3])

    # Apply some of the index values.
    # TODO: eventually should do all of these
    for key in ['billing_tags', 'published_at', 'acl', 'public']:
        update_img_from_index(img, entry, header, key)

    imgs.append(img)

imgs.sort(key=operator.itemgetter('uuid'))
print json.dumps(imgs, sort_keys=True, indent=4)
