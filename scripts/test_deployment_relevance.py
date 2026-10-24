"""Check deployment exclusions against isolated Git histories and failures."""
import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


HELPER = Path(__file__).with_name("api-deployment-relevance.py").resolve()
SPEC = importlib.util.spec_from_file_location("api_deployment_relevance", HELPER)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DeploymentRelevanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        previous_directory = Path.cwd()
        os.chdir(self.temp.name)
        self.addCleanup(os.chdir, previous_directory)
        self.git("init", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Deployment relevance test")
        self.package = {"name": "explorer", "version": "1.0.0", "private": True,
                        "engines": {"node": ">=22.23.4 <23", "npm": ">=10"},
                        "scripts": {"build": "next build"}, "dependencies": {"next": "16.4.1"}}
        self.lock = {"name": "explorer", "lockfileVersion": 3,
                     "packages": {"": copy.deepcopy(self.package),
                                  "node_modules/next": {"version": "16.4.1", "integrity": "sha512-old"}}}
        self.write_packages()
        Path("server/api").mkdir(parents=True)
        Path("server/api/server.js").write_text("old api\n")
        Path("lib").mkdir()
        Path("lib/shared.js").write_text("old shared library\n")
        Path("app").mkdir()
        Path("app/page.tsx").write_text("old frontend\n")
        self.previous = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL, text=True).strip()

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "--allow-empty", "-m", "test snapshot")
        return self.git("rev-parse", "HEAD")

    def write_packages(self):
        Path("package.json").write_text(json.dumps(self.package, indent=2) + "\n")
        Path("package-lock.json").write_text(json.dumps(self.lock, indent=2) + "\n")

    def change_engine(self, manifest=True, lock=True):
        updated = ">=22.23.4 <23 || >=24.22.1 <25"
        if manifest:
            self.package["engines"]["node"] = updated
        if lock:
            self.lock["packages"][""]["engines"]["node"] = updated
        self.write_packages()

    def assert_deploy(self, expected):
        current = self.commit()
        actual, reason = MODULE.deployment_required(self.previous, current)
        self.assertIs(actual, expected, reason)
        return current

    def test_same_commit_skips(self):
        self.assertFalse(MODULE.deployment_required(self.previous, self.previous)[0])

    def test_frontend_and_runtime_selection_only_skip(self):
        Path("app/page.tsx").write_text("new frontend\n")
        Path(".node-version").write_text("24.22.1\n")
        Path("Dockerfile").write_text("FROM node:24.22.1-bookworm-slim\n")
        self.assert_deploy(False)

    def test_only_root_engine_changes_skip(self):
        self.change_engine()
        self.assert_deploy(False)

    def test_only_manifest_engine_change_skips(self):
        self.change_engine(lock=False)
        self.assert_deploy(False)

    def test_only_lock_root_engine_change_skips(self):
        self.change_engine(manifest=False)
        self.assert_deploy(False)

    def test_engine_change_with_key_order_and_formatting_skips(self):
        self.change_engine()
        Path("package.json").write_text(json.dumps(dict(reversed(list(self.package.items())))))
        self.assert_deploy(False)

    def test_real_dependency_change_deploys(self):
        self.change_engine()
        self.package["dependencies"]["next"] = "16.4.2"
        self.write_packages()
        self.assert_deploy(True)

    def test_lock_transitive_change_deploys(self):
        self.change_engine()
        self.lock["packages"]["node_modules/next"]["integrity"] = "sha512-new"
        self.write_packages()
        self.assert_deploy(True)

    def test_lock_nested_package_engine_change_deploys(self):
        self.change_engine()
        self.lock["packages"]["node_modules/next"]["engines"] = {"node": ">=24"}
        self.write_packages()
        self.assert_deploy(True)

    def test_other_manifest_metadata_deploys(self):
        self.change_engine()
        self.package["scripts"]["build"] = "different command"
        self.write_packages()
        self.assert_deploy(True)

    def test_other_engine_metadata_deploys(self):
        self.change_engine()
        self.package["engines"]["npm"] = ">=11"
        self.write_packages()
        self.assert_deploy(True)

    def test_json_boolean_and_integer_are_not_equal(self):
        self.change_engine()
        self.package["private"] = 1
        self.write_packages()
        self.assert_deploy(True)

    def test_formatting_without_engine_change_deploys(self):
        Path("package.json").write_text(json.dumps(self.package))
        self.assert_deploy(True)

    def test_server_change_with_engine_change_deploys(self):
        self.change_engine()
        Path("server/api/server.js").write_text("new api\n")
        self.assert_deploy(True)

    def test_shared_library_change_deploys(self):
        Path("lib/shared.js").write_text("new shared library\n")
        self.assert_deploy(True)

    def test_compares_entire_history_since_actual_deployed_commit(self):
        Path("server/api/server.js").write_text("not yet deployed api\n")
        self.commit()
        self.change_engine()
        self.assert_deploy(True)

    def test_server_rename_out_of_relevant_directory_deploys(self):
        self.git("mv", "server/api/server.js", "app/moved-api.js")
        self.assert_deploy(True)

    def test_rename_into_server_deploys(self):
        self.git("mv", "app/page.tsx", "server/api/moved-page.tsx")
        self.assert_deploy(True)

    def test_package_deletion_deploys(self):
        Path("package-lock.json").unlink()
        self.assert_deploy(True)

    def test_package_addition_deploys(self):
        Path("package-lock.json").unlink()
        self.previous = self.commit()
        self.change_engine()
        self.assert_deploy(True)

    def test_package_mode_change_deploys(self):
        self.change_engine()
        Path("package.json").chmod(0o755)
        self.assert_deploy(True)

    def test_package_symlink_deploys(self):
        Path("package.json").unlink()
        Path("package.json").symlink_to("package-lock.json")
        self.assert_deploy(True)

    def test_malformed_json_deploys(self):
        Path("package.json").write_text("{broken json")
        self.assert_deploy(True)

    def test_excessive_json_nesting_deploys(self):
        Path("package.json").write_text("[" * 2000 + "0" + "]" * 2000)
        self.assert_deploy(True)

    def test_duplicate_keys_deploy(self):
        self.change_engine()
        raw = Path("package.json").read_text()
        Path("package.json").write_text(raw.replace('"private": true', '"private": false, "private": true'))
        self.assert_deploy(True)

    def test_nonstandard_json_constant_deploys(self):
        self.change_engine()
        raw = Path("package.json").read_text()
        Path("package.json").write_text(raw.replace('"private": true', '"private": NaN'))
        self.assert_deploy(True)

    def test_overflowing_json_number_deploys(self):
        self.change_engine()
        raw = Path("package.json").read_text()
        Path("package.json").write_text(raw.replace('"private": true', '"private": 1e999'))
        self.assert_deploy(True)

    def test_missing_engine_deploys(self):
        del self.package["engines"]["node"]
        self.write_packages()
        self.assert_deploy(True)

    def test_missing_previous_commit_deploys(self):
        self.assertTrue(MODULE.deployment_required("f" * 40, self.previous)[0])

    def test_invalid_commit_input_deploys(self):
        self.assertTrue(MODULE.deployment_required("--all", self.previous)[0])

    def test_git_diff_failure_deploys(self):
        actual_git = MODULE.git

        def fail_diff(*args):
            if args[0] == "diff":
                raise subprocess.CalledProcessError(128, ["git", *args])
            return actual_git(*args)

        current = self.commit()
        with mock.patch.object(MODULE, "git", side_effect=fail_diff):
            self.assertTrue(MODULE.deployment_required(self.previous, current)[0])

    def test_cli_emits_only_a_github_boolean_output(self):
        self.change_engine()
        current = self.commit()
        result = subprocess.run(
            [sys.executable, str(HELPER), "--previous", self.previous, "--current", current],
            capture_output=True, text=True, check=True,
        )
        self.assertEqual(result.stdout, "deploy=false\n")
        self.assertIn("Only root engines.node", result.stderr)


if __name__ == "__main__":
    unittest.main()
