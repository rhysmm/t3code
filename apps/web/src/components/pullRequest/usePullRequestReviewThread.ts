import { useMemo, useRef, useState } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type PullRequestDetail,
  type PullRequestRef,
  type ScopedThreadRef,
  type ThreadPurpose,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useComposerDraftStore } from "../../composerDraftStore";
import { newProjectId, newThreadId } from "../../lib/utils";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { readProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { gitEnvironment } from "../../state/git";
import { projectEnvironment } from "../../state/projects";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** Review chats are ordinary durable threads, distinguished by their isolated review branch. */
export function usePullRequestReviewThread(
  environmentId: EnvironmentId | null,
  reference: PullRequestRef | null,
  purpose: ThreadPurpose = "chat",
) {
  const threads = useThreadShells();
  const configs = useServerConfigs();
  const prepare = useAtomCommand(gitEnvironment.preparePullRequestThread, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const link = useAtomCommand(threadEnvironment.linkPullRequest, { reportFailure: false });
  const [opened, setOpened] = useState<Record<string, { ref: ScopedThreadRef; createdAt: string }>>(
    {},
  );
  const pending = useRef(new Map<string, Promise<ScopedThreadRef>>());
  const key =
    environmentId && reference
      ? JSON.stringify([environmentId, reference.host, reference.repository, reference.number])
      : null;
  const saved = useMemo(() => {
    if (!reference || !environmentId) return undefined;
    return threads
      .filter(
        (thread) =>
          thread.environmentId === environmentId &&
          !thread.archivedAt &&
          (thread.purpose ?? "chat") === purpose &&
          thread.branch?.startsWith("t3code/review-") &&
          thread.worktreePath &&
          thread.pullRequests.some(
            (pr) =>
              pr.host === reference.host &&
              pr.repository === reference.repository &&
              pr.number === reference.number &&
              pr.source !== "stack-dismissed",
          ),
      )
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }, [threads, environmentId, reference, purpose]);
  const local = key ? opened[key] : undefined;
  const threadRef =
    saved && (!local || saved.createdAt >= local.createdAt)
      ? scopeThreadRef(saved.environmentId, saved.id)
      : (local?.ref ?? null);

  const ensure = async (
    detail: PullRequestDetail,
    newConversation = false,
  ): Promise<ScopedThreadRef> => {
    if (threadRef && !newConversation) return threadRef;
    if (!environmentId || !key) throw new Error("Select a pull request first.");
    const existing = pending.current.get(key);
    if (existing) return existing;
    const create = async () => {
      const settings = resolveProjectSettings(
        configs.get(environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS,
        detail.projectId,
        readProjects().find(
          (project) => project.environmentId === environmentId && project.id === detail.projectId,
        ),
      ).settings;
      const modelSelection = resolveDefaultProviderModelSelection(
        configs.get(environmentId)?.providers ?? [],
        settings.defaultModelSelection,
      );
      if (!modelSelection)
        throw new Error("Configure an agent provider before starting a review chat.");
      const threadId = newThreadId();
      const prepared = await prepare({
        environmentId,
        input: {
          cwd: detail.workspaceRoot,
          reference: detail.url,
          mode: "review",
          threadId,
          ...(detail.headSha ? { expectedHeadSha: detail.headSha } : {}),
        },
      });
      if (prepared._tag === "Failure") throw squashAtomCommandFailure(prepared);
      const workspace = prepared.value;
      const workspaceRoot = workspace.workspaceRoot ?? detail.workspaceRoot;
      const project = readProjects().find(
        (project) =>
          project.environmentId === environmentId && project.workspaceRoot === workspaceRoot,
      );
      const projectId = project?.id ?? newProjectId();
      if (!project) {
        const created = await createProject({
          environmentId,
          input: {
            projectId,
            title: detail.repository,
            workspaceRoot,
            defaultModelSelection: null,
            createdAt: new Date().toISOString(),
          },
        });
        if (created._tag === "Failure") throw squashAtomCommandFailure(created);
      }
      const createdAt = new Date().toISOString();
      const created = await createThread({
        environmentId,
        input: {
          threadId,
          projectId,
          title: `Review #${detail.number}: ${detail.title}`.slice(0, 200),
          purpose,
          modelSelection,
          runtimeMode: settings.defaultRuntimeMode,
          interactionMode: "default",
          branch: workspace.branch,
          worktreePath: workspace.worktreePath,
          createdAt,
        },
      });
      if (created._tag === "Failure") throw squashAtomCommandFailure(created);
      const target = scopeThreadRef(environmentId, threadId);
      const linked = await link({
        environmentId,
        input: {
          threadId,
          host: new URL(detail.url).host,
          repository: detail.repository,
          number: detail.number,
          url: detail.url,
          source: "manual",
        },
      });
      if (linked._tag === "Failure") throw squashAtomCommandFailure(linked);
      if (purpose === "chat") {
        useComposerDraftStore
          .getState()
          .setPrompt(
            target,
            `Review ${detail.url}.\nThe isolated workspace is pinned to ${workspace.headSha}. Review and explain the code; do not edit files unless I ask. The GitHub diff can change independently of this workspace.\n\n`,
          );
      }
      setOpened((current) => ({ ...current, [key]: { ref: target, createdAt } }));
      return target;
    };
    const work = create().finally(() => pending.current.delete(key));
    pending.current.set(key, work);
    return work;
  };
  const branch = threadRef
    ? threads.find(
        (thread) =>
          thread.environmentId === threadRef.environmentId && thread.id === threadRef.threadId,
      )?.branch
    : null;
  const headSha = branch?.match(/^t3code\/review-\d+-([0-9a-f]{40})-/)?.[1] ?? null;
  return { threadRef, headSha, ensure };
}
