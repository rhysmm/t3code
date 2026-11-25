// @effect-diagnostics nodeBuiltinImport:off - Conditional replacement uses native file identity and open flags.
import * as NodeBuffer from "node:buffer";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  DesktopLocalTextFile,
  DesktopOpenLocalTextFileInput,
  DesktopSaveLocalTextFileInput,
  DesktopSaveLocalTextFileResult,
} from "@t3tools/contracts";
import { isWindowsDrivePath } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const MAX_BYTES = 1024 * 1024;
const MAX_SESSIONS = 256;
const UTF8_BOM = NodeBuffer.Buffer.from("\uFEFF", "utf8");
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

type FileVersion = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly digest: string;
};

interface FileSnapshot {
  readonly contents: string;
  readonly hasBom: boolean;
  readonly mode: number;
  readonly owner: number;
  readonly group: number;
  readonly version: FileVersion;
}

interface OpenFile {
  readonly senderId: number;
  readonly requestedPath: string;
  readonly absolutePath: string;
  readonly hasBom: boolean;
  version: FileVersion;
}

function containsPath(root: string, file: string): boolean {
  const relative = NodePath.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
}

function isProtectedPath(
  file: string,
  stateDirs: readonly string[],
  secretsDirs: readonly string[],
): boolean {
  return (
    containsPath("/dev/fd", file) ||
    secretsDirs.some((directory) => containsPath(directory, file)) ||
    stateDirs.some(
      (directory) =>
        NodePath.relative(directory, NodePath.dirname(file)) === "" &&
        NodePath.basename(file).includes(".sqlite"),
    )
  );
}

function resolvePathOnDisk(value: string): Promise<string> {
  return NodeFSP.realpath(value).catch(() => NodePath.resolve(value));
}

function digest(bytes: NodeBuffer.Buffer): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function sameVersion(left: FileVersion, right: FileVersion): boolean {
  return left.device === right.device && left.inode === right.inode && left.digest === right.digest;
}

async function readSnapshot(file: string): Promise<FileSnapshot | null> {
  const named = await NodeFSP.lstat(file, { bigint: true });
  if (!named.isFile() || named.nlink !== 1n || named.size > BigInt(MAX_BYTES)) return null;

  const flags =
    NodeFS.constants.O_RDWR |
    (NodeFS.constants.O_NOFOLLOW ?? 0) |
    (NodeFS.constants.O_NONBLOCK ?? 0);
  const handle = await NodeFSP.open(file, flags);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.size > BigInt(MAX_BYTES)
    ) {
      return null;
    }

    const buffer = NodeBuffer.Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }

    const after = await handle.stat({ bigint: true });
    if (
      BigInt(length) !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      return null;
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) return null;
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
    return {
      contents,
      hasBom: bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM),
      mode: Number(before.mode),
      owner: Number(before.uid),
      group: Number(before.gid),
      version: { device: before.dev, inode: before.ino, digest: digest(bytes) },
    };
  } finally {
    await handle.close();
  }
}

function changedPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "EISDIR";
}

export function createLocalTextFileSessions({
  homeDirectory,
  platform,
  stateDirs,
}: {
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly stateDirs: readonly string[];
}) {
  const secretsDirs = stateDirs.map((directory) => NodePath.join(directory, "secrets"));
  const sessions = new Map<string, OpenFile>();
  const saving = new Set<string>();

  return {
    async open(senderId: number, path: string): Promise<DesktopLocalTextFile | null> {
      const homeRelative =
        path.startsWith("~/") || (platform === "win32" && path.startsWith("~\\"));
      const requestedPath = homeRelative ? NodePath.join(homeDirectory, path.slice(2)) : path;
      if (!NodePath.isAbsolute(requestedPath)) return null;
      if (platform === "win32" && !isWindowsDrivePath(requestedPath)) return null;
      try {
        const absolutePath = await NodeFSP.realpath(requestedPath);
        if (platform === "win32" && !isWindowsDrivePath(absolutePath)) return null;
        const [canonicalStateDirs, canonicalSecretsDirs] = await Promise.all([
          Promise.all(stateDirs.map(resolvePathOnDisk)),
          Promise.all(secretsDirs.map(resolvePathOnDisk)),
        ]);
        if (
          isProtectedPath(NodePath.resolve(requestedPath), stateDirs, secretsDirs) ||
          isProtectedPath(absolutePath, canonicalStateDirs, canonicalSecretsDirs)
        ) {
          return null;
        }
        const snapshot = await readSnapshot(absolutePath);
        if (!snapshot) return null;
        const key = NodeCrypto.randomUUID();
        if (sessions.size >= MAX_SESSIONS) {
          const oldest = sessions.keys().next();
          if (!oldest.done) sessions.delete(oldest.value);
        }
        sessions.set(key, {
          senderId,
          requestedPath,
          absolutePath,
          hasBom: snapshot.hasBom,
          version: snapshot.version,
        });
        return { key, absolutePath, contents: snapshot.contents };
      } catch {
        return null;
      }
    },

    async save(
      senderId: number,
      key: string,
      contents: string,
    ): Promise<DesktopSaveLocalTextFileResult> {
      const session = sessions.get(key);
      if (!session || session.senderId !== senderId || contents.includes("\u0000"))
        return "unavailable";
      const bytes = NodeBuffer.Buffer.from(
        session.hasBom && !contents.startsWith("\uFEFF") ? `\uFEFF${contents}` : contents,
      );
      if (bytes.length > MAX_BYTES) return "unavailable";
      const { requestedPath, absolutePath, version } = session;
      if (saving.has(absolutePath)) return "unavailable";
      saving.add(absolutePath);

      let temporaryDirectory: string | undefined;
      try {
        if ((await NodeFSP.realpath(requestedPath)) !== absolutePath) return "conflict";
        const snapshot = await readSnapshot(absolutePath);
        if (!snapshot || !sameVersion(version, snapshot.version)) return "conflict";
        const nextDigest = digest(bytes);
        if (version.digest === nextDigest) return "saved";

        temporaryDirectory = await NodeFSP.mkdtemp(
          NodePath.join(NodePath.dirname(absolutePath), ".t3-save-"),
        );
        const replacement = NodePath.join(temporaryDirectory, "contents");
        // On macOS cp -p keeps ACLs and extended attributes across replacement.
        if (platform === "darwin") {
          await execFile("/bin/cp", ["-pP", absolutePath, replacement], { timeout: 5_000 });
        }
        const handle = await NodeFSP.open(
          replacement,
          platform === "darwin"
            ? NodeFS.constants.O_RDWR | (NodeFS.constants.O_NOFOLLOW ?? 0)
            : "wx",
          0o600,
        );
        let replacementVersion: FileVersion;
        try {
          await handle.writeFile(bytes);
          if (platform === "darwin") await handle.truncate(bytes.length);
          const stat = await handle.stat({ bigint: true });
          if (platform !== "win32") {
            if (Number(stat.uid) !== snapshot.owner || Number(stat.gid) !== snapshot.group) {
              await handle.chown(snapshot.owner, snapshot.group);
            }
            const mode = snapshot.mode & 0o7777;
            await handle.chmod(mode);
            const permissions = await handle.stat();
            if (
              permissions.uid !== snapshot.owner ||
              permissions.gid !== snapshot.group ||
              (permissions.mode & 0o7777) !== mode
            ) {
              return "unavailable";
            }
          }
          await handle.sync();
          replacementVersion = { device: stat.dev, inode: stat.ino, digest: nextDigest };
        } finally {
          await handle.close();
        }

        if ((await NodeFSP.realpath(requestedPath)) !== absolutePath) return "conflict";
        const current = await readSnapshot(absolutePath);
        if (
          !current ||
          !sameVersion(version, current.version) ||
          current.mode !== snapshot.mode ||
          current.owner !== snapshot.owner ||
          current.group !== snapshot.group
        ) {
          return "conflict";
        }
        await NodeFSP.rename(replacement, absolutePath);
        session.version = replacementVersion;
        return "saved";
      } catch (error) {
        return changedPath(error) ? "conflict" : "unavailable";
      } finally {
        if (temporaryDirectory) {
          await NodeFSP.unlink(NodePath.join(temporaryDirectory, "contents")).catch(() => {});
          await NodeFSP.rmdir(temporaryDirectory).catch(() => {});
        }
        saving.delete(absolutePath);
      }
    },
  };
}

export const installLocalTextFileHandlers = Effect.fn("desktop.ipc.localTextFile.install")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const sessions = createLocalTextFileSessions({
      homeDirectory: environment.homeDirectory,
      platform: environment.platform,
      stateDirs: [
        environment.stateDir,
        NodePath.join(environment.homeDirectory, ".t3", "userdata"),
        NodePath.join(environment.homeDirectory, ".t3", "dev"),
        NodePath.join(environment.homeDirectory, ".t3-local", "userdata"),
        NodePath.join(environment.homeDirectory, ".t3-local", "dev"),
      ],
    });

    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: IpcChannels.OPEN_LOCAL_TEXT_FILE_CHANNEL,
        payload: DesktopOpenLocalTextFileInput,
        result: Schema.NullOr(DesktopLocalTextFile),
        handler: Effect.fn("desktop.ipc.localTextFile.open")((input, event) =>
          event
            ? Effect.promise(() => sessions.open(event.sender.id, input.absolutePath))
            : Effect.succeed(null),
        ),
      }),
    );

    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: IpcChannels.SAVE_LOCAL_TEXT_FILE_CHANNEL,
        payload: DesktopSaveLocalTextFileInput,
        result: DesktopSaveLocalTextFileResult,
        handler: Effect.fn("desktop.ipc.localTextFile.save")((input, event) =>
          event
            ? Effect.promise(() => sessions.save(event.sender.id, input.key, input.contents))
            : Effect.succeed("unavailable" as const),
        ),
      }),
    );
  },
);
