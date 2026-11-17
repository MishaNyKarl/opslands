"""Exercise the privileged receiver with isolated files and mocked service commands."""
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


@unittest.skipUnless(sys.platform == "linux", "The production receiver runs on Linux")
class DeploymentTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "receiver", Path(__file__).resolve().parents[1] / "deploy/receive-release.py"
        )
        self.receiver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.receiver)
        self.temporary = tempfile.TemporaryDirectory(prefix="opslands-deploy-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.receiver.ROOT = self.root
        self.previous = self.root / "releases" / "previous"
        self.previous.mkdir(parents=True)
        self.current = self.root / "current"
        self.current.symlink_to(self.previous)
        self.revision = "a" * 40
        self.commands = []
        self.healthy = True

        # Only these two server-owned paths are redirected; subprocesses never run.
        def path(value, *parts):
            if str(value).startswith("/proc/") and str(value).endswith("/cwd"):
                return self.current
            if str(value) in ("/var/cache/opslands-deploy", "/var/backups/opslands"):
                return self.root / Path(value).name
            return Path(value, *parts)

        real_open = open

        def open_file(file, *args, **kwargs):
            if str(file) == "/run/lock/opslands-deploy.lock":
                file = self.root / "deploy.lock"
            return real_open(file, *args, **kwargs)

        def run(*args, **kwargs):
            self.commands.append(args)

        def urlopen(url, **kwargs):
            if not self.healthy:
                raise OSError("Simulated unhealthy release")
            return io.BytesIO(json.dumps({"revision": self.revision, "ssoEnabled": True}).encode())

        for target, replacement in [
            ("Path", path), ("run", run), ("urlopen", urlopen),
        ]:
            context = patch.object(self.receiver, target, replacement)
            context.start()
            self.addCleanup(context.stop)
        for context in [
            patch("builtins.open", open_file),
            patch.object(self.receiver.os, "geteuid", return_value=0),
            patch.object(self.receiver.os, "chown"),
            patch.object(self.receiver.pwd, "getpwnam"),
            patch.object(self.receiver.sqlite3, "connect"),
            patch.object(self.receiver.subprocess, "check_output", return_value="123\n"),
            patch.object(self.receiver.time, "sleep"),
            patch.object(sys, "argv", ["receive-release.py"]),
        ]:
            context.start()
            self.addCleanup(context.stop)

    def archive(self, extra=None):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for name, content in {
                "app/server.mjs": b"// fixture",
                "app/package.json": b"{}",
                "app/pnpm-lock.yaml": b"lockfileVersion: '9.0'",
                "app/.release-revision": self.revision.encode(),
            }.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                archive.addfile(entry, io.BytesIO(content))
            if extra is not None:
                archive.addfile(extra, io.BytesIO(b""))
        buffer.seek(0)
        return buffer

    def receive(self, payload):
        class Input:
            buffer = payload
        with patch.object(sys, "stdin", Input()):
            self.receiver.receive()

    def test_verified_release_switches_only_after_dependency_install(self):
        self.receive(self.archive())
        self.assertNotEqual(self.current.resolve(), self.previous)
        self.assertEqual((self.current / ".release-revision").read_text(), self.revision)
        self.assertEqual(self.commands[1][0], "/usr/sbin/runuser")
        self.assertEqual(self.commands[-1], ("systemctl", "restart", "opslands.service"))

    def test_unhealthy_release_rolls_back_and_restarts_previous(self):
        self.healthy = False
        with self.assertRaises(RuntimeError):
            self.receive(self.archive())
        self.assertEqual(self.current.resolve(), self.previous)
        self.assertEqual(self.commands.count(("systemctl", "restart", "opslands.service")), 2)

    def test_dependency_failure_keeps_running_release(self):
        def fail_install(*args, **kwargs):
            if args[0] == "/usr/sbin/runuser":
                raise RuntimeError("Simulated failed dependency installation")
        with patch.object(self.receiver, "run", fail_install):
            with self.assertRaises(RuntimeError):
                self.receive(self.archive())
        self.assertEqual(self.current.resolve(), self.previous)

    def test_malicious_archives_never_install_dependencies_or_switch_release(self):
        entries = [
            tarfile.TarInfo("app/../../escape"),
            tarfile.TarInfo("/tmp/escape"),
            tarfile.TarInfo("app/.env"),
            tarfile.TarInfo("app/data/opslands.sqlite"),
            tarfile.TarInfo("app/server.mjs"),  # Duplicate overwrites are forbidden.
        ]
        link = tarfile.TarInfo("app/lib/link")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        entries.append(link)
        for entry in entries:
            with self.subTest(name=entry.name):
                self.commands.clear()
                with self.assertRaises((RuntimeError, FileExistsError)):
                    self.receive(self.archive(entry))
                self.assertEqual(self.current.resolve(), self.previous)
                self.assertEqual(self.commands, [("systemctl", "is-active", "--quiet", "opslands.service")])


if __name__ == "__main__":
    unittest.main()
