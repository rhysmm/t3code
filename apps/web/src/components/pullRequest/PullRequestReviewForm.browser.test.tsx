import { createRef } from "react";
import { EnvironmentId, ProjectId, type PullRequestRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { PullRequestReviewForm } from "./PullRequestReviewForm";
import { pullRequestReviewKey, usePullRequestReviewStore } from "./pullRequestReviewStore";

const mocks = vi.hoisted(() => ({
  submit: vi.fn().mockResolvedValue({ _tag: "Success" }),
  queue: vi.fn<(submit: (text: string) => void) => void>(),
}));
vi.mock("~/speech/useTextFieldSpeech", () => ({
  TextFieldSpeechControls: () => null,
  useTextFieldSpeech: () => ({
    blocksSubmission: true,
    cancel: vi.fn(),
    submitAfterDictation: mocks.queue,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.submit }));
vi.mock(import("~/state/pullRequests"), async (original) => ({
  ...(await original()),
  pullRequestEnvironment: { submitReview: {} } as never,
}));

function setup(number: number) {
  mocks.submit.mockClear();
  mocks.queue.mockClear();
  const reference = { projectId: ProjectId.make("test"), repository: "test/repo", number };
  const key = pullRequestReviewKey(reference);
  const store = usePullRequestReviewStore.getState();
  store.clear(key);
  return { reference, key, store };
}

function renderForm(reference: PullRequestRef) {
  return render(
    <PullRequestReviewForm
      active
      environmentId={EnvironmentId.make("test")}
      reference={reference}
      completionScope={null}
      term="pr"
      verdicts={["comment"]}
      requestChangesSummaryRequired={false}
      textareaRef={createRef()}
      onSubmitted={vi.fn()}
    />,
  );
}

it("submits only the line comments still in the draft when dictation finishes", async () => {
  const { reference, key, store } = setup(1);
  store.addComment(key, {
    id: "removed",
    body: "Do not post",
    path: "a.ts",
    position: { kind: "added", newLine: 1 },
  });
  await using screen = await renderForm(reference);
  await screen.getByRole("button", { name: "Submit review" }).click();
  await act(() => store.clear(key));
  await act(() => mocks.queue.mock.calls[0]![0]("Dictated summary"));
  expect(mocks.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ body: "Dictated summary", comments: [] }),
    }),
  );
});

it("blocks submitting while a pending comment is being edited", async () => {
  const { reference, key, store } = setup(2);
  const comment = {
    id: "pending",
    body: "Saved comment",
    path: "a.ts",
    position: { kind: "added" as const, newLine: 1 },
  };
  store.addComment(key, comment);
  await using screen = await renderForm(reference);
  const submit = screen.getByRole("button", { name: "Submit review" });
  await submit.click();

  await act(() => {
    store.beginCommentEdit(key, comment.id);
    store.setCommentEditBody(key, comment.id, "Unsaved edits");
  });
  await expect.element(submit).toBeDisabled();
  await expect
    .element(screen.getByText("Save or cancel your comment edits before submitting."))
    .toBeVisible();
  await screen.getByRole("textbox", { name: "Review summary" }).click();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(mocks.queue).toHaveBeenCalledTimes(1);
  await act(() => mocks.queue.mock.calls[0]![0]("Dictated summary"));
  expect(mocks.submit).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Cancel edits" }).click();
  await expect.element(submit).toBeEnabled();
  await submit.click();
  await act(() => mocks.queue.mock.calls[1]![0]("Dictated summary"));
  expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      input: expect.objectContaining({ comments: [comment] }),
    }),
  );
});
