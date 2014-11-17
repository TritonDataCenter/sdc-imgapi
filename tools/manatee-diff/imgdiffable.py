#!/usr/bin/env python

"""
Take a JSON file of IMGAPI image manifests and emit a more diffable output by
prefixing each line with the `uuid`.
"""

import json
import sys
import operator
from pprint import pprint
import codecs

if len(sys.argv) == 1:
    imgs = json.load(sys.stdin)
else:
    infile = sys.argv[1]
    fin = codecs.open(infile, 'r', 'utf8')
    try:
        imgs = json.load(fin)
    finally:
        fin.close()

imgs.sort(key=operator.itemgetter('uuid'))

for i, img in enumerate(imgs):
    if i:
        print
    uuid = img['uuid']
    lines = json.dumps(img, sort_keys=True, indent=4).splitlines(False)
    for i in range(len(lines)):
        lines[i] = " %s %s" % (uuid, lines[i])
    print '\n'.join(lines)
