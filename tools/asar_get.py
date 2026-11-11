import json
import sys

path = sys.argv[1]
target = sys.argv[2]
out = sys.argv[3]

with open(path, 'rb') as f:
    f.seek(0)
    head = f.read(16)
    header_size = int.from_bytes(head[4:8], 'little')
    # asar 的 payload 起点 = 8 + header_size（含 pickle padding），不是 16 + json 长度
    base = 8 + header_size
    f.seek(16)
    buf = f.read(4000000)

depth = 0
instr = False
esc = False
end = None
for i, ch in enumerate(buf):
    c = chr(ch)
    if instr:
        if esc:
            esc = False
        elif c == chr(92):
            esc = True
        elif c == '"':
            instr = False
        continue
    if c == '"':
        instr = True
    elif c == '{':
        depth += 1
    elif c == '}':
        depth -= 1
        if depth == 0:
            end = i + 1
            break

header = json.loads(buf[:end].decode('utf-8'))
# base 必须用「8 + header_size」：asar 头是 pickle（含 4 字节对齐 padding），
# 用 16 + json 长度会整体偏移，导出内容首尾混进脏字节（曾导致 diff 假阳性）。


def walk(node, prefix=''):
    for name, meta in node.get('files', {}).items():
        q = prefix + '/' + name
        if 'files' in meta:
            yield from walk(meta, q)
        else:
            yield q, meta


hit = None
for q, m in walk(header):
    if q == target or q == '/' + target.lstrip('/'):
        hit = m
        break
if hit is None:
    print('NOT FOUND', target)
    sys.exit(2)

with open(path, 'rb') as f:
    f.seek(base + int(hit.get('offset', 0)))
    data = f.read(int(hit.get('size', 0)))
with open(out, 'wb') as g:
    g.write(data)
print('OK', target, len(data), 'bytes')
