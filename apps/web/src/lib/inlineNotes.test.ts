import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildInlineNotePrompt,
  invalidateInlineNoteThreadKeys,
  inlineNoteThreadKeysSnapshot,
  inlineNotesStorageKey,
  readInlineNotes,
  writeInlineNotes,
} from "./inlineNotes";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("parent"),
  messageId: MessageId.make("message"),
  text: "selected passage",
  start: 0,
  end: 16,
  prefix: "",
  suffix: "",
};

describe("inline notes", () => {
  it("keeps note anchors scoped to the parent thread and restores them", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const note = {
      id: "note-1",
      citation,
      threadId: ThreadId.make("child"),
      question: "What does this mean?",
      createdAt: "2026-09-29T00:00:00.000Z",
    };
    writeInlineNotes("environment", "parent", [note]);
    expect(readInlineNotes("environment", "parent")).toEqual([note]);
    expect(readInlineNotes("environment", "another-parent")).toEqual([]);
    expect(inlineNoteThreadKeysSnapshot()).toBe(JSON.stringify(['["environment","child"]']));
    writeInlineNotes("environment", "parent", []);
    expect(inlineNoteThreadKeysSnapshot()).toBe("[]");
    values.set(inlineNotesStorageKey("environment", "parent"), "invalid json");
    invalidateInlineNoteThreadKeys();
    expect(readInlineNotes("environment", "parent")).toEqual([]);
    expect(inlineNoteThreadKeysSnapshot()).toBe("[]");
    vi.unstubAllGlobals();
  });

  it("includes the parent conversation, selected passage, and investigation instructions", () => {
    const prompt = buildInlineNotePrompt({
      citation,
      question: "Where is this implemented?",
      messages: [
        { role: "user", text: "How does the queue work?" },
        { role: "assistant", text: "It retries failed jobs." },
      ],
    });
    expect(prompt).toContain("user: How does the queue work?");
    expect(prompt).toContain("assistant: It retries failed jobs.");
    expect(prompt).toContain("selected passage");
    expect(prompt).toContain("Where is this implemented?");
    expect(prompt).toContain("inspect the current repository");
  });
});
