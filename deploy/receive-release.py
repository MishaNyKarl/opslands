#!/usr/bin/python3
"""Root-owned forced-command receiver. Accept code only, never data/config."""

import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.request import urlopen

ROOT = Path("/opt/opslands")
FILES = {"server.mjs", "package.json", "pnpm-lock.yaml", "README.md", ".release-revision"}


def run(*args, **kwargs):
    return subprocess.run(args, check=True, timeout=300, **kwargs)


def receive():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise RuntimeError("Receiver requires root and accepts no arguments")
    os.umask(0o077)
    with open("/run/lock/opslands-deploy.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = ROOT / "current"
        previous = current.resolve(strict=True)
        if not current.is_symlink() or ROOT / "releases" not in previous.parents:
            raise RuntimeError("Unexpected current release layout")
        run("systemctl", "is-active", "--quiet", "opslands.service")
        with tempfile.TemporaryDirectory(prefix="incoming-", dir=ROOT / "releases") as temporary:
            stage = Path(temporary)
            archive_path = stage / "release.tar.gz"
            total = 0
            with archive_path.open("wb") as output:
                while chunk := sys.stdin.buffer.read(1024 * 1024):
                    total += len(chunk)
                    if total > 100 * 1024 * 1024:
                        raise RuntimeError("Archive too large")
                    output.write(chunk)
            unpacked = 0
            seen = set()
            with tarfile.open(archive_path, "r:gz") as archive:
                for member in archive:
                    path = PurePosixPath(member.name)
                    parts = path.parts
                    if (path.is_absolute() or ".." in parts or not parts or parts[0] != "app"
                            or not (member.isdir() or member.isfile())
                            or member.name in seen or len(seen) > 20000):
                        raise RuntimeError("Unsafe archive entry")
                    seen.add(member.name)
                    if len(parts) > 1 and not (
                        parts[1] in {"lib", "public"} or len(parts) == 2 and parts[1] in FILES
                    ):
                        raise RuntimeError("Archive contains data or unsupported files")
                    unpacked += member.size
                    if unpacked > 512 * 1024 * 1024:
                        raise RuntimeError("Unpacked release too large")
                    target = stage.joinpath(*parts)
                    if member.isdir():
                        target.mkdir(parents=True, exist_ok=True, mode=0o755)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                        with archive.extractfile(member) as source, target.open("xb") as output:
                            shutil.copyfileobj(source, output)
                        target.chmod(0o644)
            app = stage / "app"
            for required in ("server.mjs", "package.json", "pnpm-lock.yaml", ".release-revision"):
                if not (app / required).is_file():
                    raise RuntimeError("Incomplete release")
            revision = (app / ".release-revision").read_text().strip()
            if not re.fullmatch("[0-9a-f]{40}", revision):
                raise RuntimeError("Invalid revision")
            destination = ROOT / "releases" / f"{revision}-{time.time_ns()}"
            app.rename(destination)
            # Keep the entire tree inaccessible to the running application until
            # root has finished changing ownership. Hand over the top directory last.
            destination.chmod(0o700)
            owner = pwd.getpwnam("opslands")
            for directory, subdirs, files in os.walk(destination, topdown=False):
                for name in files:
                    os.chown(Path(directory) / name, owner.pw_uid, owner.pw_gid, follow_symlinks=False)
                os.chown(directory, owner.pw_uid, owner.pw_gid, follow_symlinks=False)
                os.chmod(directory, 0o755)
            cache = Path("/var/cache/opslands-deploy")
            run("/usr/sbin/runuser", "-u", "opslands", "--", "/opt/opslands/node/bin/npm", "exec",
                "--yes", "--package=pnpm@11.25.0", "--", "pnpm", "install", "--prod",
                "--frozen-lockfile", "--ignore-scripts", cwd=destination,
                env={"PATH": "/opt/opslands/node/bin:/usr/bin:/bin", "HOME": str(cache),
                     "NODE_ENV": "production"})
            backup_dir = Path("/var/backups/opslands")
            backup_dir.mkdir(mode=0o700, exist_ok=True)
            with sqlite3.connect("file:/var/lib/opslands/opslands.sqlite?mode=ro", uri=True) as database:
                with sqlite3.connect(backup_dir / f"before-{time.time_ns()}.sqlite") as backup:
                    database.backup(backup)
            link = ROOT / ".next-release"
            link.unlink(missing_ok=True)
            link.symlink_to(destination)
            link.replace(current)
            try:
                run("systemctl", "restart", "opslands.service")
                for attempt in range(30):
                    try:
                        with urlopen("http://127.0.0.1:3107/healthz", timeout=3) as response:
                            health = json.load(response)
                        with urlopen("http://127.0.0.1:3107/api/auth/me", timeout=3) as response:
                            auth = json.load(response)
                        pid = subprocess.check_output(
                            ["systemctl", "show", "opslands.service", "--property=MainPID", "--value"],
                            text=True, timeout=10,
                        ).strip()
                        if (pid != "0" and Path(f"/proc/{pid}/cwd").resolve() == destination
                                and health.get("revision") == revision and auth.get("ssoEnabled") is True):
                            print(f"Deployed OPSLands revision: {revision}")
                            return
                    except (OSError, ValueError):
                        pass
                    time.sleep(1)
                raise RuntimeError("Revision/SSO health check failed")
            except Exception:
                link.unlink(missing_ok=True)
                link.symlink_to(previous)
                link.replace(current)
                run("systemctl", "restart", "opslands.service")
                raise


if __name__ == "__main__":
    try:
        receive()
    except Exception as error:
        # Do not print payloads, environment, credentials or service logs.
        print(f"OPSLands deployment failed ({type(error).__name__}); previous release preserved", file=sys.stderr)
        sys.exit(1)
