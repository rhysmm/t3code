import { createContext, useContext, useMemo, useRef, useState } from "react";
import * as Option from "effect/Option";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isThreadSessionRunning,
  requestOlderThreadTurns,
} from "@t3tools/client-runtime/state/threads";
import type {
  ApprovalRequestId,
  EnvironmentId,
  OrchestrationMessage,
  ProviderApprovalDecision,
  PullRequestDetail,
  PullRequestRef,
  ReviewCommentContextRecord,
  MessageId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { asKnownContextRecord, reviewCommentContextRecord } from "~/lib/composerContextRecords";
import { newMessageId, randomUUID } from "~/lib/utils";
import { useQueuedMessageStore, useQueuedMessages } from "~/queuedMessageStore";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { waitForThreadShell } from "~/state/entities";
import { threadEnvironment, useEnvironmentThread } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { DiffCommentAnnotation } from "../diffs/DiffCommentAnnotation";
import { ComposerPendingApprovalActions } from "../chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "../chat/ComposerPendingApprovalPanel";
import { sendQueuedMessage } from "../chat/sendQueuedMessage";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { usePullRequestReviewThread } from "./usePullRequestReviewThread";

export interface InlineReviewDiscussion {
  readonly id: string;
  readonly record: ReviewCommentContextRecord;
  readonly sourceThread?: ScopedThreadRef | null;
  readonly cwd?: string;
  readonly messages: ReadonlyArray<{
    id: string;
    role: "user" | "assistant";
    text: string;
    pending?: "preparing" | "queued" | "sending" | "failed";
    queueId?: string;
    localId?: string;
  }>;
}

/** Each question carries its anchor; thread history stores the answers. */
function collectDiscussions(messages: ReadonlyArray<OrchestrationMessage>) {
  const discussions = new Map<string, InlineReviewDiscussion>();
  let current: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      const record = message.context?.records
        .map(asKnownContextRecord)
        .find(
          (record): record is ReviewCommentContextRecord =>
            record?.kind === "review-comment" && record.inlineConversation !== undefined,
        );
      current = record?.inlineConversation?.id ?? null;
      if (record && current) {
        const previous = discussions.get(current);
        discussions.set(current, {
          id: current,
          record: previous?.record ?? record,
          messages: [
            ...(previous?.messages ?? []),
            { id: message.id, role: "user", text: record.text },
          ],
        });
      }
    } else if (current && message.role === "assistant") {
      const discussion = discussions.get(current);
      if (discussion)
        discussions.set(current, {
          ...discussion,
          messages: [
            ...discussion.messages,
            { id: message.id, role: "assistant", text: message.text },
          ],
        });
    }
  }
  return { discussions: [...discussions.values()], activeId: current };
}

export function useInlinePullRequestChat(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
  detail: PullRequestDetail,
) {
  const review = usePullRequestReviewThread(environmentId, reference, "pr-questions");
  const legacyReview = usePullRequestReviewThread(environmentId, reference);
  const state = useEnvironmentThread(
    review.threadRef?.environmentId ?? null,
    review.threadRef?.threadId ?? null,
  );
  const legacyState = useEnvironmentThread(
    legacyReview.threadRef?.environmentId ?? null,
    legacyReview.threadRef?.threadId ?? null,
  );
  const thread = Option.getOrNull(state.data);
  const legacyThread = Option.getOrNull(legacyState.data);
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const approve = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const cancelled = useRef(new Set<string>());
  const [preparing, setPreparing] = useState<
    Record<
      string,
      {
        record: ReviewCommentContextRecord;
        messageId: MessageId;
        queueId?: string;
        failed?: boolean;
      }
    >
  >({});
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadKey = review.threadRef ? scopedThreadKey(review.threadRef) : "";
  const queued = useQueuedMessages(threadKey);
  const savedMessageIds = useMemo(
    () => new Set(thread?.messages.map((message) => message.id) ?? []),
    [thread?.messages],
  );
  const visiblePreparing = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(preparing).filter(([, entry]) => !savedMessageIds.has(entry.messageId)),
      ),
    [preparing, savedMessageIds],
  );
  const { discussions: savedDiscussions, activeId } = useMemo(() => {
    const collected = collectDiscussions(thread?.messages ?? []);
    return {
      ...collected,
      discussions: collected.discussions.map((discussion) => ({
        ...discussion,
        sourceThread: review.threadRef,
        cwd: thread?.worktreePath ?? detail.workspaceRoot,
      })),
    };
  }, [thread?.messages, thread?.worktreePath, review.threadRef, detail.workspaceRoot]);
  const legacyDiscussions = useMemo(
    () =>
      collectDiscussions(legacyThread?.messages ?? []).discussions.map((discussion) => ({
        ...discussion,
        sourceThread: legacyReview.threadRef,
        cwd: legacyThread?.worktreePath ?? detail.workspaceRoot,
      })),
    [
      legacyThread?.messages,
      legacyThread?.worktreePath,
      legacyReview.threadRef,
      detail.workspaceRoot,
    ],
  );
  const discussions = useMemo(() => {
    const byId = new Map<string, InlineReviewDiscussion>();
    for (const discussion of [...legacyDiscussions, ...savedDiscussions]) {
      const existing = byId.get(discussion.id);
      byId.set(
        discussion.id,
        existing
          ? { ...discussion, messages: [...existing.messages, ...discussion.messages] }
          : discussion,
      );
    }
    for (const pending of [
      ...queued.flatMap((entry) =>
        entry.inlineReview
          ? [
              {
                record: entry.inlineReview.record,
                messageId: entry.inlineReview.messageId,
                pending: entry.holdUntilUserAction
                  ? ("failed" as const)
                  : entry.sending
                    ? ("sending" as const)
                    : ("queued" as const),
                queueId: entry.id,
                localId: undefined,
              },
            ]
          : [],
      ),
      ...Object.entries(visiblePreparing).map(([localId, entry]) => ({
        record: entry.record,
        messageId: entry.messageId,
        pending: entry.failed
          ? ("failed" as const)
          : entry.queueId
            ? queued.some((question) => question.id === entry.queueId)
              ? ("queued" as const)
              : ("sending" as const)
            : ("preparing" as const),
        queueId: entry.queueId,
        localId,
      })),
    ]) {
      const conversationId = pending.record.inlineConversation?.id;
      if (!conversationId) continue;
      const existing = byId.get(conversationId);
      if (existing?.messages.some((message) => message.id === pending.messageId)) continue;
      const question = {
        id: pending.messageId,
        role: "user" as const,
        text: pending.record.text,
        pending: pending.pending,
        ...(pending.queueId ? { queueId: pending.queueId } : {}),
        ...(pending.localId ? { localId: pending.localId } : {}),
      };
      byId.set(conversationId, {
        id: conversationId,
        record: existing?.record ?? pending.record,
        messages: [...(existing?.messages ?? []), question],
      });
    }
    return [...byId.values()];
  }, [legacyDiscussions, savedDiscussions, visiblePreparing, queued]);
  const requests = useMemo(
    () => derivePendingRequests(thread?.activities ?? []),
    [thread?.activities],
  );
  const busy =
    isThreadSessionRunning(thread?.session ?? null) || thread?.latestTurn?.state === "running";

  const send = async (record: ReviewCommentContextRecord, question: string) => {
    const text = question.trim();
    if (!text) return false;
    const contextRecord = { ...record, text };
    const localId = randomUUID();
    const messageId = newMessageId();
    setPreparing((current) => ({
      ...Object.fromEntries(
        Object.entries(current).filter(([, entry]) => !savedMessageIds.has(entry.messageId)),
      ),
      [localId]: { record: contextRecord, messageId },
    }));
    setError(null);
    void (async () => {
      try {
        const target = await review.ensure(detail);
        if (cancelled.current.delete(localId)) return;
        const shell = await waitForThreadShell(target);
        if (cancelled.current.delete(localId)) return;
        const queuedQuestion = useQueuedMessageStore.getState().enqueue(scopedThreadKey(target), {
          prompt: text,
          images: [],
          files: [],
          terminalContexts: [],
          previewAnnotations: [],
          reviewComments: [],
          inlineReview: { record: contextRecord, messageId, detailUrl: detail.url },
          waitForTurnEnd: true,
          sendSettings: {
            modelSelection: shell.modelSelection,
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
            promptEffort: null,
          },
          queuedAfterToolActivityId: null,
          createdAt: new Date().toISOString(),
        });
        setPreparing((current) => ({
          ...current,
          [localId]: { record: contextRecord, messageId, queueId: queuedQuestion.id },
        }));
      } catch (cause) {
        if (!cancelled.current.delete(localId)) {
          setError(cause instanceof Error ? cause.message : "Could not queue the question.");
          setPreparing((current) => ({
            ...current,
            [localId]: { record: contextRecord, messageId, failed: true },
          }));
        }
      }
    })();
    return true;
  };

  const ask = async (comment: ReviewCommentContext, commitOid: string | null) => {
    if (!detail.headSha || !comment.selection) {
      setError("Refresh the pull request before asking about these lines.");
      return false;
    }
    return send(
      {
        ...reviewCommentContextRecord(comment),
        inlineConversation: {
          id: randomUUID(),
          headSha: detail.headSha,
          commitOid,
          side: comment.selection.endSide,
          line: comment.selection.end,
        },
      },
      comment.text,
    );
  };
  const cancelQuestion = (messageId: string, queueId?: string, localId?: string) => {
    if (queueId && review.threadRef)
      useQueuedMessageStore.getState().remove(scopedThreadKey(review.threadRef), queueId);
    if (localId && !queueId) cancelled.current.add(localId);
    setPreparing((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([, entry]) => entry.messageId !== messageId),
      ),
    );
  };
  const retryQuestion = (queueId: string) => {
    if (!review.threadRef || busy || state.status !== "live" || queued[0]?.id !== queueId) return;
    void sendQueuedMessage(review.threadRef, queueId);
  };
  const retryPreparation = (localId: string) => {
    const pending = preparing[localId];
    if (!pending?.failed) return;
    setPreparing((current) => {
      const next = { ...current };
      delete next[localId];
      return next;
    });
    void send(pending.record, pending.record.text);
  };
  const stop = async () => {
    if (!review.threadRef) return;
    const result = await interrupt({
      environmentId,
      input: { threadId: review.threadRef.threadId },
    });
    if (result._tag === "Failure") setError(failureMessage(squashAtomCommandFailure(result)));
  };
  const respond = async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
    if (!review.threadRef || responding) return;
    setResponding(true);
    try {
      const result = await approve({
        environmentId,
        input: { threadId: review.threadRef.threadId, requestId, decision },
      });
      if (result._tag === "Failure") setError(failureMessage(squashAtomCommandFailure(result)));
    } finally {
      setResponding(false);
    }
  };
  const page = Option.getOrNull(state.page);
  return {
    discussions,
    activeId,
    busy,
    submitting: Object.values(visiblePreparing).some((entry) => !entry.queueId && !entry.failed),
    responding,
    requests,
    ask,
    cancelQuestion,
    retryQuestion,
    retryPreparation,
    stop,
    respond,
    error: error ?? Option.getOrNull(state.error),
    sessionError: thread?.session?.lastError,
    threadRef: review.threadRef,
    headSha: review.headSha,
    hasOlder: page?.hasMore ?? false,
    loadingOlder: page?.loadingOlder ?? false,
    loadOlder: () => {
      if (review.threadRef) requestOlderThreadTurns(environmentId, review.threadRef.threadId);
    },
    environmentId,
    cwd: thread?.worktreePath ?? detail.workspaceRoot,
  };
}

function failureMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "The agent request failed.";
}

type InlineReviewChat = ReturnType<typeof useInlinePullRequestChat>;
export const InlineReviewChatContext = createContext<InlineReviewChat | null>(null);

/** Reads live answers through context without changing diff annotation versions. */
export function PullRequestInlineChat({ id }: { id: string }) {
  const chat = useContext(InlineReviewChatContext);
  const [collapsed, setCollapsed] = useState(false);
  const discussion = chat?.discussions.find((discussion) => discussion.id === id);
  if (!chat || !discussion) return null;
  const active = chat.activeId === id;
  const approval = active ? chat.requests.approvals[0] : undefined;
  return (
    <section
      className="my-2 min-w-0 rounded-md border border-border bg-background font-sans text-foreground"
      aria-label={`Agent discussion on ${discussion.record.filePath}:${discussion.record.rangeLabel}`}
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
        <span>Agent · local conversation · {discussion.record.rangeLabel}</span>
        <Button size="xs" variant="ghost" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? "Expand" : "Collapse"}
        </Button>
      </div>
      {!collapsed ? (
        <div className="space-y-3 p-3">
          {discussion.messages.map((message) => (
            <div key={message.id}>
              <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {message.role === "user" ? "You" : "Agent"}
                  {message.pending ? ` · ${message.pending}` : ""}
                </span>
                {message.pending ? (
                  <div className="flex gap-1">
                    {message.pending === "failed" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          if (message.queueId) chat.retryQuestion(message.queueId);
                          else if (message.localId) chat.retryPreparation(message.localId);
                        }}
                      >
                        Retry
                      </Button>
                    ) : null}
                    {message.pending !== "sending" ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          chat.cancelQuestion(message.id, message.queueId, message.localId)
                        }
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <PullRequestMarkdown
                text={message.text}
                cwd={discussion.cwd ?? chat.cwd}
                environmentId={chat.environmentId}
                threadRef={discussion.sourceThread ?? chat.threadRef}
              />
            </div>
          ))}
          {active && chat.busy ? (
            <div
              className="flex items-center justify-between text-xs text-muted-foreground"
              role="status"
            >
              <span>{chat.submitting ? "Sending…" : "Agent is working…"}</span>
              <Button size="xs" variant="outline" onClick={() => void chat.stop()}>
                Stop
              </Button>
            </div>
          ) : null}
          {active && chat.sessionError ? (
            <p role="alert" className="text-xs text-destructive">
              {chat.sessionError}
            </p>
          ) : null}
          {approval ? (
            <div className="space-y-2 rounded border p-2">
              <ComposerPendingApprovalPanel
                approval={approval}
                pendingCount={chat.requests.approvals.length}
              />
              <div className="flex flex-wrap gap-2">
                <ComposerPendingApprovalActions
                  requestId={approval.requestId}
                  options={approval.options}
                  isResponding={chat.responding}
                  onRespondToApproval={chat.respond}
                />
              </div>
            </div>
          ) : null}
          {active && chat.requests.userInputs.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              The agent needs more input. Stop this question and ask again with more detail.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">Only visible in T3</p>
        </div>
      ) : null}
    </section>
  );
}

export function PullRequestInlineChatDraft({
  rangeLabel,
  commitOid,
  onCancel,
  onSubmit,
  onAddToReview,
}: {
  rangeLabel: string;
  commitOid: string | null;
  onCancel: () => void;
  onSubmit: (text: string, send: (comment: ReviewCommentContext) => Promise<boolean>) => void;
  onAddToReview?: ((text: string) => void) | undefined;
}) {
  const chat = useContext(InlineReviewChatContext);
  if (!chat) return null;
  return (
    <DiffCommentAnnotation
      kind="draft"
      rangeLabel={rangeLabel}
      text=""
      placeholder="Ask the agent about these lines…"
      submitLabel={chat.busy || chat.submitting ? "Queue question" : "Ask agent"}
      pending={false}
      onCancel={onCancel}
      onComment={(text) => onSubmit(text, (comment) => chat.ask(comment, commitOid))}
      {...(onAddToReview
        ? { secondaryAction: { label: "Add to review", onAction: onAddToReview } }
        : {})}
    />
  );
}
