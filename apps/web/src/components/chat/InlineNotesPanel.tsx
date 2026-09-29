import type {
  ApprovalRequestId,
  AssistantCitation,
  EnvironmentId,
  ProviderApprovalDecision,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { MessageSquareIcon, XIcon } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useThread } from "~/state/entities";
import type { InlineNote } from "~/lib/inlineNotes";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

function NoteConversation({
  note,
  environmentId,
  cwd,
  draft,
  onDraftChange,
  onSend,
  onRespondToApproval,
}: {
  note: InlineNote;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSend: (threadId: ThreadId, text: string) => Promise<boolean>;
  onRespondToApproval: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<boolean>;
}) {
  const thread = useThread(scopeThreadRef(environmentId, note.threadId));
  const firstUserIndex = thread?.messages.findIndex((message) => message.role === "user") ?? -1;
  const { approvals, userInputs } = useMemo(
    () => derivePendingRequests(thread?.activities ?? []),
    [thread?.activities],
  );
  const activeApproval = approvals[0] ?? null;
  const [sending, setSending] = useState(false);
  const [respondingRequestId, setRespondingRequestId] = useState<ApprovalRequestId | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const respondToApproval = async (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => {
    if (respondingRequestId !== null) return;
    setRespondingRequestId(requestId);
    setApprovalError(null);
    try {
      if (!(await onRespondToApproval(note.threadId, requestId, decision))) {
        setApprovalError("Could not submit the approval decision. Try again.");
      }
    } catch {
      setApprovalError("Could not submit the approval decision. Try again.");
    } finally {
      setRespondingRequestId(null);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      if (await onSend(note.threadId, text)) onDraftChange("");
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <blockquote className="border-s-2 border-primary/50 ps-3 text-sm text-muted-foreground">
          {note.citation.text}
        </blockquote>
        <p className="text-sm font-medium">{note.question}</p>
        {activeApproval ? (
          <div className="space-y-3 rounded-md border border-warning/50 p-3">
            <ComposerPendingApprovalPanel
              approval={activeApproval}
              pendingCount={approvals.length}
            />
            <div className="flex flex-wrap gap-2">
              <ComposerPendingApprovalActions
                requestId={activeApproval.requestId}
                isResponding={respondingRequestId === activeApproval.requestId}
                options={activeApproval.options}
                onRespondToApproval={respondToApproval}
              />
            </div>
            {approvalError ? (
              <p role="alert" className="text-xs text-destructive">
                {approvalError}
              </p>
            ) : null}
          </div>
        ) : null}
        {userInputs.length > 0 ? (
          <p className="text-xs text-warning">
            The agent needs an answer.{" "}
            <a
              href={`/${encodeURIComponent(environmentId)}/${encodeURIComponent(note.threadId)}`}
              className="underline underline-offset-2"
            >
              Answer in full chat
            </a>
          </p>
        ) : null}
        {thread?.messages
          .filter(
            (message, index) =>
              message.role === "assistant" || (message.role === "user" && index > firstUserIndex),
          )
          .map((message) => (
            <div key={message.id} className="text-sm">
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {message.role === "user" ? "You" : "Codex"}
              </p>
              <ChatMarkdown
                text={message.text}
                cwd={cwd}
                threadRef={scopeThreadRef(environmentId, note.threadId)}
                isStreaming={message.streaming}
              />
            </div>
          ))}
        {thread?.session?.status === "running" ? (
          <p role="status" className="text-xs text-muted-foreground">
            Investigating…
          </p>
        ) : null}
        {thread?.session?.lastError ? (
          <p role="alert" className="text-xs text-destructive">
            {thread.session.lastError}
          </p>
        ) : null}
        {thread?.session?.status !== "running" &&
        !thread?.messages.some((message) => message.role === "assistant") ? (
          <p className="text-xs text-muted-foreground">Waiting for an answer…</p>
        ) : null}
      </div>
      <form onSubmit={submit} className="border-t border-border p-3">
        <label htmlFor={`note-followup-${note.id}`} className="sr-only">
          Follow up on note
        </label>
        <textarea
          id={`note-followup-${note.id}`}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="Ask a follow-up…"
          rows={3}
          className="w-full resize-y rounded-md border border-border bg-background p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button
          type="submit"
          size="sm"
          disabled={
            !draft.trim() ||
            sending ||
            thread?.session?.status === "running" ||
            approvals.length > 0 ||
            userInputs.length > 0
          }
        >
          Send
        </Button>
      </form>
    </>
  );
}

export function InlineNotesPanel({
  environmentId,
  notes,
  activeNoteId,
  pendingCitation,
  question,
  onQuestionChange,
  followUpDrafts,
  onFollowUpDraftChange,
  cwd,
  onSelect,
  onClose,
  onCreate,
  onSend,
  onRespondToApproval,
  onRemove,
}: {
  environmentId: EnvironmentId;
  notes: readonly InlineNote[];
  activeNoteId: string | null;
  pendingCitation: AssistantCitation | null;
  question: string;
  onQuestionChange: (question: string) => void;
  followUpDrafts: Readonly<Record<string, string>>;
  onFollowUpDraftChange: (id: string, draft: string) => void;
  cwd: string | undefined;
  onSelect: (id: string | null) => void;
  onClose: () => void;
  onCreate: (question: string) => Promise<boolean>;
  onSend: (threadId: ThreadId, text: string) => Promise<boolean>;
  onRespondToApproval: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<boolean>;
  onRemove: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const activeNote = notes.find((note) => note.id === activeNoteId) ?? null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || creating) return;
    setCreating(true);
    try {
      await onCreate(text);
    } finally {
      setCreating(false);
    }
  };
  return (
    <aside
      aria-label="Response notes"
      className="absolute inset-y-0 end-0 z-30 flex min-h-0 w-[min(24rem,100vw)] shrink-0 flex-col border-s border-border bg-background shadow-lg md:static md:w-96 md:shadow-none"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <MessageSquareIcon className="size-4" /> Notes
        </span>
        <Button type="button" size="xs" variant="ghost" aria-label="Close notes" onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </div>
      {pendingCitation ? (
        <form onSubmit={submit} className="space-y-3 border-b border-border p-4">
          <blockquote className="max-h-24 overflow-y-auto border-s-2 border-primary/50 ps-3 text-sm text-muted-foreground">
            {pendingCitation.text}
          </blockquote>
          <label htmlFor="inline-note-question" className="sr-only">
            Question about selected text
          </label>
          <textarea
            id="inline-note-question"
            autoFocus
            value={question}
            onChange={(event) => onQuestionChange(event.target.value)}
            placeholder="Ask about this passage…"
            rows={3}
            maxLength={8_000}
            className="w-full resize-y rounded-md border border-border bg-background p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" size="sm" disabled={!question.trim() || creating}>
            Ask note agent
          </Button>
        </form>
      ) : null}
      {notes.length > 0 ? (
        <div className="flex flex-wrap gap-1 border-b border-border p-2" aria-label="Saved notes">
          {notes.map((note, index) => (
            <Button
              key={note.id}
              type="button"
              size="xs"
              variant={note.id === activeNoteId ? "secondary" : "ghost"}
              aria-expanded={note.id === activeNoteId}
              onClick={() => onSelect(note.id === activeNoteId ? null : note.id)}
              title={note.citation.text}
            >
              Note {index + 1}
            </Button>
          ))}
        </div>
      ) : null}
      {activeNote ? (
        <>
          <NoteConversation
            key={activeNote.id}
            note={activeNote}
            environmentId={environmentId}
            cwd={cwd}
            draft={followUpDrafts[activeNote.id] ?? ""}
            onDraftChange={(draft) => onFollowUpDraftChange(activeNote.id, draft)}
            onSend={onSend}
            onRespondToApproval={onRespondToApproval}
          />
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="m-2 self-start"
            onClick={() => onRemove(activeNote.id)}
          >
            Remove annotation
          </Button>
        </>
      ) : !pendingCitation ? (
        <p className="p-4 text-sm text-muted-foreground">
          Select text in an assistant response and choose Note.
        </p>
      ) : null}
    </aside>
  );
}
