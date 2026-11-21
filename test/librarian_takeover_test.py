"""Run with python test/librarian_takeover_test.py, optionally passing an installed CLI."""
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


CLI = Path(__file__).resolve().parents[1] / "skills/webgal-librarian/scripts/library.py"


class TakeoverTest(unittest.TestCase):
    def call(self, command, root, *args, success=True):
        result = subprocess.run(
            [sys.executable, "-X", "utf8", str(CLI), command, str(root), *args],
            capture_output=True, encoding="utf-8",
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("目录", result.stderr)

    def test_first_scan_requires_a_layout_choice(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            media = root / "散放.mp3"
            media.write_bytes(b"fixture")
            for command in ("scan", "init"):
                with self.subTest(command=command):
                    self.call(command, root, success=False)
                    self.assertEqual(list(root.iterdir()), [media])
            self.assertEqual(self.call("scan", root, "--layout-confirmed")["新增"], 1)
            self.call("tag", root, media.name, "告别")
            self.assertEqual(self.call("scan", root)["新增"], 0)
            row, = self.call("candidates", root)
            self.assertEqual((row["路径"], row["标签"]), (media.name, "告别"))
            self.assertEqual(media.read_bytes(), b"fixture")

    def test_new_empty_library(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "new"
            self.assertEqual(self.call("init", root)["现存"], 0)
            self.assertTrue((root / "INDEX.md").is_file())


if __name__ == "__main__":
    if len(sys.argv) == 2:
        CLI = Path(sys.argv.pop())
    unittest.main()
