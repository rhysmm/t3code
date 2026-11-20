import { beforeEach, describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";

import {
  type PendingReviewComment,
  pullRequestReviewKey,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

function comment(id: string, body = id): PendingReviewComment {
  return { id, body, path: "src/app.ts", position: { kind: "added", newLine: 1 } };
}

describe("pull request review drafts", () => {
  beforeEach(() => {
    usePullRequestReviewStore.setState({
      drafts: {},
      summaries: {},
      commentEdits: {},
      pendingReviews: new Set(),
      replies: {},
      pendingReplies: new Set(),
    });
  });

  it("saves an edit in place and removes only the line comments included in a submission", () => {
    const store = usePullRequestReviewStore.getState();
    store.addComment("review-a", comment("submitted"));
    const edited = {
      ...comment("edited"),
      oldPath: "src/old-app.ts",
      startPosition: { kind: "added" as const, newLine: 1 },
      position: { kind: "added" as const, newLine: 3 },
    };
    store.addComment("review-a", edited);
    store.beginCommentEdit("review-a", "edited");
    store.saveCommentEdit("review-a", "edited", "Revised");
    const snapshot = usePullRequestReviewStore.getState().drafts["review-a"] ?? [];
    expect(snapshot).toEqual([comment("submitted"), { ...edited, body: "Revised" }]);

    expect(store.beginReviewSubmission("review-a")).toBe(true);
    store.addComment("review-a", comment("added-in-flight"));
    store.removeComments(
      "review-a",
      snapshot.map((entry) => entry.id),
    );
    store.finishReviewSubmission("review-a");

    expect(usePullRequestReviewStore.getState().drafts["review-a"]).toEqual([
      comment("added-in-flight"),
    ]);
  });

  it("guards edits and review submission and closes deleted editors", () => {
    const store = usePullRequestReviewStore.getState();
    store.addComment("review-a", comment("first"));
    store.addComment("review-a", comment("second"));
    store.addComment("review-b", comment("other"));

    expect(store.beginReviewSubmission("review-a")).toBe(true);
    expect(store.beginReviewSubmission("review-a")).toBe(false);
    expect(store.beginCommentEdit("review-a", "first")).toBe(false);
    expect(store.beginCommentEdit("review-b", "other")).toBe(true);
    store.finishReviewSubmission("review-a");

    expect(store.beginCommentEdit("review-a", "first")).toBe(true);
    expect(store.beginCommentEdit("review-a", "second")).toBe(true);
    store.setCommentEditBody("review-a", "second", "Revised");
    expect(store.beginReviewSubmission("review-a")).toBe(false);

    store.removeComment("review-a", "first");
    store.setCommentEditBody("review-a", "first", "Stale editor");
    expect(usePullRequestReviewStore.getState().commentEdits["review-a"]).toEqual({
      second: "Revised",
    });
    store.clear("review-a");
    expect(usePullRequestReviewStore.getState().commentEdits).toEqual({
      "review-b": { other: "other" },
    });
    expect(store.beginReviewSubmission("review-a")).toBe(true);
  });

  it("keeps drafts on different hosts separate when a thread reviews the same repository and number", () => {
    const reference = {
      projectId: ProjectId.make("project-a"),
      repository: "owner/repo",
      number: 7,
    };
    const publicKey = pullRequestReviewKey({ ...reference, host: "github.com" });
    const enterpriseKey = pullRequestReviewKey({ ...reference, host: "github.example.com" });
    const store = usePullRequestReviewStore.getState();
    store.addComment(publicKey, comment("public"));
    store.setSummary(publicKey, "Public review");

    expect(usePullRequestReviewStore.getState().drafts[enterpriseKey]).toBeUndefined();
    expect(usePullRequestReviewStore.getState().summaries[enterpriseKey]).toBeUndefined();

    store.addComment(enterpriseKey, comment("enterprise"));
    store.setSummary(enterpriseKey, "Enterprise review");
    store.clear(enterpriseKey);
    store.clearSummary(enterpriseKey, "Enterprise review");

    expect(usePullRequestReviewStore.getState().drafts[publicKey]).toEqual([comment("public")]);
    expect(usePullRequestReviewStore.getState().summaries[publicKey]).toBe("Public review");
  });

  it("does not clear a summary revised while submission is in flight", () => {
    const store = usePullRequestReviewStore.getState();
    store.setSummary("review-a", "Submitted body");
    usePullRequestReviewStore.getState().setSummary("review-a", "Revised body");
    usePullRequestReviewStore.getState().clearSummary("review-a", "Submitted body");

    expect(usePullRequestReviewStore.getState().summaries["review-a"]).toBe("Revised body");
  });

  it("guards an in-flight reply across editors and keeps text revised during submission", () => {
    const store = usePullRequestReviewStore.getState();
    store.setReply("thread-a", "Submitted reply");
    expect(store.beginReply("thread-a")).toBe(true);
    expect(usePullRequestReviewStore.getState().beginReply("thread-a")).toBe(false);
    store.setReply("thread-a", "Revised reply");
    store.clearReply("thread-a", "Submitted reply");
    store.finishReply("thread-a");

    expect(usePullRequestReviewStore.getState().replies["thread-a"]).toBe("Revised reply");
    expect(store.beginReply("thread-a")).toBe(true);
  });
});
