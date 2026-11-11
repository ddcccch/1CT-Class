import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else '1CT/resources/app.asar'
matches = sys.argv[2:] if len(sys.argv) > 2 else ['automation', 'bootstrap', 'shell.js', 'members.js']

with open(path, 'rb') as f:
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

print('json_size', end, 'base', 16 + end)
header = json.loads(buf[:end].decode('utf-8'))


def walk(node, prefix=''):
    for name, meta in node.get('files', {}).items():
        q = prefix + '/' + name
        if 'files' in meta:
            yield from walk(meta, q)
        else:
            yield q, meta


paths = list(walk(header))
print('total files', len(paths))
for q, m in paths:
    if any(k in q for k in matches):
        print(q, m.get('size'), m.get('offset'))
