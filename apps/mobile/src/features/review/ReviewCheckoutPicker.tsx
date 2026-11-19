import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { FormField } from "../../components/ui/FormSection";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Sheet } from "../../components/ui/Sheet";
import { useProjects } from "../../state/entities";
import { useDebouncedValue, usePaginatedBranches } from "../../state/queries";
import type { ReviewCheckout } from "./reviewCheckouts";

export function ReviewCheckoutPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly threadCheckoutPaths: ReadonlyArray<string>;
  readonly checkouts: ReadonlyArray<ReviewCheckout>;
  readonly onToggleCheckout: (checkout: ReviewCheckout) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [branchSearch, setBranchSearch] = useState("");
  const projects = useProjects().filter((entry) => entry.environmentId === props.environmentId);
  const project = projects.find((entry) => entry.id === projectId);
  const projectCheckout = project?.repositoryIdentity?.rootPath ?? project?.workspaceRoot ?? null;
  const branches = usePaginatedBranches({
    environmentId: project?.environmentId ?? null,
    cwd: project?.workspaceRoot ?? null,
    query: useDebouncedValue(branchSearch, 150),
  });
  const worktrees = new Map<string, ReviewCheckout>();
  if (project && projectCheckout !== null && branches.data?.isRepo) {
    const projectPath = normalizeProjectPathForComparison(projectCheckout);
    for (const ref of branches.refs) {
      if (ref.isRemote || ref.worktreePath === null) continue;
      const key = normalizeProjectPathForComparison(ref.worktreePath);
      if (key === projectPath) continue;
      worktrees.set(key, {
        cwd: ref.worktreePath,
        projectId: project.id,
        label: `${project.title} · ${ref.name}`,
      });
    }
  }
  const included = new Set(
    props.checkouts.map((checkout) => normalizeProjectPathForComparison(checkout.cwd)),
  );
  const checkoutRow = (checkout: ReviewCheckout, allowRemovingThreadCheckout = false) => {
    const key = normalizeProjectPathForComparison(checkout.cwd);
    const isThreadCheckout = props.threadCheckoutPaths.includes(key);
    return (
      <ListToggleRow
        key={key}
        label={checkout.label}
        description={checkout.cwd}
        value={included.has(key) || isThreadCheckout}
        disabled={isThreadCheckout && !allowRemovingThreadCheckout}
        onValueChange={() => props.onToggleCheckout(checkout)}
      />
    );
  };

  return (
    <Sheet title={gt("Review checkouts")} onClose={props.onClose}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
        <View className="gap-4 p-4">
          {props.checkouts.length > 0 ? (
            <ListSection title={gt("Included checkouts")}>
              {props.checkouts.map((checkout) => checkoutRow(checkout, true))}
            </ListSection>
          ) : null}
          <ListSection title={gt("Projects")}>
            {projects.map((entry, index) => (
              <ListChoiceRow
                key={entry.id}
                label={entry.title}
                description={entry.workspaceRoot}
                selected={entry.id === projectId}
                separated={index > 0}
                onPress={() => {
                  setProjectId(entry.id);
                  setBranchSearch("");
                }}
              />
            ))}
          </ListSection>
          {project ? (
            <>
              {branches.data?.isRepo && projectCheckout !== null ? (
                <ListSection title={gt("Project checkout")}>
                  {checkoutRow({
                    cwd: projectCheckout,
                    projectId: project.id,
                    label: project.title,
                  })}
                </ListSection>
              ) : null}
              <FormField
                accessibilityLabel={gt("Filter worktrees by branch")}
                onChangeText={setBranchSearch}
                placeholder={gt("Filter worktrees by branch")}
                value={branchSearch}
              />
              <ListSection
                title={gt("Worktrees")}
                footer={
                  branches.error ??
                  (branches.isPending
                    ? gt("Loading branches...")
                    : worktrees.size === 0
                      ? gt("No matching worktrees")
                      : undefined)
                }
              >
                {Array.from(worktrees.values(), (checkout) => checkoutRow(checkout))}
                {branches.data?.nextCursor != null ? (
                  <ListActionRow
                    label={gt("Load more")}
                    loading={branches.isFetchingNextPage}
                    onPress={branches.loadNext}
                  />
                ) : null}
              </ListSection>
            </>
          ) : null}
        </View>
      </ScrollView>
    </Sheet>
  );
}
