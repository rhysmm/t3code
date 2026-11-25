import type { SelectedLineRange } from "@pierre/diffs";
import { type PullRequestRef, PullRequestReviewCommentDraft } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { randomUUID } from "../../lib/utils";

export type PendingReviewComment = PullRequestReviewCommentDraft & { readonly id: string };

export interface InlineReviewDraftAnchor extends Omit<PullRequestReviewCommentDraft, "body"> {
  readonly fileIdentity: string;
  readonly fileVersion: number;
  readonly range: SelectedLineRange;
}

interface InlineReviewDraft {
  readonly anchor: InlineReviewDraftAnchor;
  readonly body: string;
}

type PendingCommentEdits = Readonly<Record<string, Readonly<Record<string, string>>>>;

function withoutCommentEdit(edits: PendingCommentEdits, key: string, commentId: string) {
  const reviewEdits = edits[key];
  if (reviewEdits?.[commentId] === undefined) return edits;
  const { [commentId]: _removed, ...remaining } = reviewEdits;
  if (Object.keys(remaining).length > 0) return { ...edits, [key]: remaining };
  const { [key]: _review, ...otherReviews } = edits;
  return otherReviews;
}

// Content-derived ids can collide across comments, and a counter restarts below persisted ids.
export function nextPendingReviewCommentId(): string {
  return `pending-review-comment-${randomUUID()}`;
}

export function pullRequestReviewKey(reference: PullRequestRef): string {
  return JSON.stringify([
    reference.projectId,
    reference.host?.toLowerCase() ?? null,
    reference.repository.toLowerCase(),
    reference.number,
  ]);
}

interface PullRequestReviewStoreState {
  readonly drafts: Readonly<Record<string, ReadonlyArray<PendingReviewComment>>>;
  readonly summaries: Readonly<Record<string, string>>;
  readonly commentEdits: PendingCommentEdits;
  readonly pendingReviews: ReadonlySet<string>;
  readonly inlineDrafts: Readonly<Record<string, InlineReviewDraft>>;
  readonly replies: Readonly<Record<string, string>>;
  readonly pendingReplies: ReadonlySet<string>;
  readonly openInlineDraft: (key: string, anchor: InlineReviewDraftAnchor) => void;
  readonly setInlineDraftBody: (key: string, anchor: InlineReviewDraftAnchor, body: string) => void;
  readonly clearInlineDraft: (key: string, anchor: InlineReviewDraftAnchor) => void;
  readonly setReply: (key: string, body: string) => void;
  readonly clearReply: (key: string, expectedBody?: string) => void;
  readonly beginReply: (key: string) => boolean;
  readonly finishReply: (key: string) => void;
  readonly addComment: (key: string, comment: PendingReviewComment) => void;
  readonly beginCommentEdit: (key: string, commentId: string) => boolean;
  readonly setCommentEditBody: (key: string, commentId: string, body: string) => void;
  readonly saveCommentEdit: (key: string, commentId: string, body: string) => void;
  readonly cancelCommentEdit: (key: string, commentId: string) => void;
  readonly cancelCommentEdits: (key: string) => void;
  readonly beginReviewSubmission: (key: string) => boolean;
  readonly finishReviewSubmission: (key: string) => void;
  readonly removeComment: (key: string, commentId: string) => void;
  readonly removeComments: (key: string, commentIds: ReadonlyArray<string>) => void;
  readonly clear: (key: string) => void;
  readonly setSummary: (key: string, body: string) => void;
  readonly clearSummary: (key: string, submittedBody: string) => void;
}

const EMPTY: ReadonlyArray<PendingReviewComment> = [];

const isCommentDraft = Schema.is(PullRequestReviewCommentDraft);
const isPendingComment = (entry: unknown): entry is PendingReviewComment =>
  isCommentDraft(entry) && typeof (entry as { id?: unknown }).id === "string";

type PersistedReviewDrafts = Pick<PullRequestReviewStoreState, "drafts" | "summaries">;

function restoreReviewDrafts(persisted: unknown): PersistedReviewDrafts {
  const candidate = persisted as Partial<Record<keyof PersistedReviewDrafts, unknown>> | null;
  const drafts: Record<string, ReadonlyArray<PendingReviewComment>> = {};
  for (const [key, comments] of Object.entries(candidate?.drafts ?? {})) {
    const valid = Array.isArray(comments) ? comments.filter(isPendingComment) : [];
    if (valid.length > 0) drafts[key] = valid;
  }
  const summaries: Record<string, string> = {};
  for (const [key, body] of Object.entries(candidate?.summaries ?? {})) {
    if (typeof body === "string") summaries[key] = body;
  }
  return { drafts, summaries };
}

export const usePullRequestReviewStore = create<PullRequestReviewStoreState>()(
  persist(
    (set, get) => ({
      drafts: {},
      summaries: {},
      commentEdits: {},
      pendingReviews: new Set(),
      inlineDrafts: {},
      replies: {},
      pendingReplies: new Set(),
      openInlineDraft: (key, anchor) =>
        set((state) =>
          state.inlineDrafts[key] === undefined
            ? { inlineDrafts: { ...state.inlineDrafts, [key]: { anchor, body: "" } } }
            : state,
        ),
      setInlineDraftBody: (key, anchor, body) =>
        set((state) =>
          state.inlineDrafts[key]?.anchor === anchor
            ? { inlineDrafts: { ...state.inlineDrafts, [key]: { anchor, body } } }
            : state,
        ),
      clearInlineDraft: (key, anchor) =>
        set((state) => {
          if (state.inlineDrafts[key]?.anchor !== anchor) return state;
          const { [key]: _removed, ...remaining } = state.inlineDrafts;
          return { inlineDrafts: remaining };
        }),
      setReply: (key, body) => set((state) => ({ replies: { ...state.replies, [key]: body } })),
      clearReply: (key, expectedBody) =>
        set((state) => {
          if (expectedBody !== undefined && (state.replies[key] ?? "") !== expectedBody)
            return state;
          const { [key]: _removed, ...remaining } = state.replies;
          return { replies: remaining };
        }),
      beginReply: (key) => {
        const pending = get().pendingReplies;
        if (pending.has(key)) return false;
        set({ pendingReplies: new Set([...pending, key]) });
        return true;
      },
      finishReply: (key) =>
        set((state) => {
          const pending = new Set(state.pendingReplies);
          pending.delete(key);
          return { pendingReplies: pending };
        }),
      addComment: (key, comment) =>
        set((state) => ({
          drafts: { ...state.drafts, [key]: [...(state.drafts[key] ?? EMPTY), comment] },
        })),
      beginCommentEdit: (key, commentId) => {
        const { commentEdits, drafts, pendingReviews } = get();
        if (pendingReviews.has(key) || commentEdits[key]?.[commentId] !== undefined) return false;
        const comment = drafts[key]?.find((entry) => entry.id === commentId);
        if (!comment) return false;
        set({
          commentEdits: {
            ...commentEdits,
            [key]: { ...commentEdits[key], [commentId]: comment.body },
          },
        });
        return true;
      },
      setCommentEditBody: (key, commentId, body) =>
        set((state) =>
          state.commentEdits[key]?.[commentId] === undefined
            ? state
            : {
                commentEdits: {
                  ...state.commentEdits,
                  [key]: { ...state.commentEdits[key], [commentId]: body },
                },
              },
        ),
      saveCommentEdit: (key, commentId, body) =>
        set((state) => {
          const comments = state.drafts[key];
          if (!comments || state.commentEdits[key]?.[commentId] === undefined) return state;
          return {
            drafts: {
              ...state.drafts,
              [key]: comments.map((entry) => (entry.id === commentId ? { ...entry, body } : entry)),
            },
            commentEdits: withoutCommentEdit(state.commentEdits, key, commentId),
          };
        }),
      cancelCommentEdit: (key, commentId) =>
        set((state) => ({ commentEdits: withoutCommentEdit(state.commentEdits, key, commentId) })),
      cancelCommentEdits: (key) =>
        set((state) => {
          const { [key]: _removed, ...commentEdits } = state.commentEdits;
          return { commentEdits };
        }),
      beginReviewSubmission: (key) => {
        const { commentEdits, pendingReviews } = get();
        if (commentEdits[key] !== undefined || pendingReviews.has(key)) return false;
        set({ pendingReviews: new Set([...pendingReviews, key]) });
        return true;
      },
      finishReviewSubmission: (key) =>
        set((state) => {
          const pendingReviews = new Set(state.pendingReviews);
          pendingReviews.delete(key);
          return { pendingReviews };
        }),
      removeComment: (key, commentId) =>
        set((state) => {
          const { [key]: comments, ...drafts } = state.drafts;
          const remaining = (comments ?? EMPTY).filter((entry) => entry.id !== commentId);
          return {
            drafts: remaining.length > 0 ? { ...drafts, [key]: remaining } : drafts,
            commentEdits: withoutCommentEdit(state.commentEdits, key, commentId),
          };
        }),
      removeComments: (key, commentIds) =>
        set((state) => {
          const submitted = new Set(commentIds);
          const remaining = (state.drafts[key] ?? EMPTY).filter(
            (entry) => !submitted.has(entry.id),
          );
          if (remaining.length > 0) return { drafts: { ...state.drafts, [key]: remaining } };
          const { [key]: _removed, ...rest } = state.drafts;
          return { drafts: rest };
        }),
      clear: (key) =>
        set((state) => {
          const { [key]: _draft, ...drafts } = state.drafts;
          const { [key]: _edits, ...commentEdits } = state.commentEdits;
          return { drafts, commentEdits };
        }),
      setSummary: (key, body) =>
        set((state) => ({ summaries: { ...state.summaries, [key]: body } })),
      clearSummary: (key, submittedBody) =>
        set((state) => {
          // Keep summary edits made during submission; the textarea stays editable.
          if (state.summaries[key] !== submittedBody) return state;
          const { [key]: _removed, ...rest } = state.summaries;
          return { summaries: rest };
        }),
    }),
    {
      name: "t3code:pull-request-review-drafts:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof localStorage !== "undefined" ? localStorage : undefined),
      ),
      partialize: ({ drafts, summaries }) => ({ drafts, summaries }),
      merge: (persisted, current) => ({ ...current, ...restoreReviewDrafts(persisted) }),
    },
  ),
);

export function usePendingReviewComments(
  reference: PullRequestRef,
): ReadonlyArray<PendingReviewComment> {
  return usePullRequestReviewStore(
    (store) => store.drafts[pullRequestReviewKey(reference)] ?? EMPTY,
  );
}
