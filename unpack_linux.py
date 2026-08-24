# -*- coding: utf-8 -*-
"""Locate linux-6.12.tar.xz, print real dir name codepoints, then unpack into it.
No deletion is performed - existing files are simply overwritten.
"""
import os
import tarfile

root = "E:\\"
found = None
for name in os.listdir(root):
    p = os.path.join(root, name)
    if os.path.isdir(p):
        try:
            entries = os.listdir(p)
        except OSError:
            continue
        if "linux-6.12.tar.xz" in entries:
            found = p
            print("FOUND tar.xz in:", repr(p))
            print("dir name codepoints:", [hex(ord(c)) for c in name])
            break

if not found:
    print("NOT FOUND anywhere in E:\\ root dirs")
    raise SystemExit(1)

# Rename the corrupted dir name to the proper Chinese name if needed
proper = os.path.join(root, "\u6e90\u7801")  # E:\源码
if os.path.normcase(found) != os.path.normcase(proper) and not os.path.exists(proper):
    print("Renaming:", repr(found), "->", repr(proper))
    os.rename(found, proper)
    found = proper

src = os.path.join(found, "linux-6.12.tar.xz")
target = os.path.join(found, "linux-6.12")
print("src size:", os.path.getsize(src))
print("target dir exists:", os.path.exists(target))

print("Extracting...")
with tarfile.open(src, "r:xz") as tf:
    try:
        tf.extractall(found, filter="data")
    except TypeError:
        tf.extractall(found)

count = sum(len(files) for _, _, files in os.walk(target))
print("Extracted file count:", count)
print("DONE")
