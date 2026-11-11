"""Extract a single file from an Electron app.asar by path, minimal, no deps."""
import json
import struct
import sys


def read_header(f):
    # 8-byte pickle header: uint32 (4) + uint32 header-size-including-this(4)... actually:
    # asar: 4-byte uint32 = 4 (size of next field), 4-byte uint32 = header size + 8, then json
    f.seek(0)
    first = struct.unpack('<I', f.read(4))[0]
    second = struct.unpack('<I', f.read(4))[0]
    json_size = first - 4 if first > 4 else second - 8
    header = f.read(json_size)
    return json.loads(header.decode('utf-8')), 8 + json_size


def walk(node, prefix=''):
    for name, meta in node.get('files', {}).items():
        path = prefix + '/' + name
        if 'files' in meta:
            yield from walk(meta, path)
        else:
            yield path, meta


def main():
    asar, target, out = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(asar, 'rb') as f:
        header, base = read_header(f)
        entry = None
        for path, meta in walk(header):
            if path == target:
                entry = meta
                break
        if entry is None:
            print('NOT FOUND: ' + target)
            near = [p for p, _ in walk(header) if target.split('/')[-1] in p][:20]
            print('candidates:')
            for n in near:
                print('  ' + n)
            return 2
        offset = base + int(entry.get('offset', 0))
        size = int(entry.get('size', 0))
        f.seek(offset)
        data = f.read(size)
        with open(out, 'wb') as g:
            g.write(data)
        print('OK %s %d bytes' % (target, size))
    return 0


sys.exit(main())
