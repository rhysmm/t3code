import { useAtomCommand } from "~/state/use-atom-command";
import type { EnvironmentId, PullRequestRef, PullRequestReviewVerdict } from "@t3tools/contracts";
import { CheckIcon, MessageSquareIcon, XCircleIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { useEffect, useState, type ReactNode, type RefObject } from "react";

import { m } from "~/i18n/messages";

import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { isCommentSubmitShortcut } from "../diffs/commentSubmitShortcut";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import { toastManager } from "../ui/toast";
import { readableFailure } from "./pullRequestDetail.logic";
import {
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";
import {
  PullRequestMarkdownTextarea,
  type PullRequestCompletionScope,
} from "./PullRequestMarkdownTextarea";

import type { ChangeRequestTermKind } from "./changeRequestTerm";

const VERDICTS: ReadonlyArray<{
  readonly value: PullRequestReviewVerdict;
  readonly label: string;
  readonly sent: (term: ChangeRequestTermKind) => string;
  readonly icon: ReactNode;
}> = [
  {
    value: "comment",
    label: msg("Comment", { $context: "review verdict" }),
    sent: () => m(msg("Review submitted")),
    icon: <MessageSquareIcon className="size-3" />,
  },
  {
    value: "approve",
    label: msg("Approve", { $context: "review verdict" }),
    sent: (term) =>
      m(
        msg(
          "{term, select, mr {Merge request} cr {Change request} other {Pull request}} approved",
          { term },
        ),
      ),
    icon: <CheckIcon className="size-3" />,
  },
  {
    value: "request-changes",
    label: msg("Request changes"),
    sent: () => m(msg("Changes requested")),
    icon: <XCircleIcon className="size-3" />,
  },
];

export function PullRequestReviewForm({
  environmentId,
  active,
  reference,
  headSha,
  completionScope,
  term,
  verdicts,
  requestChangesSummaryRequired,
  textareaRef,
  onSubmitted,
  onRefused,
}: {
  environmentId: EnvironmentId;
  /** False while the form stays mounted but hidden; dictation is cancelled then. */
  active: boolean;
  reference: PullRequestRef;
  /** The head on screen, which the review is pinned to. */
  headSha: string | undefined;
  completionScope: PullRequestCompletionScope | null;
  term: ChangeRequestTermKind;
  verdicts: ReadonlyArray<PullRequestReviewVerdict>;
  requestChangesSummaryRequired: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onSubmitted: () => void;
  onRefused: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const [requestedVerdict, setRequestedVerdict] = useState<PullRequestReviewVerdict>("comment");
  const comments = usePendingReviewComments(reference);
  const reviewKey = pullRequestReviewKey(reference);
  const pending = usePullRequestReviewStore((store) => store.pendingReviews.has(reviewKey));
  const hasCommentEdits = usePullRequestReviewStore(
    (store) => store.commentEdits[reviewKey] !== undefined,
  );
  const body = usePullRequestReviewStore((store) => store.summaries[reviewKey] ?? "");
  const setSummary = usePullRequestReviewStore((store) => store.setSummary);
  const speech = useTextFieldSpeech({
    environmentId,
    projectId: reference.projectId,
    ownerKey: JSON.stringify(["pr-review", environmentId, reviewKey]),
    text: body,
    textareaRef,
    onTextChange: (text) => setSummary(reviewKey, text),
    disabled: !active || pending,
  });
  const { cancel } = speech;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- discards a recording when the hidden form can no longer be submitted
  useEffect(() => {
    if (!active) cancel();
  }, [active, cancel]);
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });

  const offered = VERDICTS.filter((verdict) => verdicts.includes(verdict.value));
  const selectedVerdict =
    offered.find((verdict) => verdict.value === requestedVerdict) ?? offered[0];

  const submit = async (verdict: (typeof VERDICTS)[number], text: string) => {
    const store = usePullRequestReviewStore.getState();
    const submittedComments = store.drafts[reviewKey] ?? [];
    if (
      !canSubmit(verdict.value, text, submittedComments.length) ||
      !store.beginReviewSubmission(reviewKey)
    )
      return;
    try {
      const result = await submitReview({
        environmentId,
        input: {
          ...reference,
          ...(headSha === undefined ? {} : { expectedHeadSha: headSha }),
          verdict: verdict.value,
          body: text,
          comments: submittedComments,
        },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: m(msg("The review could not be submitted")),
          description: readableFailure(
            squashAtomCommandFailure(result),
            m(msg("The host refused the review. Your draft is still here to try again.")),
          ),
        });
        onRefused();
        return;
      }
      // Preserve new comments and summary edits made during submission.
      store.removeComments(
        reviewKey,
        submittedComments.map((comment) => comment.id),
      );
      store.clearSummary(reviewKey, text);
      toastManager.add({ type: "success", title: verdict.sent(term) });
    } finally {
      store.finishReviewSubmission(reviewKey);
    }
    onSubmitted();
  };

  // Forgejo requires a summary when requesting changes, even with inline comments.
  const canSubmit = (verdict: PullRequestReviewVerdict, summary: string, commentCount: number) =>
    verdict === "request-changes" && requestChangesSummaryRequired
      ? summary.trim().length > 0
      : verdict === "approve" || summary.trim().length > 0 || commentCount > 0;
  const placeholder =
    selectedVerdict === undefined || canSubmit(selectedVerdict.value, "", comments.length)
      ? gt("Summarize your review (optional)")
      : selectedVerdict.value === "request-changes" && requestChangesSummaryRequired
        ? gt("Summarize your review (required to request changes)")
        : gt("Summarize your review or add line comments");

  return (
    <>
      <PullRequestMarkdownTextarea
        ref={textareaRef}
        completionScope={completionScope}
        rows={3}
        readOnly={speech.freezesEditor}
        value={body}
        placeholder={placeholder}
        aria-label={gt("Review summary")}
        onValueChange={(next) => setSummary(reviewKey, next)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return;
          if (
            selectedVerdict !== undefined &&
            isCommentSubmitShortcut(event, body, pending || speech.preparing, true)
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (!hasCommentEdits)
              speech.submitAfterDictation((text) => void submit(selectedVerdict, text));
          }
        }}
      />
      {hasCommentEdits ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p role="status" className="text-xs text-muted-foreground">
            <T>Save or cancel your comment edits before submitting.</T>
          </p>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => usePullRequestReviewStore.getState().cancelCommentEdits(reviewKey)}
          >
            <T>Cancel edits</T>
          </Button>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <TextFieldSpeechControls speech={speech} disabled={pending} />
        {offered.length > 1 ? (
          <Select
            value={selectedVerdict?.value ?? null}
            disabled={pending}
            onValueChange={(value) => {
              if (value !== null) setRequestedVerdict(value);
            }}
          >
            <SelectTrigger size="xs" className="w-auto min-w-0" aria-label={gt("Review verdict")}>
              <span className="flex items-center gap-1.5">
                {selectedVerdict?.icon}
                {selectedVerdict ? resolve(selectedVerdict.label) : null}
              </span>
            </SelectTrigger>
            <SelectPopup side="top" alignItemWithTrigger={false}>
              {offered.map((verdict) => (
                <SelectItem key={verdict.value} value={verdict.value}>
                  <span className="flex items-center gap-1.5">
                    {verdict.icon}
                    {resolve(verdict.label)}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <Button
          size="xs"
          disabled={
            speech.preparing ||
            pending ||
            hasCommentEdits ||
            selectedVerdict === undefined ||
            (!canSubmit(selectedVerdict.value, body, comments.length) && !speech.blocksSubmission)
          }
          onClick={() => {
            if (selectedVerdict !== undefined && !hasCommentEdits)
              speech.submitAfterDictation((text) => void submit(selectedVerdict, text));
          }}
        >
          {pending ? gt("Submitting...") : gt("Submit review")}
        </Button>
      </div>
    </>
  );
}
