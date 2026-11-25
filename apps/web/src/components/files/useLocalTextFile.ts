import type { DesktopBridge, DesktopLocalTextFile } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

type SaveStatus = "saving" | "conflict" | "unavailable";
type LocalTextFileBridge = Pick<
  DesktopBridge,
  "getClientPlatform" | "openLocalTextFile" | "saveLocalTextFile"
>;

export function getLocalTextFileBridge(): LocalTextFileBridge | undefined {
  return window.desktopBridge;
}

interface LocalFileSession {
  readonly file: DesktopLocalTextFile;
  readonly contents: string;
  readonly status: SaveStatus | null;
}

const useLocalFiles = create<{ readonly files: ReadonlyMap<string, LocalFileSession> }>(() => ({
  files: new Map(),
}));
const panelsByPath = new Map<string, number>();

function readSession(path: string) {
  return useLocalFiles.getState().files.get(path);
}

function hasUnsavedContents(session: LocalFileSession) {
  return session.contents !== session.file.contents || session.status === "saving";
}

function setSession(path: string, session: LocalFileSession | undefined) {
  useLocalFiles.setState(({ files }) => {
    const next = new Map(files);
    if (session && (panelsByPath.has(path) || hasUnsavedContents(session))) next.set(path, session);
    else next.delete(path);
    return { files: next };
  });
}

async function openSession(bridge: LocalTextFileBridge | undefined, path: string) {
  const file = await bridge?.openLocalTextFile?.({ absolutePath: path }).catch(() => null);
  return file ? { file, contents: file.contents, status: null } : undefined;
}

export function useLocalTextFile(
  bridge: LocalTextFileBridge | undefined,
  path: string | null,
  previewContents: string | undefined,
) {
  const session = useLocalFiles((state) => (path === null ? undefined : state.files.get(path)));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps unsaved files available when their panels unmount
  useEffect(() => {
    if (path === null) return;
    panelsByPath.set(path, (panelsByPath.get(path) ?? 0) + 1);
    return () => {
      const panels = panelsByPath.get(path) ?? 1;
      if (panels > 1) {
        panelsByPath.set(path, panels - 1);
      } else {
        panelsByPath.delete(path);
        const session = readSession(path);
        if (session && !hasUnsavedContents(session)) setSession(path, undefined);
      }
    };
  }, [path]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the local file before editing and refreshes clean buffers after disk changes
  useEffect(() => {
    if (path === null || previewContents === undefined) return;
    const previous = readSession(path);
    if (previous && (hasUnsavedContents(previous) || previous.contents === previewContents)) return;
    let active = true;
    void openSession(bridge, path).then((next) => {
      if (active && readSession(path) === previous) setSession(path, next);
    });
    return () => {
      active = false;
    };
  }, [bridge, path, previewContents]);

  const change = (contents: string) => {
    if (path === null) return;
    const current = readSession(path);
    if (!current || contents === current.contents) return;
    setSession(path, { ...current, contents });
  };

  const save = async () => {
    if (path === null) return false;
    const current = readSession(path);
    const saveFile = bridge?.saveLocalTextFile;
    if (!current || current.status === "saving" || !hasUnsavedContents(current) || !saveFile) {
      return false;
    }

    setSession(path, { ...current, status: "saving" });
    const result = await saveFile({ key: current.file.key, contents: current.contents }).catch(
      () => "unavailable" as const,
    );
    const latest = readSession(path) ?? current;
    if (result !== "saved") {
      setSession(path, { ...latest, status: result });
      return false;
    }

    setSession(path, {
      ...latest,
      file: { ...current.file, contents: current.contents },
      status: null,
    });
    return true;
  };

  const discard = async () => {
    if (path === null) return;
    const current = readSession(path);
    if (!current || current.status === "saving") return;
    const next = await openSession(bridge, path);
    if (readSession(path) === current) setSession(path, next);
  };

  return {
    contents: session?.contents,
    dirty: session !== undefined && hasUnsavedContents(session),
    saveStatus: session?.status ?? null,
    change,
    save,
    discard,
  };
}
