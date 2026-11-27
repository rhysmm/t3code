// @effect-diagnostics nodeBuiltinImport:off -- The fixture writes a temporary checkout and app bundle.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { describe, expect, it } from "vite-plus/test";

import { readLocalAppCandidate, supportsLocalAppUpdate } from "./DesktopLocalAppUpdate.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const appName = "T3 Code Local.app";

async function fixture() {
  const homeDirectory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-local-update-"));
  const dispose = async () => NodeFSP.rm(homeDirectory, { recursive: true, force: true });
  try {
    const checkout = NodePath.join(homeDirectory, "Repos/t3code-local");
    await NodeFSP.mkdir(checkout, { recursive: true });
    const git = (args: string[]) =>
      run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], {
        cwd: checkout,
      });
    await git(["init", "--quiet", "--initial-branch=local/t3code"]);
    await git(["commit", "--quiet", "--allow-empty", "-m", "Old app"]);
    const oldCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["commit", "--quiet", "--allow-empty", "-m", "Update"]);
    const commit = (await git(["rev-parse", "HEAD"])).stdout.trim();

    const appRoot = NodePath.join(
      homeDirectory,
      "Applications",
      appName,
      "Contents/Resources/app.asar",
    );
    await NodeFSP.mkdir(appRoot, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(appRoot, "package.json"),
      JSON.stringify({ version: "0.1.12", t3codeCommitHash: oldCommit.slice(0, 12) }),
    );
    const directory = NodePath.join(homeDirectory, ".local/share/t3code-local");
    const artifact = NodePath.join(directory, "candidate", appName);
    await NodeFSP.mkdir(artifact, { recursive: true });
    const receiptPath = NodePath.join(directory, "verified-candidate.json");
    const receipt = {
      status: "ready",
      upstreamTag: "v0.1.12",
      commit,
      artifact,
      appAsarSha256: "a".repeat(64),
    };
    const writeReceipt = (fields: Partial<typeof receipt> & { serverManifest?: string } = {}) =>
      NodeFSP.writeFile(receiptPath, JSON.stringify({ ...receipt, ...fields }));
    await writeReceipt();

    return {
      app: {
        homeDirectory,
        appRoot,
        appVersion: "0.1.12",
        platform: "darwin" as const,
        processArch: "arm64",
        isPackaged: true,
      },
      receipt,
      receiptPath,
      writeReceipt,
      oldCommit,
      git,
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

describe("verified T3 Code Local update", () => {
  it("offers a merged fork build at the same release version", async () => {
    await using state = await fixture();
    expect(await readLocalAppCandidate(state.app)).toMatchObject({
      commit: state.receipt.commit,
      version: "0.1.12",
    });
  });

  it("changes the update ID if a candidate is rebuilt at the same commit and version", async () => {
    await using state = await fixture();
    const original = await readLocalAppCandidate(state.app);
    await state.writeReceipt({ appAsarSha256: "b".repeat(64) });
    const rebuilt = await readLocalAppCandidate(state.app);
    expect(original?.id).toBeDefined();
    expect(rebuilt?.id).toBeDefined();
    expect(rebuilt?.id).not.toBe(original?.id);
  });

  it("changes the update ID when the paired server manifest path changes", async () => {
    await using state = await fixture();
    const desktopOnly = await readLocalAppCandidate(state.app);
    const serverManifest = NodePath.join(
      NodePath.dirname(state.receiptPath),
      "candidate",
      "verified-server.json",
    );
    await state.writeReceipt({ serverManifest });
    const paired = await readLocalAppCandidate(state.app);
    expect(paired).toMatchObject({ serverManifest });
    expect(paired?.id).not.toBe(desktopOnly?.id);

    await state.writeReceipt({ serverManifest: `${serverManifest}.new` });
    const changed = await readLocalAppCandidate(state.app);
    expect(changed?.id).not.toBe(paired?.id);
  });

  it("waits to show a candidate until local/t3code points to its commit", async () => {
    await using state = await fixture();
    await state.git(["branch", "candidate"]);
    await state.git(["reset", "--hard", state.oldCommit]);
    expect(await readLocalAppCandidate(state.app)).toBeNull();

    await state.git(["merge", "--ff-only", "candidate"]);
    expect(await readLocalAppCandidate(state.app)).toMatchObject({ commit: state.receipt.commit });
  });

  it("does not offer the installed commit, an older stable release, or a missing receipt", async () => {
    await using state = await fixture();
    await state.writeReceipt({ commit: state.oldCommit });
    expect(await readLocalAppCandidate(state.app)).toBeNull();

    await state.writeReceipt({ upstreamTag: "v0.1.11" });
    expect(await readLocalAppCandidate(state.app)).toBeNull();

    await NodeFSP.unlink(state.receiptPath);
    expect(await readLocalAppCandidate(state.app)).toBeNull();
  });

  it("rejects malformed receipts and bundles outside the Local artifact directory", async () => {
    await using state = await fixture();
    await state.writeReceipt({ commit: "not-a-commit" });
    await expect(readLocalAppCandidate(state.app)).rejects.toThrow();

    await state.writeReceipt({ artifact: NodePath.join(state.app.homeDirectory, appName) });
    await expect(readLocalAppCandidate(state.app)).rejects.toThrow(
      "outside the Local build directory",
    );
  });

  it("rejects an app running outside the Local installation path", async () => {
    await using state = await fixture();
    await expect(
      supportsLocalAppUpdate({ ...state.app, appRoot: state.receipt.artifact }),
    ).resolves.toBe(false);
  });
});
