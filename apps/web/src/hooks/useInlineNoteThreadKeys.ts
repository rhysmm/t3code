import { useMemo, useSyncExternalStore } from "react";
import {
  INLINE_NOTES_CHANGED_EVENT,
  invalidateInlineNoteThreadKeys,
  inlineNoteThreadKey,
  inlineNoteThreadKeysSnapshot,
} from "~/lib/inlineNotes";

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith("t3code:inline-notes:v1:")) {
      invalidateInlineNoteThreadKeys();
      onChange();
    }
  };
  window.addEventListener(INLINE_NOTES_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(INLINE_NOTES_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useInlineNoteThreadKeys(): ReadonlySet<string> {
  const snapshot = useSyncExternalStore(subscribe, inlineNoteThreadKeysSnapshot, () => "[]");
  return useMemo(() => new Set<string>(JSON.parse(snapshot)), [snapshot]);
}

export function isInlineNoteThread(
  keys: ReadonlySet<string>,
  environmentId: string,
  threadId: string,
): boolean {
  return keys.has(inlineNoteThreadKey(environmentId, threadId));
}
