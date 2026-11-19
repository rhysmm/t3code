import type { EnvironmentId, ProjectId, ReviewDiffPreviewInput } from "@t3tools/contracts";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import { fileBasename, normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { T, useGT, useMessages } from "gt-react";
import { FolderPlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useState } from "react";

import type { ReviewCheckout } from "~/diffPanelStore";
import { LIVE_REFRESH_MIN_INTERVAL_MS, useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { revisionedQuery } from "~/state/revisionedQuery";
import { vcsEnvironment } from "~/state/vcs";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function AddDiffCheckout({
  environmentId,
  projectId,
  excludedPaths,
  onAdd,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  excludedPaths: ReadonlyArray<string>;
  onAdd: (checkout: ReviewCheckout) => void;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={<Button size="icon-sm" variant="ghost" aria-label={gt("Add checkout")} />}
            />
          }
        >
          <FolderPlusIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="top">{gt("Add checkout")}</TooltipPopup>
      </Tooltip>
      {open && (
        <DiffCheckoutPicker
          environmentId={environmentId}
          projectId={projectId}
          excludedPaths={excludedPaths}
          onAdd={(checkout) => {
            onAdd(checkout);
            setOpen(false);
          }}
        />
      )}
    </Dialog>
  );
}

function DiffCheckoutPicker({
  environmentId,
  projectId,
  excludedPaths,
  onAdd,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  excludedPaths: ReadonlyArray<string>;
  onAdd: (checkout: ReviewCheckout) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [selectedProjectId, setSelectedProjectId] = useState(projectId);
  const [branchQuery, setBranchQuery] = useState("");
  const [cursor, setCursor] = useState<number | undefined>();
  const project = projects.find(({ id }) => id === selectedProjectId);
  const branchRefs = useEnvironmentQuery(
    project
      ? vcsEnvironment.listRefs({
          environmentId,
          input: {
            cwd: project.workspaceRoot,
            refKind: "local",
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
            ...(branchQuery.trim() ? { query: branchQuery.trim() } : {}),
          },
        })
      : null,
    messages,
  );
  const excluded = new Set(excludedPaths.map(normalizeProjectPathForComparison));
  const checkouts = new Map<string, ReviewCheckout>();
  if (project && branchRefs.data?.isRepo) {
    const root = project.repositoryIdentity?.rootPath ?? project.workspaceRoot;
    const add = (cwd: string, branch?: string) => {
      const key = normalizeProjectPathForComparison(cwd);
      if (!excluded.has(key)) {
        checkouts.set(key, {
          cwd,
          projectId: project.id,
          label: branch ? `${project.title} · ${branch}` : project.title,
        });
      }
    };
    if (!branchQuery.trim() && cursor === undefined) add(root);
    for (const ref of branchRefs.data.refs) {
      if (ref.worktreePath) add(ref.worktreePath, ref.name);
    }
  }
  return (
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>
          <T>Add checkout</T>
        </DialogTitle>
        <DialogDescription>
          <T>Choose a project checkout to include in this thread’s live diff.</T>
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2 px-4 pb-4">
        <Select
          items={projects.map(({ id, title }) => ({ value: id, label: title }))}
          value={selectedProjectId}
          onValueChange={(id) => {
            if (!id) return;
            setSelectedProjectId(id);
            setBranchQuery("");
            setCursor(undefined);
          }}
        >
          <SelectTrigger aria-label={gt("Project")}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {projects.map(({ id, title, workspaceRoot }) => (
              <SelectItem key={id} value={id}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{title}</span>
                  <span className="break-all text-xs text-muted-foreground">{workspaceRoot}</span>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Input
          type="search"
          aria-label={gt("Filter worktrees by branch")}
          placeholder={gt("Filter worktrees by branch")}
          value={branchQuery}
          maxLength={256}
          onChange={(event) => {
            setBranchQuery(event.currentTarget.value);
            setCursor(undefined);
          }}
        />
        <div className="max-h-72 overflow-y-auto" aria-busy={branchRefs.isPending}>
          {[...checkouts.values()].map((checkout) => (
            <button
              key={checkout.cwd}
              type="button"
              className="flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent"
              onClick={() => onAdd(checkout)}
            >
              <span className="w-full truncate text-sm">{checkout.label}</span>
              <span className="w-full break-all font-mono text-xs text-muted-foreground">
                {checkout.cwd}
              </span>
            </button>
          ))}
          {checkouts.size === 0 && (
            <p className="p-2 text-sm text-muted-foreground" role="status">
              {branchRefs.error ??
                (branchRefs.isPending
                  ? gt("Loading checkouts…")
                  : gt("No additional checkouts found."))}
            </p>
          )}
          {branchRefs.data?.nextCursor != null && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCursor(branchRefs.data!.nextCursor ?? undefined)}
            >
              <T>Next page</T>
            </Button>
          )}
          {cursor !== undefined && (
            <Button size="sm" variant="ghost" onClick={() => setCursor(undefined)}>
              <T>First page</T>
            </Button>
          )}
        </div>
      </div>
    </DialogPopup>
  );
}

export function liveCheckoutDiffInput(input: {
  cwd: string;
  checkoutProjectId?: ProjectId;
  baseRef?: string | null;
  sourceKind: "working-tree" | "branch-range";
  ignoreWhitespace: boolean;
}): ReviewDiffPreviewInput {
  return {
    cwd: input.cwd,
    ...(input.checkoutProjectId ? { checkoutProjectId: input.checkoutProjectId } : {}),
    ...(input.baseRef && input.sourceKind === "branch-range" ? { baseRef: input.baseRef } : {}),
    sourceKind: input.sourceKind,
    ignoreWhitespace: input.ignoreWhitespace,
    metadataOnly: true,
  };
}

const FILES_PER_PAGE = 40;

export function DiffCheckoutGroup({
  environmentId,
  label,
  input,
  workspaceMutationId,
  visible,
  selected,
  hideTestFiles,
  onSelect,
  onRemove,
}: {
  environmentId: EnvironmentId;
  label: string;
  input: ReviewDiffPreviewInput;
  workspaceMutationId: string | null;
  visible: boolean;
  selected: boolean;
  hideTestFiles: boolean;
  onSelect: (filePath?: string) => void;
  onRemove?: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const query = useEnvironmentQuery(
    visible
      ? revisionedQuery(
          reviewEnvironment.diffPreview({ environmentId, input }),
          workspaceMutationId,
        )
      : null,
    messages,
  );
  const source = query.data?.sources.find((candidate) => candidate.kind === input.sourceKind);
  const files =
    source?.files?.filter(({ path }) => !hideTestFiles || !isTestChangedFile(path)) ?? [];
  const [visibleCount, setVisibleCount] = useState(FILES_PER_PAGE);
  useLiveRefresh(
    query.data !== null && !query.isPending
      ? () => {
          if (Date.now() - query.dataUpdatedAt >= LIVE_REFRESH_MIN_INTERVAL_MS) query.refresh();
        }
      : null,
    {
      enabled: visible && !selected,
      key: JSON.stringify(["checkout-diff", environmentId, input.cwd]),
      intervalMs: null,
      refreshOnShow: true,
    },
  );
  let emptyText = gt("No Git comparison available.");
  if (query.isPending) emptyText = gt("Loading changes…");
  else if (source?.files?.length) emptyText = gt("No visible changes");
  else if (source?.diff.trim()) emptyText = gt("Select this checkout to see its changes.");
  else if (source) emptyText = gt("No changes");
  return (
    <li className="border-b border-border/60 py-1.5 last:border-b-0">
      <div className="flex items-start gap-1 px-2">
        <button
          type="button"
          aria-pressed={selected}
          className="min-w-0 flex-1 rounded-md px-1 py-1 text-left hover:bg-accent aria-pressed:bg-accent"
          onClick={() => onSelect()}
        >
          <span className="block truncate text-sm font-medium">
            {label || fileBasename(input.cwd)}
          </span>
          <span className="block break-all font-mono text-2xs text-muted-foreground">
            {input.cwd}
          </span>
          {source?.baseRef && source.kind === "branch-range" && (
            <span className="block truncate text-2xs text-muted-foreground">
              {gt("Compared with {base}", { base: source.baseRef })}
            </span>
          )}
        </button>
        {onRemove && (
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onRemove}
            aria-label={gt("Remove {checkout}", { checkout: label })}
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>
      {query.error ? (
        <div className="flex items-center gap-1.5 px-3 py-1" role="status">
          <span className="text-xs text-muted-foreground">{query.error}</span>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={query.refresh}
            aria-label={gt("Retry checkout diff")}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
      ) : files.length > 0 ? (
        <ul className="px-2 pt-1">
          {files.slice(0, visibleCount).map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-accent focus-visible:bg-accent"
                onClick={() => onSelect(file.path)}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
                <DiffStatLabel additions={file.additions} deletions={file.deletions} />
              </button>
            </li>
          ))}
          {files.length > visibleCount && (
            <li>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setVisibleCount(visibleCount + FILES_PER_PAGE)}
              >
                <T>Show more files</T>
              </Button>
            </li>
          )}
        </ul>
      ) : (
        <p className="px-3 py-1 text-xs text-muted-foreground">{emptyText}</p>
      )}
    </li>
  );
}
