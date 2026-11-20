import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { T, useGT } from "gt-react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export interface ReviewCheckout {
  readonly cwd: string;
  readonly projectId: ProjectId;
  readonly label: string;
}

interface CheckoutPickerProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadCwd: string | undefined;
  threadRepositoryRoot: string | undefined;
  checkout: ReviewCheckout | undefined;
  onSelect: (checkout: ReviewCheckout | undefined) => void;
}

export function DiffCheckoutSwitcher(props: CheckoutPickerProps) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const label = props.checkout?.label ?? gt("Thread checkout");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button size="xs" variant="secondary" />}
        className="min-w-0 shrink"
        aria-label={gt("Switch checkout")}
        title={label}
      >
        <span className="max-w-40 truncate">{label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
      </DialogTrigger>
      {open && (
        <DiffCheckoutPicker
          {...props}
          onSelect={(checkout) => {
            props.onSelect(checkout);
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
  threadCwd,
  threadRepositoryRoot,
  checkout,
  onSelect,
}: CheckoutPickerProps) {
  const gt = useGT();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [selectedProjectId, setSelectedProjectId] = useState(checkout?.projectId ?? projectId);
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
  );
  const excluded = new Set(
    [threadCwd, threadRepositoryRoot].flatMap((path) =>
      path ? [normalizeProjectPathForComparison(path)] : [],
    ),
  );
  const currentPath = checkout ? normalizeProjectPathForComparison(checkout.cwd) : undefined;
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
        <DialogTitle>{gt("Switch checkout")}</DialogTitle>
      </DialogHeader>
      <div className="space-y-2 px-4 pb-4">
        <CheckoutOption
          label={gt("Thread checkout")}
          cwd={threadCwd}
          selected={!checkout}
          onSelect={() => onSelect(undefined)}
        />
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
          {[...checkouts.entries()].map(([path, option]) => (
            <CheckoutOption
              key={path}
              label={option.label}
              cwd={option.cwd}
              selected={path === currentPath}
              onSelect={() => onSelect(option)}
            />
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

function CheckoutOption({
  label,
  cwd,
  selected,
  onSelect,
}: {
  label: string;
  cwd: string | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent"
      onClick={onSelect}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{label}</span>
        {cwd && <span className="break-all font-mono text-xs text-muted-foreground">{cwd}</span>}
      </span>
      {selected && <CheckIcon aria-hidden className="size-4 shrink-0" />}
    </button>
  );
}
