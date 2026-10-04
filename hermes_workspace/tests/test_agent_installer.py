import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('agent_installer', Path(__file__).parents[1] / 'apps/hermes-chat-windows/install_agent.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / 'package'
        self.target = Path(self.tmp.name) / 'hermes-home'
        self.source.mkdir()
        (self.source / 'agent.json').write_text(json.dumps({'Schema': 1}))
        (self.source / 'SOUL.md').write_text('Agent instructions')
        (self.source / '.env.example').write_text('API_KEY=\n')
        (self.source / '.env').write_text('API_KEY=new\nNEW_KEY=value\n')
        skill = self.source / 'skills/example'
        skill.mkdir(parents=True)
        (skill / 'SKILL.md').write_text('skill')
        (skill / 'run.py').write_text('raise RuntimeError("must never execute")')

    def test_default_omits_secrets_and_does_not_execute(self):
        installer.install(self.source, self.target)
        self.assertFalse((self.target / '.env').exists())
        self.assertTrue((self.target / 'skills/example/run.py').exists())

    def test_env_merge_preserves_values_and_backs_up(self):
        self.target.mkdir()
        (self.target / '.env').write_text('API_KEY=keep\n')
        installer.install(self.source, self.target, True)
        self.assertIn('API_KEY=keep', (self.target / '.env').read_text())
        self.assertIn('NEW_KEY=value', (self.target / '.env').read_text())
        self.assertTrue(list((self.target / '.workspace-backups').rglob('.env')))

    def test_rejects_symlink_write(self):
        outside = Path(self.tmp.name) / 'outside'
        outside.mkdir()
        self.target.mkdir()
        (self.target / 'skills').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            installer.install(self.source, self.target)
        self.assertFalse((self.target / 'SOUL.md').exists())

    def test_rejects_overlapping_target(self):
        with self.assertRaises(ValueError):
            installer.install(self.source, self.source / 'destination')


if __name__ == '__main__':
    unittest.main()
