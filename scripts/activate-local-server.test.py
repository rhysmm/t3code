"""Exercise the explicit shared-server restart against synthetic release files."""

from contextlib import closing
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "activate_local_server", Path(__file__).with_name("activate-local-server.py")
)
activation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(activation)


class LocalServerRestart(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name).resolve()
        self.root = self.home / ".local/share/t3code-local"
        self.release = self.root / "release"
        self.release.mkdir(parents=True)
        self.manifest = self.release / "verified-server.json"
        self.commit = "a" * 40
        self.old = "0.1.12+local.bbbbbbbb"
        self.target = "0.1.13+local.aaaaaaaa"
        self.base = self.home / ".t3"
        self.versions = self.base / "runtime/versions"
        old_runtime = self.versions / self.old
        old_runtime.mkdir(parents=True)
        (old_runtime / "t3").write_text(self.old)
        (self.versions.parent / "service-state.json").write_text(
            json.dumps({"activeVersion": self.old, "protocol": 4})
        )
        self.database = self.base / "userdata/statev2.sqlite"
        self.database.parent.mkdir()
        with closing(sqlite3.connect(self.database)) as db:
            db.execute("CREATE TABLE orchestration_v2_projection_runs (status TEXT)")
            db.execute("INSERT INTO orchestration_v2_projection_runs VALUES ('running')")
            db.commit()
        self.app = self.home / "Applications/T3 Code Local.app/Contents/Resources/app.asar"
        self.app.parent.mkdir(parents=True)
        self.app.write_text("Verified desktop artifact")

        payload_name = f"t3-{self.target}-darwin-arm64"
        payload = self.home / payload_name
        monitor = payload / "resource-monitor/darwin-arm64/t3-resource-monitor"
        monitor.parent.mkdir(parents=True)
        monitor.write_text("Monitor")
        (payload / "t3").write_text(self.target)
        archive = self.release / f"{payload_name}.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(payload, arcname=payload_name)

        self.record = {
            "commit": self.commit,
            "upstreamTag": "v0.1.13",
            "artifact": str(self.app),
            "appAsarSha256": activation.sha256(self.app),
            "upstreamCommit": "c" * 40,
            "environmentId": "fixture",
            "previousServerVersion": self.old,
            "serverVersion": self.target,
            "serverArchive": str(archive),
            "serverArchiveSha256": activation.sha256(archive),
            "status": "verified",
        }
        self.manifest.write_text(json.dumps(self.record))
        (self.root / "verified-candidate.json").write_text(json.dumps({
            **{field: self.record[field] for field in activation.DESKTOP_FIELDS},
            "serverManifest": str(self.manifest),
            "status": "ready",
        }))

    def test_explicit_restart_preserves_active_work_in_backup_and_installs_verified_server(self):
        live_version = self.old
        real_run = subprocess.run

        def run(args, **kwargs):
            nonlocal live_version
            if args[0] == "/usr/bin/tar":
                return real_run(args, **kwargs)
            self.assertEqual(args, (
                self.versions / self.target / "t3", "service", "install", "--base-dir", self.base,
            ))
            [backup] = self.release.glob("pre-cutover-*/statev2.sqlite")
            with closing(sqlite3.connect(backup)) as db:
                self.assertEqual(db.execute(
                    "SELECT status FROM orchestration_v2_projection_runs"
                ).fetchone(), ("running",))
            live_version = self.target

        def command(tool, *args):
            if tool == "/usr/bin/git":
                return self.commit if args[-1].startswith("refs/heads/") else self.record["upstreamCommit"]
            if tool == "/usr/bin/ditto":
                shutil.copytree(*args)
                return ""
            if tool == "/usr/bin/codesign":
                return ""
            if tool == "/usr/bin/lipo":
                return "arm64"
            if args == ("--version",):
                return f"t3 v{Path(tool).read_text()}"
            if args[0] == "__service-preflight":
                return json.dumps({"status": "ready", "version": self.target})
            self.fail(f"Unexpected command: {tool} {args}")

        def read_live():
            return {
                "serverVersion": live_version, "environmentId": "fixture", "databaseMigration": 119,
            }

        def check_service(home, runtime):
            self.assertEqual(home, self.home)
            self.assertEqual(runtime, self.versions / live_version / "t3")
            return {"EnvironmentVariables": {"PATH": "/usr/bin:/bin"}}

        with patch.object(activation, "command", command), patch.object(
            activation, "check_service", check_service
        ), patch.object(activation, "read_live", read_live), patch.object(subprocess, "run", run):
            result = activation.cutover(
                self.home, self.root, self.commit, self.manifest, self.record
            )
        self.assertIn(self.target, result)
        self.assertEqual(
            (self.versions / self.target / ".install-complete").read_text(), self.target + "\n"
        )
        [retained] = self.release.glob(f"pre-cutover-*/{self.old}/t3")
        self.assertEqual(retained.read_text(), self.old)
        self.assertEqual(live_version, self.target)

    def test_replaced_desktop_is_rejected_before_contacting_shared_service(self):
        self.app.write_text("Different desktop artifact")
        with patch.object(activation, "command", side_effect=(self.commit, self.record["upstreamCommit"])):
            with self.assertRaisesRegex(RuntimeError, "installed desktop bundle differs"):
                activation.cutover(self.home, self.root, self.commit, self.manifest, self.record)
        self.assertFalse((self.versions / self.target).exists())

    def test_archive_checksum_mismatch_leaves_runtime_unstaged(self):
        Path(self.record["serverArchive"]).write_text("Different archive")
        with self.assertRaisesRegex(RuntimeError, "archive checksum differs"):
            activation.stage_runtime(self.root, self.record, self.versions / self.target)
        self.assertFalse((self.versions / self.target).exists())


if __name__ == "__main__":
    unittest.main()
