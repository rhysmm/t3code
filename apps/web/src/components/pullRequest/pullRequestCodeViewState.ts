import type { PullRequestDiffFolds } from "@t3tools/client-runtime/pull-request-diff-fold";
import type { EnvironmentId, PullRequestRef, ScopedThreadRef } from "@t3tools/contracts";
import { pullRequestReviewKey } from "./pullRequestReviewStore";

interface PullRequestCodeViewOptions {
  readonly folds: PullRequestDiffFolds;
}

export interface PullRequestCodeDisplayOptions {
  readonly wordWrapOverride: boolean | null;
  readonly ignoreWhitespaceOverride: boolean | null;
}

export function pullRequestCodeViewKey(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
  threadRef: ScopedThreadRef | null,
) {
  return JSON.stringify([
    environmentId,
    pullRequestReviewKey(reference),
    threadRef === null ? null : [threadRef.environmentId, threadRef.threadId],
  ]);
}

export const pullRequestCodeViewOptions = new Map<string, PullRequestCodeViewOptions>();
export const pullRequestCodeDisplayOptions = new Map<string, PullRequestCodeDisplayOptions>();
export const pullRequestCodeViewCommits = new Map<string, string>();
export const condensedPullRequestCodeViews = new Set<string>();
