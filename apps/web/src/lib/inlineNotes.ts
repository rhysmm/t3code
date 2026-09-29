import { AssistantCitation, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const InlineNoteSchema = Schema.Struct({
  id: Schema.String,
  citation: AssistantCitation,
  threadId: ThreadId,
  question: Schema.String,
  createdAt: Schema.String,
});

export type InlineNote = typeof InlineNoteSchema.Type;

const InlineNotesSchema = Schema.Array(InlineNoteSchema);
const decodeInlineNotes = Schema.decodeUnknownSync(InlineNotesSchema);
const STORAGE_PREFIX = "t3code:inline-notes:v1:";
export const INLINE_NOTES_CHANGED_EVENT = "t3code:inline-notes-changed";
let threadKeysSnapshot: string | null = null;

export function invalidateInlineNoteThreadKeys(): void {
  threadKeysSnapshot = null;
}

export function inlineNoteThreadKey(environmentId: string, threadId: string): string {
  return JSON.stringify([environmentId, threadId]);
}

export function inlineNotesStorageKey(environmentId: string, parentThreadId: string): string {
  return `${STORAGE_PREFIX}${environmentId}:${parentThreadId}`;
}

export function readInlineNotes(environmentId: string, parentThreadId: string): InlineNote[] {
  try {
    const value = localStorage.getItem(inlineNotesStorageKey(environmentId, parentThreadId));
    return value ? [...decodeInlineNotes(JSON.parse(value))] : [];
  } catch {
    return [];
  }
}

export function writeInlineNotes(
  environmentId: string,
  parentThreadId: string,
  notes: readonly InlineNote[],
): void {
  localStorage.setItem(inlineNotesStorageKey(environmentId, parentThreadId), JSON.stringify(notes));
  invalidateInlineNoteThreadKeys();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(INLINE_NOTES_CHANGED_EVENT));
}

/** The side conversations are ordinary agent threads, but their anchors own sidebar visibility. */
export function inlineNoteThreadKeysSnapshot(): string {
  if (threadKeysSnapshot !== null) return threadKeysSnapshot;
  try {
    const keys = new Set<string>();
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      try {
        const notes = decodeInlineNotes(JSON.parse(localStorage.getItem(key) ?? "[]"));
        for (const note of notes) {
          keys.add(inlineNoteThreadKey(note.citation.environmentId, note.threadId));
        }
      } catch {
        // One damaged parent record should not reveal or hide unrelated notes.
      }
    }
    threadKeysSnapshot = JSON.stringify([...keys].sort());
  } catch {
    threadKeysSnapshot = "[]";
  }
  return threadKeysSnapshot;
}

export function buildInlineNotePrompt(input: {
  citation: AssistantCitation;
  question: string;
  messages: ReadonlyArray<{ role: string; text: string }>;
}): string {
  const transcript = input.messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.text)
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n\n");
  const recentTranscript = transcript.slice(-40_000);
  return [
    "You are answering a side note attached to a passage in another chat. You can inspect the current repository, related repositories available on this machine, and their history to answer the question. Keep your answer focused on the note. Do not edit files or change external state unless the user explicitly asks in this side conversation.",
    "The parent chat transcript at the time this note was created follows. The beginning may be omitted if it exceeds the context limit:",
    recentTranscript,
    `Selected passage from assistant message ${input.citation.messageId}:\n${input.citation.text}`,
    `Question: ${input.question}`,
  ].join("\n\n");
}
