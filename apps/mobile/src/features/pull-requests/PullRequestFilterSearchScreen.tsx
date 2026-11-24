import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  MAX_PULL_REQUEST_AUTHOR_FILTERS,
  ProjectId,
  type PullRequestAuthorTeam,
  type PullRequestFilterOptionKind,
  type PullRequestFilterOptionsInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { Platform } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { EmptyState } from "../../components/ui/EmptyState";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { useGT } from "gt-react-native";
import { composerPullRequests } from "../../state/pull-requests";
import { useDebouncedValue } from "../../state/queries";
import {
  pullRequestAuthorKey,
  pullRequestFilterChoices,
  pullRequestLabelColors,
  pullRequestTeamKey,
  pullRequestTeamLabel,
  selectedPullRequestAuthors,
  togglePullRequestAuthor,
} from "./pullRequestList";
import { PullRequestLabelDot } from "./PullRequestLabelDot";
import { PullRequestSearchSheet } from "./PullRequestSearchSheet";
import { usePullRequestListControls } from "./usePullRequestListControls";

export type PullRequestFilterSearchParams = {
  readonly kind: Extract<PullRequestFilterOptionKind, "labels" | "authors" | "teams">;
  /** The list controls' own key: the environment the list is narrowed to, or every one. */
  readonly environmentId: string | null;
  /** The environments the list reads, which the host search covers as well. */
  readonly environmentIds: readonly string[];
  /** What the loaded rows already carry, offered before the host has answered. */
  readonly suggestions: readonly string[];
  /** Dot colors by lowercased label name, from the loaded rows. */
  readonly labelColors?: Readonly<Record<string, string>>;
};

const optionsFamily = Atom.family((key: string) => {
  const targets: readonly {
    readonly environmentId: EnvironmentId;
    readonly input: PullRequestFilterOptionsInput;
  }[] = JSON.parse(key);
  return Atom.make((get) => {
    const results = targets.map((target) => get(composerPullRequests.filterOptions(target)));
    return {
      values: results.flatMap((result) => Option.toArray(AsyncResult.value(result))),
      waiting: results.some((result) => result.waiting),
      failed: results.some(AsyncResult.isFailure),
    };
  });
});

export function PullRequestFilterSearchScreen({
  route,
}: StaticScreenProps<PullRequestFilterSearchParams>) {
  const navigation = useNavigation();
  const gt = useGT();
  const { kind, environmentId, environmentIds, suggestions, labelColors } = route.params;
  const listControls = usePullRequestListControls();
  const controls = listControls.controlsFor(environmentId);
  const [query, setQuery] = useState("");
  const typed = query.trim().slice(0, 100);
  const sent = useDebouncedValue(typed, 250);
  // Until the search catches up with the typing, the host's answers are for older text.
  const settled = sent === typed;
  const key = JSON.stringify(
    environmentIds.map((id) => ({
      environmentId: EnvironmentId.make(id),
      input: {
        kind,
        ...(controls.projectId ? { projectId: ProjectId.make(controls.projectId) } : {}),
        ...(sent ? { query: sent } : {}),
      },
    })),
  );
  const hosted = useAtomValue(optionsFamily(key));
  const selectedTeam = controls.filters.authorTeam;
  const selectedTeamKey = selectedTeam ? pullRequestTeamKey(selectedTeam) : undefined;
  const answers = settled ? hosted.values : [];
  const teams = new Map<string, PullRequestAuthorTeam>();
  for (const answer of answers)
    for (const team of answer.teams ?? []) teams.set(pullRequestTeamKey(team), team);
  if (selectedTeam && selectedTeamKey) teams.set(selectedTeamKey, selectedTeam);
  const selected =
    kind === "teams"
      ? selectedTeamKey
        ? [selectedTeamKey]
        : []
      : kind === "labels"
        ? (controls.filters.labels?.flat() ?? [])
        : selectedPullRequestAuthors(controls.filters).map(pullRequestAuthorKey);
  const rows = pullRequestFilterChoices({
    selected,
    suggestions,
    hosted:
      kind === "teams"
        ? [...teams.keys()]
        : answers.flatMap((options) =>
            kind === "labels"
              ? options.labels.map((label) => label.name)
              : options.authors.map((candidate) => pullRequestAuthorKey(candidate.login)),
          ),
    query,
  });
  const colors = {
    ...pullRequestLabelColors(hosted.values.flatMap((options) => options.labels)),
    ...labelColors,
  };
  const isSelected = (value: string) =>
    selected.some((held) => held.toLowerCase() === value.toLowerCase());
  const choose = (value: string) => {
    if (kind === "teams") {
      const team = teams.get(value);
      if (team === undefined) return;
      listControls.setControls(environmentId, (current) => ({
        ...current,
        filters: {
          ...current.filters,
          authorTeam:
            current.filters.authorTeam && pullRequestTeamKey(current.filters.authorTeam) === value
              ? undefined
              : team,
        },
      }));
      navigation.goBack();
      return;
    }
    if (kind === "authors") {
      listControls.setControls(environmentId, (current) => ({
        ...current,
        filters: togglePullRequestAuthor(current.filters, value),
      }));
      return;
    }
    const selectedLabels = controls.filters.labels?.flat() ?? [];
    const labels = isSelected(value)
      ? selectedLabels.filter((label) => label.toLowerCase() !== value.toLowerCase())
      : [...selectedLabels, value].slice(0, 10);
    listControls.setControls(environmentId, {
      ...controls,
      filters: {
        ...controls.filters,
        labels: labels.length ? labels.map((label) => [label]) : undefined,
      },
    });
  };
  const copy =
    kind === "teams"
      ? {
          title: gt("Filter by GitHub team"),
          placeholder: gt("Search GitHub teams"),
          close: gt("Close team filter"),
          clear: gt("Clear team search"),
          emptyTitle: gt("No matching GitHub teams"),
          emptyDetail: gt("Search teams in the GitHub organizations this list covers."),
        }
      : kind === "authors"
        ? {
            title: gt("Filter by author"),
            placeholder: gt("Search authors"),
            close: gt("Close author filter"),
            clear: gt("Clear author search"),
            emptyTitle: gt("No matching authors"),
            emptyDetail: gt("Search people by name or handle on the repositories' hosts."),
          }
        : {
            title: gt("Filter by label"),
            placeholder: gt("Search labels"),
            close: gt("Close label filter"),
            clear: gt("Clear label search"),
            emptyTitle: gt("No matching labels"),
            emptyDetail: gt("Search the labels of the repositories this list covers."),
          };
  const failure = (
    <EmptyState
      title={gt("Couldn't search the host")}
      detail={gt("The host didn't answer. Try again in a moment.")}
      variant="plain"
    />
  );
  return (
    <PullRequestSearchSheet
      title={copy.title}
      placeholder={copy.placeholder}
      closeAccessibilityLabel={copy.close}
      clearAccessibilityLabel={copy.clear}
      query={query}
      onQueryChange={setQuery}
    >
      {({ paddingBottom }) => (
        <LegendList
          renderScrollComponent={NativeScrollView}
          data={rows}
          keyExtractor={(value) => value.toLowerCase()}
          extraData={{ selected, colors, teams, count: rows.length }}
          estimatedItemSize={56}
          recycleItems
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom }}
          renderItem={({ item, index }) => {
            const team = teams.get(item);
            const checked = isSelected(item);
            return (
              <SelectionRow
                title={
                  team
                    ? pullRequestTeamLabel(team)
                    : item === "me" && kind === "authors"
                      ? gt("Me")
                      : item
                }
                subtitle={team?.host}
                role={kind === "teams" ? "radio" : "checkbox"}
                selected={checked}
                disabled={
                  kind === "authors" &&
                  !checked &&
                  selected.length >= MAX_PULL_REQUEST_AUTHOR_FILTERS
                }
                isFirst={index === 0}
                isLast={index === rows.length - 1}
                leading={
                  kind === "labels" ? (
                    <PullRequestLabelDot color={colors[item.toLowerCase()] ?? null} />
                  ) : undefined
                }
                onPress={() => choose(item)}
              />
            );
          }}
          ListFooterComponent={
            kind === "teams" && rows.length > 0 && hosted.failed && settled ? failure : undefined
          }
          ListEmptyComponent={
            hosted.waiting || !settled ? (
              <AppActivityIndicator className="my-8" />
            ) : hosted.failed ? (
              failure
            ) : (
              <EmptyState title={copy.emptyTitle} detail={copy.emptyDetail} variant="plain" />
            )
          }
        />
      )}
    </PullRequestSearchSheet>
  );
}
