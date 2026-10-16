"""Read one stable native window on the configured DevTools host; never delete it."""
import hashlib
import json
import os
import re
import stat
import sys


def identity(value):
    return {'device': value.st_dev, 'inode': value.st_ino, 'size': value.st_size,
            'mtimeNs': value.st_mtime_ns, 'ctimeNs': value.st_ctime_ns}


def copy_window(request, output):
    root = os.path.realpath(request['root'])
    name, size = request['uniqueName'], request['length']
    if (not os.path.isabs(request['root']) or root == os.path.sep or not os.path.isdir(root)
            or not re.fullmatch(r'forgeax-rhi-[a-z0-9_-]{1,64}\.rhitape', name)
            or type(size) is not int or not 1 <= size <= 1024 * 1024):
        raise ValueError('expected an explicit sandbox subtree and bounded task window')
    path = request.get('path')
    if path is None:
        matches = []

        def fail(error):
            raise error

        for directory, dirs, files in os.walk(root, followlinks=False, onerror=fail):
            if name in dirs + files:
                matches.append(os.path.join(directory, name))
                if len(matches) > 1:
                    break
        if len(matches) != 1:
            raise ValueError('native filename must have exactly one match in selected subtree')
        path = matches[0]
    if (not os.path.isabs(path) or os.path.basename(path) != name
            or os.path.commonpath([root, os.path.realpath(path)]) != root):
        raise ValueError('native file escaped the selected subtree or changed name')
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_size != size:
        raise ValueError('native window must be a regular file of acknowledged length')
    checksum = hashlib.sha256()
    with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb') as stream:
        if identity(os.fstat(stream.fileno())) != identity(before):
            raise ValueError('native file changed before reading')
        remaining = size
        while remaining:
            data = stream.read(min(256 * 1024, remaining))
            if not data:
                raise ValueError('native window ended before its acknowledged length')
            output.write(data)
            checksum.update(data)
            remaining -= len(data)
        if (stream.read(1) or identity(os.fstat(stream.fileno())) != identity(before)
                or identity(os.lstat(path)) != identity(before)):
            raise ValueError('native file changed while reading')
    output.flush()
    return {'ok': True, 'path': path, 'identity': identity(before), 'length': size,
            'digest': 'sha256:' + checksum.hexdigest()}


if __name__ == '__main__':
    try:
        # stdout carries only the bounded binary window. stderr is its small,
        # separately parsed receipt; transport failures cannot masquerade as bytes.
        print(json.dumps(copy_window(json.loads(sys.argv[1]), sys.stdout.buffer)), file=sys.stderr)
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}), file=sys.stderr)
        sys.exit(1)
