#!/usr/bin/env python3
"""Inert ops regression: AST-load reviewed validator definitions, never helper mains.

No deployment, installer, application, native import, child process or network.
Temporary fixtures are synthetic and contain no credentials.
"""
import ast
import hashlib
from pathlib import Path
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]


def definitions(filename):
    path = ROOT / 'deploy/tools' / filename
    tree = ast.parse(path.read_text(), filename=str(path))
    # Imports/constants and definitions only; exclude all helper main/control flow.
    tree.body = [node for node in tree.body if isinstance(
        node, (ast.Import, ast.ImportFrom, ast.Assign, ast.FunctionDef))]
    module = types.ModuleType(filename)
    module.__file__ = str(path)
    exec(compile(tree, str(path), 'exec'), module.__dict__)
    return module


class ArtifactTests(unittest.TestCase):
    def test_writable_file_cannot_pass_reviewed_immutable_inventory(self):
        api = definitions('package27-deploy-artifacts.py')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'file').write_bytes(b'abc')
            (root / 'file').chmod(0o644)
            rows = [{'path': 'file', 'sha256':
                     'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
                     'mode': '0444'}]
            with self.assertRaises(ValueError):
                api.verify_tree(root, api.file_map(rows))


if __name__ == '__main__':
    unittest.main(verbosity=2)
