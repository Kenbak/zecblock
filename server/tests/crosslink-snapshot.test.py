"""Exercise recovery snapshot failures without touching systemd or real state."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import sys
import tarfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/crosslink-snapshot.sh'


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.cache = self.root / 'zebra_crosslink_workshop_test'
        (self.cache / 'state').mkdir(parents=True)
        (self.cache / 'state/block').write_text('block')
        (self.cache / 'pos.chain').write_text('paired certificates')
        self.config = self.root / 'config.toml'
        self.config.write_text(f'[state]\ncache_dir = "{self.cache}"\n')
        self.env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                        SNAPSHOT_DIR=str(self.root / 'snapshots'), CONFIG=str(self.config),
                        LOCK_FILE=str(self.root / 'lock'), TEST_ROOT=str(self.root))
        self.fake('curl', 'case "$*" in *getblockcount*) echo \'{"result":100}\';; *) echo \'{"result":{"height":99}}\';; esac')
        self.fake('df', 'printf "Avail\\n999999999999\\n"')
        self.fake('systemctl', '''case "$1" in
is-active) test ! -f "$TEST_ROOT/stopped";;
stop) touch "$TEST_ROOT/stopped"; echo stop >> "$TEST_ROOT/actions";;
start) rm -f "$TEST_ROOT/stopped"; echo start >> "$TEST_ROOT/actions";;
esac''')
        # macOS cp/du differ from the Linux production utilities; mock just
        # these interfaces while still copying the complete fixture tree.
        self.fake('du', 'printf "1000\\tfixture\\n"')
        self.fake('cp', 'python3 -c \'import shutil,sys,pathlib; shutil.copytree(sys.argv[1], pathlib.Path(sys.argv[2])/pathlib.Path(sys.argv[1]).name)\' "$3" "$4"')
        # macOS lacks flock. Tests run sequentially; production uses real flock.
        if not shutil.which('flock'):
            self.fake('flock', 'exit 0')

    def fake(self, name, body):
        p = self.bin / name
        p.write_text('#!/bin/bash\n' + body + '\n')
        p.chmod(0o755)

    def run_script(self):
        return subprocess.run(['bash', str(SCRIPT)], env=self.env, capture_output=True, text=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_archive_failure_removes_partial_and_resumes_node(self):
        self.fake('tar', 'touch "$4"; exit 2')
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual((self.root / 'actions').read_text(), 'stop\nstart\n')
        self.assertFalse((self.root / 'stopped').exists())
        self.assertEqual(list((self.root / 'snapshots').iterdir()), [])

    def test_copy_failure_resumes_node(self):
        self.fake('cp', 'exit 2')
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual((self.root / 'actions').read_text(), 'stop\nstart\n')
        self.assertEqual(list((self.root / 'snapshots').iterdir()), [])

    def test_low_disk_does_not_stop_node(self):
        self.fake('df', 'printf "Avail\\n0\\n"')
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertFalse((self.root / 'actions').exists())

    def test_base_cache_resolves_the_single_network_directory(self):
        self.config.write_text(f'[state]\ncache_dir = "{self.root}"\n')
        self.fake('tar', 'exit 2')
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual((self.root / 'actions').read_text(), 'stop\nstart\n')

    def test_ambiguous_network_directories_do_not_stop_node(self):
        self.config.write_text(f'[state]\ncache_dir = "{self.root}"\n')
        (self.root / 'zebra_crosslink_workshop_other').mkdir()
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertFalse((self.root / 'actions').exists())

    def test_finality_ahead_of_tip_is_rejected(self):
        self.fake('curl', 'case "$*" in *getblockcount*) echo \'{"result":100}\';; *) echo \'{"result":{"height":101}}\';; esac')
        self.assertEqual(self.run_script().returncode, 0)
        self.assertFalse((self.root / 'actions').exists())

    def test_v14_pow_snapshot_checks_genesis_before_stopping_node(self):
        self.env.update(CROSSLINK_ACTIVATION_HEIGHT='36288', CROSSLINK_GENESIS_HASH='expected')
        self.fake('curl', 'case "$*" in *getblockcount*) echo \'{"result":100}\';; *) echo \'{"result":"wrong"}\';; esac')
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertFalse((self.root / 'actions').exists())

    def test_v14_pow_snapshot_accepts_new_cache_without_certificates(self):
        new_cache = self.root / 'crosslink_featurenet_20260929_staking3d'
        self.cache.rename(new_cache)
        self.cache = new_cache
        (new_cache / 'pos.chain').unlink()
        self.config.write_text(f'[state]\ncache_dir = "{self.root}"\n')
        self.env.update(CROSSLINK_ACTIVATION_HEIGHT='36288', CROSSLINK_GENESIS_HASH='expected')
        self.fake('curl', 'case "$*" in *getblockcount*) echo \'{"result":100}\';; *) echo \'{"result":"expected"}\';; esac')
        self.fake('tar', 'exit 2')
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertEqual((self.root / 'actions').read_text(), 'stop\nstart\n')

    @unittest.skipUnless(sys.platform.startswith('linux'), 'production GNU find required')
    def test_success_preserves_paired_state_and_cleans_staging(self):
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        archives = list((self.root / 'snapshots').iterdir())
        self.assertEqual(len(archives), 1)
        self.assertTrue(archives[0].name.endswith('.tar.gz'))
        with tarfile.open(archives[0]) as archive:
            self.assertEqual(archive.extractfile(self.cache.name + '/pos.chain').read(), b'paired certificates')
            self.assertEqual(archive.extractfile(self.cache.name + '/state/block').read(), b'block')
        self.assertEqual((self.root / 'actions').read_text(), 'stop\nstart\n')


if __name__ == '__main__':
    unittest.main()
