#!/usr/bin/env python3
"""Crop a band out of a full-page shot, so details can actually be looked at.
   usage: crop.py <png> <y0> <y1> [out]"""
import sys
from PIL import Image
src, y0, y1 = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
out = sys.argv[4] if len(sys.argv) > 4 else '/tmp/crop.png'
im = Image.open(src)
im.crop((0, y0, im.width, min(y1, im.height))).save(out)
print(out, im.size)
