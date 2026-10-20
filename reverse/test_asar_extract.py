"""Tests for the minimal ASAR reader/writer helpers in asar_extract.py.

Run: <python> -m unittest discover -s reverse -p "test_*.py" -v
"""
import json
import os
import struct
import tempfile
import unittest

import asar_extract as ax


def build_asar(path, files):
    """Write a synthetic ASAR file. `files` maps asar-path -> bytes."""
    tree = {"files": {}}
    payloads = []
    offset = 0
    # Sort for deterministic layout.
    for name in sorted(files):
        data = files[name]
        parts = name.split("/")
        node = tree
        for part in parts[:-1]:
            node = node["files"].setdefault(part, {"files": {}})
        node["files"][parts[-1]] = {"size": len(data), "offset": str(offset)}
        payloads.append(data)
        offset += len(data)

    header_json = json.dumps(tree, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    # Chromium pickle layout used by ASAR:
    #   uint32 4 | uint32 header_size | uint32 str_pickle_size | uint32 json_len
    #   | json | padding
    # str_pickle_size = 4 (json_len field) + padded(json_len + json)
    # header_size     = 4 (str_pickle_size field) + str_pickle_size
    json_len = len(header_json)
    raw = struct.pack("<I", json_len) + header_json
    padded = raw + b"\x00" * ((4 - len(raw) % 4) % 4)
    str_pickle_size = len(padded)
    header_size = 4 + str_pickle_size
    blob = (struct.pack("<I", 4) + struct.pack("<I", header_size)
            + struct.pack("<I", str_pickle_size) + padded)
    blob += b"".join(payloads)
    with open(path, "wb") as fh:
        fh.write(blob)
    return blob


class HeaderTests(unittest.TestCase):
    def test_read_header_returns_tree_and_data_base(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "app.asar")
            pkg = b'{"main":"main.js"}'
            blob = build_asar(path, {"package.json": pkg, "main.js": b"x"})
            header, data_base = ax.read_header(path)
            self.assertEqual(header["files"]["package.json"]["size"], len(pkg))
            self.assertEqual(header["files"]["main.js"]["size"], 1)
            # data_base points at the first payload byte (payloads sorted by name:
            # "main.js" comes before "package.json").
            with open(path, "rb") as fh:
                fh.seek(data_base)
                self.assertEqual(fh.read(4), b'x{"m')
            self.assertEqual(len(blob), data_base + len(pkg) + 1)

    def test_rejects_non_asar(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bad.asar")
            with open(path, "wb") as fh:
                fh.write(b"not an asar file at all")
            with self.assertRaises(ax.AsarError):
                ax.read_header(path)


class WalkTests(unittest.TestCase):
    def test_walk_yields_all_files_and_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "app.asar")
            build_asar(path, {"a.js": b"a", "dir/b.js": b"bb", "dir/sub/c.js": b"ccc"})
            header, _ = ax.read_header(path)
            names = [p for p, _ in ax.walk(header)]
            self.assertIn("a.js", names)
            self.assertIn("dir/b.js", names)
            self.assertIn("dir/sub/c.js", names)
            entries = dict(ax.walk(header))
            self.assertTrue(entries["dir"]["files"] if "files" in entries["dir"] else True)


class ExtractTests(unittest.TestCase):
    def test_extract_writes_files_and_skips_filters(self):
        with tempfile.TemporaryDirectory() as tmp:
            asar = os.path.join(tmp, "app.asar")
            build_asar(asar, {
                "package.json": b'{"main":"main.js"}',
                "main.js": b"console.log(1)",
                "node_modules/big/index.js": b"BIG",
                "node_modules/small/index.js": b"s",
            })
            out = os.path.join(tmp, "out")
            result = ax.extract(asar, out, skip_dir_names={"node_modules"})
            with open(os.path.join(out, "package.json"), "rb") as fh:
                self.assertEqual(fh.read(), b'{"main":"main.js"}')
            with open(os.path.join(out, "main.js"), "rb") as fh:
                self.assertEqual(fh.read(), b"console.log(1)")
            self.assertFalse(os.path.exists(os.path.join(out, "node_modules")))
            self.assertEqual(result["extracted"], 2)
            self.assertEqual(result["skipped"], 2)

    def test_extract_specific_paths_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            asar = os.path.join(tmp, "app.asar")
            build_asar(asar, {"package.json": b"{}", "a/x.js": b"XX", "b/y.js": b"YY"})
            out = os.path.join(tmp, "out")
            ax.extract(asar, out, only_prefixes=["a/"])
            self.assertTrue(os.path.exists(os.path.join(out, "a", "x.js")))
            self.assertFalse(os.path.exists(os.path.join(out, "b")))

    def test_extract_refuses_zip_slip_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            asar = os.path.join(tmp, "app.asar")
            build_asar(asar, {"package.json": b"{}"})
            out = os.path.join(tmp, "out")
            # Craft a header that claims a traversal path.
            header, data_base = ax.read_header(asar)
            header["files"]["..\\evil.txt"] = {"size": 0, "offset": "0"}
            header["files"]["../../evil.txt"] = {"size": 0, "offset": "0"}
            written = ax.extract_tree(asar, header, data_base, out)
            self.assertFalse(os.path.exists(os.path.join(tmp, "evil.txt")))
            self.assertFalse(os.path.exists(os.path.join(tmp, "out", "evil.txt")))
            self.assertIn("..\\evil.txt", written["blocked"])
            self.assertIn("../../evil.txt", written["blocked"])


class ListTests(unittest.TestCase):
    def test_list_tree_marks_unpacked_and_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            asar = os.path.join(tmp, "app.asar")
            build_asar(asar, {"package.json": b"{}", "native.node": b"N"})
            header, _ = ax.read_header(asar)
            header["files"]["native.node"] = {"size": 1, "unpacked": True}
            listing = ax.list_tree(header)
            self.assertTrue(any("package.json" in line for line in listing))
            self.assertTrue(any(line.startswith("U native.node") for line in listing))


if __name__ == "__main__":
    unittest.main()
