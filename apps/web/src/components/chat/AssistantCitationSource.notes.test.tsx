// @vitest-environment jsdom
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { InlineNote } from "~/lib/inlineNotes";
import { AssistantCitationSource } from "./AssistantCitationSource";

const note: InlineNote = {
  id: "note-1",
  citation: {
    version: 1,
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("parent"),
    messageId: MessageId.make("message"),
    text: "hello",
    start: 0,
    end: 5,
    prefix: "",
    suffix: "",
  },
  threadId: ThreadId.make("note-thread"),
  question: "Why?",
  createdAt: "2026-09-29T00:00:00.000Z",
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const originalGetClientRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => ({
      length: 1,
      item: () => new DOMRect(0, 0, 100, 20),
    }),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(() => root.unmount());
  container?.remove();
  if (originalGetClientRects) {
    Object.defineProperty(Range.prototype, "getClientRects", originalGetClientRects);
  } else {
    Reflect.deleteProperty(Range.prototype, "getClientRects");
  }
  vi.unstubAllGlobals();
});

describe("saved note source", () => {
  it("opens the note from its text, but not from nearby text or an active selection", async () => {
    const onOpenNote = vi.fn();
    await act(() =>
      root.render(
        <AssistantCitationSource
          messageId={note.citation.messageId}
          itemKey="message"
          request={null}
          listRef={{ current: null }}
          notes={[note]}
          onOpenNote={onOpenNote}
        >
          <span>hello</span>
        </AssistantCitationSource>,
      ),
    );
    const text = container.querySelector("span")!;

    text.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 150, clientY: 10 }));
    expect(onOpenNote).not.toHaveBeenCalled();

    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.addRange(range);
    text.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 50, clientY: 10 }));
    expect(onOpenNote).not.toHaveBeenCalled();

    selection.removeAllRanges();
    text.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 50, clientY: 10 }));
    expect(onOpenNote).toHaveBeenCalledExactlyOnceWith("note-1");
  });
});
