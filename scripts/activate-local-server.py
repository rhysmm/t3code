"""Apply the verified server companion after an explicitly confirmed Local desktop restart."""

import hashlib
import json
import os
from contextlib import closing
from pathlib import Path
import plistlib
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.request import ProxyHandler, build_opener


SERVICE = "com.t3tools.t3code.service"
ENDPOINT = "http://127.0.0.1:3773/.well-known/t3/environment"
DESKTOP_FIELDS = ("commit", "upstreamTag", "artifact", "appAsarSha256")
OPENER = build_opener(ProxyHandler({}))


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def read_json(path):
    with path.open() as source:
        return json.load(source)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_live():
    with OPENER.open(ENDPOINT, timeout=3) as response:
        return json.load(response)


def check_service(home, runtime):
    loaded = command("/bin/launchctl", "print", f"gui/{os.getuid()}/{SERVICE}")
    if not re.search(rf"^\s*program = {re.escape(str(runtime))}$", loaded, re.M):
        raise RuntimeError("The loaded service uses a different runtime.")
    if not re.search(rf"^\s*T3CODE_HOME => {re.escape(str(home / '.t3'))}$", loaded, re.M):
        raise RuntimeError("The loaded service owns a different T3 home.")
    with (home / f"Library/LaunchAgents/{SERVICE}.plist").open("rb") as source:
        config = plistlib.load(source)
    if (
        config["ProgramArguments"][0] != str(runtime)
        or config["EnvironmentVariables"]["T3CODE_HOME"] != str(home / ".t3")
    ):
        raise RuntimeError("The service plist differs from the loaded service.")
    return config


def check_release(home, root, commit, manifest, record):
    receipt = read_json(root / "verified-candidate.json")
    if (
        receipt["status"] != "ready"
        or receipt["commit"] != commit
        or Path(receipt["serverManifest"]).resolve(strict=True) != manifest
        or any(receipt[field] != record[field] for field in DESKTOP_FIELDS)
    ):
        raise RuntimeError("The ready release differs from the confirmed desktop update.")

    git = ("/usr/bin/git", "-C", home / "Repos/t3code-local", "rev-parse", "--verify")
    if command(*git, "refs/heads/local/t3code^{commit}") != commit:
        raise RuntimeError("The fork branch moved after the update was confirmed.")
    if command(*git, "refs/t3code-local/upstream-stable^{commit}") != record["upstreamCommit"]:
        raise RuntimeError("The upstream release changed after the update was confirmed.")

    installed = home / "Applications/T3 Code Local.app/Contents/Resources/app.asar"
    if sha256(installed) != receipt["appAsarSha256"]:
        raise RuntimeError("The installed desktop bundle differs from the confirmed build.")


def require_live(record, expected_version):
    live = read_live()
    if live["environmentId"] != record["environmentId"]:
        raise RuntimeError("The discovery endpoint reports a different environment.")
    if live["serverVersion"] != expected_version:
        raise RuntimeError(f"The live server moved to {live['serverVersion']}.")
    return live


def stage_runtime(root, record, destination):
    archive = Path(record["serverArchive"]).resolve(strict=True)
    version = record["serverVersion"]
    stem = f"t3-{version}-darwin-arm64"
    if not archive.is_relative_to(root) or archive.name != stem + ".tar.gz":
        raise RuntimeError("The archive is outside the Local release or has the wrong version.")
    if sha256(archive) != record["serverArchiveSha256"]:
        raise RuntimeError("The archive checksum differs from the verified release.")

    with tempfile.TemporaryDirectory(prefix=".local-stage-", dir=destination.parent) as staging:
        subprocess.run(("/usr/bin/tar", "-xzf", archive, "-C", staging), check=True)
        payload = Path(staging) / stem
        executable = payload / "t3"
        monitor = payload / "resource-monitor/darwin-arm64/t3-resource-monitor"
        for binary in (executable, monitor):
            command("/usr/bin/codesign", "--verify", "--strict", binary)
            if command("/usr/bin/lipo", "-archs", binary) != "arm64":
                raise RuntimeError(f"The verified {binary.name} binary is not arm64.")
        if command(executable, "--version").split()[-1] != f"v{version}":
            raise RuntimeError("The staged CLI reports a different version.")
        (payload / ".install-complete").write_text(version + "\n")
        if destination.is_symlink():
            raise RuntimeError("The runtime destination is a symlink.")
        if destination.exists():
            command("/usr/bin/diff", "-qr", payload, destination)
        else:
            payload.rename(destination)


def preserve_previous(release, database, runtime, version):
    retained = Path(tempfile.mkdtemp(prefix="pre-cutover-", dir=release))
    prior = retained / version
    command("/usr/bin/ditto", runtime, prior)
    command("/usr/bin/codesign", "--verify", "--strict", prior / "t3")
    if command(prior / "t3", "--version").split()[-1] != f"v{version}":
        raise RuntimeError("The preserved runtime reports a different version.")
    backup = retained / "statev2.sqlite"
    with closing(sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True, timeout=5)) as source:
        with closing(sqlite3.connect(backup)) as copy:
            source.backup(copy)
            if copy.execute("PRAGMA quick_check").fetchone() != ("ok",):
                raise RuntimeError("The pre-restart SQLite backup failed its integrity check.")
    return backup


def cutover(home, root, commit, manifest, record):
    check_release(home, root, commit, manifest, record)
    base = home / ".t3"
    state = base / "runtime/service-state.json"
    versions = base / "runtime/versions"
    version = record["serverVersion"]
    old_version = record["previousServerVersion"]
    stable = record["upstreamTag"]
    match = re.fullmatch(r"v(\d+\.\d+\.\d+)", stable)
    stamped = None if match is None else re.fullmatch(
        re.escape(match[1]) + r"\+local\.([a-f0-9]{7,40})", version
    )
    if (
        record["status"] != "verified"
        or stamped is None
        or not commit.startswith(stamped[1])
        or not re.fullmatch(r"\d+\.\d+\.\d+[a-zA-Z0-9.+-]*", old_version)
    ):
        raise RuntimeError("The server manifest does not identify a verified fork release.")

    new_runtime = versions / version
    executable = new_runtime / "t3"
    live = read_live()
    if live["environmentId"] != record["environmentId"]:
        raise RuntimeError("The discovery endpoint reports a different environment.")
    if live["serverVersion"] == version:
        check_service(home, executable)
        return f"The shared server is already running {version}."
    if live["serverVersion"] != old_version:
        raise RuntimeError(f"The live server moved to {live['serverVersion']}.")
    old_runtime = versions / old_version
    config = check_service(home, old_runtime / "t3")
    service = read_json(state)
    if service["activeVersion"] != old_version or (service.get("update") or {}).get("status") == "pending":
        raise RuntimeError("The service selected another runtime or has another update pending.")

    stage_runtime(root, record, new_runtime)
    backup = preserve_previous(manifest.parent, base / "userdata/statev2.sqlite", old_runtime, old_version)
    preflight = json.loads(command(
        executable, "__service-preflight", "--database-path", backup,
        "--launcher-protocol", str(service["protocol"]),
    ))
    if preflight.get("status") != "ready" or preflight.get("version") != version:
        raise RuntimeError(f"The staged server failed startup preflight: {preflight}")

    check_release(home, root, commit, manifest, record)
    require_live(record, old_version)
    check_service(home, old_runtime / "t3")
    env = os.environ.copy()
    env["PATH"] = config["EnvironmentVariables"]["PATH"]
    for key in ("ELECTRON_RUN_AS_NODE", "T3_BOOT_SERVICE_UNIT", "T3_SERVICE_LAUNCHER_CONTEXT"):
        env.pop(key, None)
    subprocess.run((executable, "service", "install", "--base-dir", base),
                   env=env, check=True, timeout=180)

    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            live = read_live()
        except OSError:
            time.sleep(1)
            continue
        if live["environmentId"] != record["environmentId"]:
            raise RuntimeError("The restarted server reports a different environment.")
        if live["serverVersion"] == version:
            check_service(home, executable)
            return f"Verified shared server {version}, database migration {live['databaseMigration']}. Backup: {backup}."
        time.sleep(1)
    raise RuntimeError("The shared service did not come back on the verified version.")


def write_status(release, status, detail):
    fd, temporary = tempfile.mkstemp(prefix=".activation-result-", dir=release)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump({
                "status": status,
                "detail": detail,
                "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }, stream, indent=2)
            stream.write("\n")
        os.replace(temporary, release / "activation-result.json")
    finally:
        Path(temporary).unlink(missing_ok=True)
    print(detail, flush=True)


def main(home_path, commit, manifest_path, locked=False):
    os.umask(0o077)
    home = Path(home_path).resolve(strict=True)
    root = (home / ".local/share/t3code-local").resolve(strict=True)
    manifest = Path(manifest_path).resolve(strict=True)
    if (
        not re.fullmatch(r"[0-9a-f]{40}", commit)
        or manifest.name != "verified-server.json"
        or not manifest.is_relative_to(root)
    ):
        raise RuntimeError("The restart request does not identify a verified Local server manifest.")
    if not locked:
        return subprocess.run((
            "/usr/bin/lockf", "-k", "-t", "30", root / "promote.lock",
            sys.executable, "-I", Path(__file__).resolve(), home, commit, manifest, "--locked",
        ), check=False).returncode
    try:
        result = cutover(home, root, commit, manifest, read_json(manifest))
    except Exception as error:
        write_status(manifest.parent, "restart-failed", str(error))
        return 1
    write_status(manifest.parent, "updated", result)
    return 0


if __name__ == "__main__":
    if len(sys.argv) not in (4, 5) or sys.argv[4:] not in ([], ["--locked"]):
        sys.exit("Usage: activate-local-server.py HOME COMMIT SERVER_MANIFEST")
    sys.exit(main(*sys.argv[1:4], locked=sys.argv[4:] == ["--locked"]))
