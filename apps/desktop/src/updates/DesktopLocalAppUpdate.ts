// @effect-diagnostics nodeBuiltinImport:off -- The macOS installer runs outside the app's scoped child processes.
// @effect-diagnostics processTransparent:off -- The installer waits for this exact desktop process to exit.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

const bundleName = "T3 Code Local.app";
const bundleId = "com.rhysmm.t3code.local";
const archivePath = "Contents/Resources/app.asar";
const run = NodeUtil.promisify(NodeChildProcess.execFile);

interface RunningLocalApp {
  readonly homeDirectory: string;
  readonly appRoot: string;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly isPackaged: boolean;
}

const receiptSchema = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Literal("ready"),
    upstreamTag: Schema.String.check(Schema.isPattern(/^v\d+\.\d+\.\d+$/)),
    commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
    artifact: Schema.String,
    appAsarSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    serverManifest: Schema.optional(Schema.String),
  }),
);
const decodeReceipt = Schema.decodeUnknownSync(receiptSchema);
const decodePackage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.String,
      t3codeCommitHash: Schema.String,
    }),
  ),
);

export type LocalAppCandidate = typeof receiptSchema.Type & {
  readonly version: string;
  readonly id: string;
};

function updaterPaths(homeDirectory: string) {
  const directory = NodePath.join(homeDirectory, ".local/share/t3code-local");
  const destination = NodePath.join(homeDirectory, "Applications", bundleName);
  return {
    directory,
    destination,
    receipt: NodePath.join(directory, "verified-candidate.json"),
    checkout: NodePath.join(homeDirectory, "Repos/t3code-local"),
  };
}

async function bundleField(bundle: string, key: string) {
  const { stdout } = await run(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, NodePath.join(bundle, "Contents/Info.plist")],
    { timeout: 5_000 },
  );
  return stdout.trim();
}

export async function supportsLocalAppUpdate(app: RunningLocalApp): Promise<boolean> {
  const { destination } = updaterPaths(app.homeDirectory);
  if (!app.isPackaged || app.platform !== "darwin" || app.processArch !== "arm64") {
    return false;
  }
  try {
    return (
      (await NodeFSP.realpath(app.appRoot)) ===
        (await NodeFSP.realpath(NodePath.join(destination, archivePath))) &&
      (await bundleField(destination, "CFBundleIdentifier")) === bundleId
    );
  } catch {
    return false;
  }
}

function isCandidateDirectory(directory: string, artifact: string): boolean {
  const relative = NodePath.relative(directory, artifact);
  return (
    NodePath.isAbsolute(artifact) &&
    NodePath.basename(artifact) === bundleName &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

export async function readLocalAppCandidate(
  app: RunningLocalApp,
): Promise<LocalAppCandidate | null> {
  const paths = updaterPaths(app.homeDirectory);
  const raw = await NodeFSP.readFile(paths.receipt, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (raw === null) return null;
  const receipt = decodeReceipt(raw);
  const version = receipt.upstreamTag.slice(1);
  if (!isCandidateDirectory(paths.directory, receipt.artifact)) {
    throw new Error("The verified update bundle is outside the Local build directory.");
  }

  const running = decodePackage(
    await NodeFSP.readFile(NodePath.join(app.appRoot, "package.json"), "utf8"),
  );
  if (
    receipt.commit.startsWith(running.t3codeCommitHash) ||
    compareSemverVersions(version, app.appVersion) < 0
  ) {
    return null;
  }

  const { stdout: mergedCommit } = await run(
    "/usr/bin/git",
    ["-C", paths.checkout, "rev-parse", "--verify", "refs/heads/local/t3code^{commit}"],
    { timeout: 5_000 },
  );
  if (mergedCommit.trim() !== receipt.commit) return null;

  const artifact = await NodeFSP.realpath(receipt.artifact);
  if (
    !isCandidateDirectory(await NodeFSP.realpath(paths.directory), artifact) ||
    !(await NodeFSP.stat(artifact)).isDirectory()
  ) {
    throw new Error("The verified update bundle is outside the Local build directory.");
  }
  const identity = [receipt.commit, version, artifact, receipt.appAsarSha256];
  if (receipt.serverManifest !== undefined) identity.push(receipt.serverManifest);
  const id = NodeCrypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return { ...receipt, artifact, version, id };
}

async function verifyStagedBundle(bundle: string, candidate: LocalAppCandidate) {
  const archive = NodePath.join(bundle, archivePath);
  const { stdout: checksum } = await run("/usr/bin/shasum", ["-a", "256", archive], {
    timeout: 30_000,
  });
  const [digest] = checksum.split(/\s/u);
  const metadata = decodePackage(
    await NodeFSP.readFile(NodePath.join(archive, "package.json"), "utf8"),
  );
  if (
    digest !== candidate.appAsarSha256 ||
    !/^[a-f0-9]{12,40}$/.test(metadata.t3codeCommitHash) ||
    !candidate.commit.startsWith(metadata.t3codeCommitHash) ||
    metadata.version !== candidate.version ||
    (await bundleField(bundle, "CFBundleIdentifier")) !== bundleId ||
    (await bundleField(bundle, "CFBundleShortVersionString")) !== candidate.version
  ) {
    throw new Error("The update bundle no longer matches the verified candidate.");
  }
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { timeout: 30_000 });
}

// The runner uses system tools so it can finish after Electron exits and its bundle moves.
const installScript = `
set -eu
parent_pid=$1
directory=$2
new_app=$3
destination=$4
home=$5
server_helper=$6
candidate_commit=$7
server_manifest=$8
shift 8
previous_app="$directory/previous.app"
deadline=$((SECONDS + 30))
while /bin/kill -0 "$parent_pid" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    printf '%s\n' "Timed out waiting for T3 Code Local to quit." >&2
    /bin/rm -rf "$directory"
    exit 1
  fi
  /bin/sleep 0.2
done
launch() {
  local options=(-n -a "$destination" --env "HOME=$home")
  if [ -n "\${T3CODE_HOME:-}" ]; then
    options+=(--env "T3CODE_HOME=$T3CODE_HOME")
  fi
  /usr/bin/open "\${options[@]}" --args "$@"
}

if /bin/mv "$destination" "$previous_app"; then
  if /bin/mv "$new_app" "$destination"; then
    if [ -n "$server_helper" ]; then
      if ! /usr/bin/python3 -I "$server_helper" "$home" "$candidate_commit" "$server_manifest"; then
        printf '%s\n' "The shared server update failed. Relaunching T3 Code Local." >&2
        /usr/bin/osascript -e 'display notification "The shared server update failed. See update-install.log for details." with title "T3 Code Local"' || true
      fi
    fi
    if launch "$@"; then
      printf '%s\n' "Installed the verified Local update and requested its relaunch."
      /bin/rm -rf "$directory"
      exit 0
    fi
    if [ -n "$server_helper" ]; then
      # The server may have migrated already. Keep the new app and its backup.
      printf 'Could not relaunch the updated app. Its previous bundle is at %s.\n' "$previous_app" >&2
      exit 1
    fi
    /bin/mv "$destination" "$new_app"
  fi
  /bin/mv "$previous_app" "$destination"
fi
printf '%s\n' "Could not install the verified Local update. Relaunching the previous app." >&2
launch "$@"
/bin/rm -rf "$directory"
exit 1
`;

export async function stageLocalAppInstall(app: RunningLocalApp, candidate: LocalAppCandidate) {
  if (
    !(await supportsLocalAppUpdate(app)) ||
    (await readLocalAppCandidate(app))?.id !== candidate.id
  ) {
    throw new Error("The verified update changed. Check for updates again.");
  }
  const { checkout, destination, directory } = updaterPaths(app.homeDirectory);
  const stage = await NodeFSP.mkdtemp(
    NodePath.join(NodePath.dirname(destination), ".t3code-local-update-"),
  );
  const stagedApp = NodePath.join(stage, bundleName);
  try {
    await run("/usr/bin/ditto", [candidate.artifact, stagedApp], { timeout: 120_000 });
    await verifyStagedBundle(stagedApp, candidate);
    let serverHelper = "";
    if (candidate.serverManifest !== undefined) {
      if (!NodePath.isAbsolute(candidate.serverManifest)) {
        throw new Error("The shared server manifest path is not absolute.");
      }
      const { stdout } = await run(
        "/usr/bin/git",
        [
          "--no-replace-objects",
          "-C",
          checkout,
          "show",
          `${candidate.commit}:scripts/activate-local-server.py`,
        ],
        { timeout: 5_000 },
      );
      serverHelper = NodePath.join(stage, "activate-local-server.py");
      await NodeFSP.writeFile(serverHelper, stdout, { mode: 0o600 });
    }
    if ((await readLocalAppCandidate(app))?.id !== candidate.id) {
      throw new Error("The verified update changed. Check for updates again.");
    }
    const log = await NodeFSP.open(NodePath.join(directory, "update-install.log"), "a", 0o600);
    try {
      await new Promise<void>((resolve, reject) => {
        const worker = NodeChildProcess.spawn(
          "/bin/bash",
          [
            "-c",
            installScript,
            "t3code-local-update",
            String(process.pid),
            stage,
            stagedApp,
            destination,
            app.homeDirectory,
            serverHelper,
            candidate.commit,
            candidate.serverManifest ?? "",
            ...process.argv.slice(1),
          ],
          {
            detached: true,
            stdio: ["ignore", log.fd, log.fd],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined },
          },
        );
        worker.once("error", reject);
        worker.once("spawn", () => {
          worker.unref();
          resolve();
        });
      });
    } finally {
      await log.close().catch(() => {});
    }
  } catch (error) {
    await NodeFSP.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
