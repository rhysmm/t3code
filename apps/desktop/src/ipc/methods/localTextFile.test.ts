// @effect-diagnostics nodeBuiltinImport:off - These tests exercise native file identity and permissions.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

import { createLocalTextFileSessions } from "./localTextFile.ts";

const platform = HostProcess.Platform.defaultValue();

describe("desktop local text file editing", () => {
  it("saves the opened file repeatedly and preserves its UTF-8 BOM and mode", async () => {
    const directory = await NodeFSP.mkdtempDisposable(NodePath.join(NodeOS.tmpdir(), "t3-edit-"));
    await using _cleanup = directory;
    const file = NodePath.join(directory.path, "notes.txt");
    await NodeFSP.writeFile(file, "\uFEFForiginal", { mode: 0o640 });
    if (platform === "darwin") {
      NodeChildProcess.execFileSync("/usr/bin/xattr", ["-w", "user.t3-test", "preserve", file]);
    }
    const original = await NodeFSP.stat(file);
    const sessions = createLocalTextFileSessions({
      homeDirectory: directory.path,
      platform,
      stateDirs: [],
    });

    const opened = await sessions.open(1, platform === "win32" ? "~\\notes.txt" : "~/notes.txt");
    expect(opened?.contents).toBe("original");
    if (!opened) throw new Error("File did not open");

    expect(await sessions.save(2, opened.key, "wrong window")).toBe("unavailable");
    expect(await sessions.save(1, opened.key, "first edit")).toBe("saved");
    expect(await sessions.save(1, opened.key, "short")).toBe("saved");
    expect(await NodeFSP.readFile(file, "utf8")).toBe("\uFEFFshort");
    if (platform === "darwin") {
      expect(
        NodeChildProcess.execFileSync("/usr/bin/xattr", ["-p", "user.t3-test", file], {
          encoding: "utf8",
        }).trim(),
      ).toBe("preserve");
    }
    if (platform !== "win32") {
      const saved = await NodeFSP.stat(file);
      expect([saved.mode, saved.uid, saved.gid]).toEqual([
        original.mode,
        original.uid,
        original.gid,
      ]);
    }
  });

  it("keeps external edits, replacements and removals when the opened version changed", async () => {
    const directory = await NodeFSP.mkdtempDisposable(NodePath.join(NodeOS.tmpdir(), "t3-edit-"));
    await using _cleanup = directory;
    const file = NodePath.join(directory.path, "notes.txt");
    await NodeFSP.writeFile(file, "before");
    const sessions = createLocalTextFileSessions({
      homeDirectory: directory.path,
      platform,
      stateDirs: [],
    });

    const opened = await sessions.open(1, file);
    if (!opened) throw new Error("File did not open");
    await NodeFSP.writeFile(file, "edited externally");
    expect(await sessions.save(1, opened.key, "draft")).toBe("conflict");
    expect(await NodeFSP.readFile(file, "utf8")).toBe("edited externally");

    const reopened = await sessions.open(1, file);
    if (!reopened) throw new Error("File did not reopen");
    await NodeFSP.rename(file, NodePath.join(directory.path, "old.txt"));
    await NodeFSP.writeFile(file, "edited externally");
    expect(await sessions.save(1, reopened.key, "draft")).toBe("conflict");

    if (platform !== "win32") {
      await NodeFSP.unlink(file);
      await NodeFSP.symlink(NodePath.join(directory.path, "old.txt"), file);
      expect(await sessions.save(1, reopened.key, "draft")).toBe("conflict");
      expect(await NodeFSP.readFile(file, "utf8")).toBe("edited externally");
    }

    await NodeFSP.unlink(file);
    expect(await sessions.save(1, reopened.key, "draft")).toBe("conflict");
    await expect(NodeFSP.stat(file)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("refuses protected paths, non-text content and truncated previews", async () => {
    const directory = await NodeFSP.mkdtempDisposable(NodePath.join(NodeOS.tmpdir(), "t3-edit-"));
    await using _cleanup = directory;
    const protectedDir = NodePath.join(directory.path, "state", "secrets");
    await NodeFSP.mkdir(protectedDir, { recursive: true });
    const protectedFile = NodePath.join(protectedDir, "service-key");
    const databaseFile = NodePath.join(directory.path, "state", "statev2.sqlite-wal");
    const hardLinkedFile = NodePath.join(directory.path, "linked.txt");
    const binaryFile = NodePath.join(directory.path, "binary.txt");
    const largeFile = NodePath.join(directory.path, "large.txt");
    await Promise.all([
      NodeFSP.writeFile(protectedFile, "private"),
      NodeFSP.writeFile(databaseFile, "database"),
      NodeFSP.writeFile(binaryFile, new Uint8Array([0xff])),
      NodeFSP.writeFile(largeFile, "x".repeat(1024 * 1024 + 1)),
    ]);

    await NodeFSP.link(protectedFile, hardLinkedFile);
    const sessions = createLocalTextFileSessions({
      homeDirectory: directory.path,
      platform,
      stateDirs: [NodePath.dirname(protectedDir)],
    });
    for (const file of [
      protectedFile,
      databaseFile,
      hardLinkedFile,
      binaryFile,
      largeFile,
      directory.path,
    ]) {
      expect(await sessions.open(1, file)).toBeNull();
    }
  });
});
