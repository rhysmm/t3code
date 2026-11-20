import {
  MAX_PULL_REQUEST_AUTHOR_FILTERS,
  PullRequestAuthorTeam,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import {
  readPullRequestListPreferences,
  type PullRequestListSort,
} from "../components/pullRequest/pullRequestListPreferences";
import { SORT_OPTIONS } from "../components/pullRequest/pullRequestListOptions";
import { type PullRequestsSearch } from "../components/pullRequest/usePullRequestListView";
import { PullRequestsPage } from "../components/pullRequest/PullRequestsPage";

const MAX_SEARCH_FILTER_CANDIDATES = 100;
const decodeAuthorTeam = Schema.decodeUnknownOption(PullRequestAuthorTeam);

function pullRequestSearchFilterList(
  raw: unknown,
  limit: number,
): ReadonlyArray<string> | undefined {
  const values = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).slice(
    0,
    MAX_SEARCH_FILTER_CANDIDATES,
  );
  const selected: Array<string> = [];
  const seen = new Set<string>();
  for (const rawValue of values) {
    if (typeof rawValue !== "string") continue;
    const value = rawValue.trim().slice(0, 200);
    const key = value.toLowerCase();
    if (value.length === 0 || seen.has(key)) continue;
    selected.push(value);
    seen.add(key);
    if (selected.length === limit) break;
  }
  return selected.length === 0 ? undefined : selected;
}

function pullRequestSearchAuthors(raw: Record<string, unknown>) {
  if (raw.authors === undefined && raw.author === undefined && raw.authorTeam === undefined) {
    const saved = readPullRequestListPreferences();
    return { authors: saved.authors, authorTeam: saved.authorTeam };
  }
  const legacyAuthor = typeof raw.author === "string" ? raw.author : undefined;
  const team = decodeAuthorTeam(raw.authorTeam);
  return {
    authors: pullRequestSearchFilterList(
      raw.authors ?? legacyAuthor,
      MAX_PULL_REQUEST_AUTHOR_FILTERS,
    ),
    authorTeam: team._tag === "Some" ? team.value : undefined,
  };
}

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (raw: Record<string, unknown>): PullRequestsSearch & { author?: undefined } => ({
    ...(typeof raw.selectedUrl === "string" ? { selectedUrl: raw.selectedUrl.slice(0, 4096) } : {}),
    involvement:
      raw.involvement === "reviewing" || raw.involvement === "authored" ? raw.involvement : "all",
    state:
      raw.state === "closed" || raw.state === "merged" || raw.state === "all" ? raw.state : "open",
    ...(SORT_OPTIONS.some((option) => option.value === raw.sort)
      ? { sort: raw.sort as PullRequestListSort }
      : {}),
    ...(typeof raw.repository === "string" && raw.repository
      ? { repository: raw.repository.slice(0, 200) }
      : {}),
    ...(typeof raw.number === "number" && Number.isInteger(raw.number) && raw.number > 0
      ? { number: raw.number }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.host === "string" && raw.host ? { host: raw.host.slice(0, 200) } : {}),
    ...(typeof raw.selectedProjectId === "string" && raw.selectedProjectId
      ? { selectedProjectId: raw.selectedProjectId as ProjectId }
      : {}),
    ...(typeof raw.selectedHost === "string" && raw.selectedHost
      ? { selectedHost: raw.selectedHost.slice(0, 200) }
      : {}),
    ...(typeof raw.selectedEnvironmentId === "string" && raw.selectedEnvironmentId
      ? { selectedEnvironmentId: raw.selectedEnvironmentId as EnvironmentId }
      : {}),
    // Always include free-text keys to override numeric values in the parent route's unvalidated search.
    q: typeof raw.q === "string" && raw.q ? raw.q.slice(0, 200) : undefined,
    ...(raw.draft === "only" || raw.draft === "hide" ? { draft: raw.draft } : {}),
    ...(raw.review === "approved" ||
    raw.review === "changes-requested" ||
    raw.review === "review-required" ||
    raw.review === "none"
      ? { review: raw.review }
      : {}),
    ...(raw.checks === "passing" || raw.checks === "failing" ? { checks: raw.checks } : {}),
    // Override the parent's unvalidated legacy key as well as the current keys.
    author: undefined,
    ...pullRequestSearchAuthors(raw),
    labels: pullRequestSearchFilterList(raw.labels, 10),
  }),
  component: PullRequestsPage,
});
