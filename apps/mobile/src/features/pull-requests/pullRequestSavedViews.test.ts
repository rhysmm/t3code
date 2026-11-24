import { expect, it } from "vite-plus/test";
import type { PullRequestSavedView } from "../../persistence/mobile-preferences";
import { pullRequestSavedViewPreferences, pullRequestViewMatches } from "./pullRequestSavedViews";

const view = {
  id: "review",
  name: "Review queue",
  environmentId: "remote",
  query: "bug",
  controls: {
    state: "open",
    involvement: "reviewing",
    filters: {
      authors: ["me", "octocat"],
      authorTeam: { host: "github.com", organization: "org", slug: "team" },
      draft: "hide",
      labels: [["bug", "fix"], ["urgent"]],
      excludedLabels: ["hold", "later"],
    },
    sort: "created",
    projectId: "project",
    projectEnvironmentId: "remote",
  },
} as const satisfies PullRequestSavedView;

it("recognizes a saved view regardless of filter property or label ordering", () => {
  const controls = {
    ...view.controls,
    filters: {
      excludedLabels: ["later", "hold"],
      labels: [["urgent"], ["fix", "bug"]],
      draft: "hide",
      authors: ["OCTOCAT", "me"],
      authorTeam: view.controls.filters.authorTeam,
    },
  } as const;
  expect(pullRequestViewMatches(view, { ...view, query: " bug ", controls })).toBe(true);
  expect(
    pullRequestViewMatches(view, {
      ...view,
      controls: { ...controls, filters: { ...controls.filters, authorTeam: undefined } },
    }),
  ).toBe(false);
  expect(view.controls.filters.labels).toEqual([["bug", "fix"], ["urgent"]]);
  expect(
    pullRequestViewMatches(view, {
      ...view,
      controls: { ...view.controls, projectEnvironmentId: "other" },
    }),
  ).toBe(false);
});

it("applies a view's environment and controls while keeping other environments' controls", () => {
  const local = { state: "merged", involvement: "authored", filters: {}, sort: "oldest" } as const;
  expect(
    pullRequestSavedViewPreferences(
      { pullRequestListFilters: { environmentId: "local", controls: { local } } },
      view,
    ),
  ).toEqual({
    pullRequestListFilters: {
      environmentId: "remote",
      controls: { local, remote: view.controls },
    },
  });
});
