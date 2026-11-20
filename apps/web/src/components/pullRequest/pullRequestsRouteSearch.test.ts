import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import { Route as PullRequestsRoute } from "../../routes/_chat.pull-requests";
import { writePullRequestListPreferences } from "./pullRequestListPreferences";

const team = { host: "github.com", organization: "dashhudson", slug: "wafflehouse" };

function matchedSearch(url: string) {
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const pullRequests = createRoute({
    getParentRoute: () => chat,
    path: "pull-requests",
    validateSearch: PullRequestsRoute.options.validateSearch,
  });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([pullRequests])]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  // useSearch reads matched-route search, which can differ from URL search.
  return router.matchRoutes(router.latestLocation).at(-1)?.search as
    | Record<string, unknown>
    | undefined;
}

describe("pull requests route search", () => {
  it("drops a q the URL parser turned into a number", () => {
    expect(matchedSearch("/pull-requests?q=4089")?.q).toBeUndefined();
    expect(matchedSearch("/pull-requests?q=true")?.q).toBeUndefined();
  });

  it("keeps a q that is text, including quoted digits", () => {
    expect(matchedSearch("/pull-requests?q=fix")?.q).toBe("fix");
    expect(matchedSearch("/pull-requests?q=%224089%22")?.q).toBe("4089");
  });

  it("drops an author or labels the URL parser turned into a number", () => {
    expect(matchedSearch("/pull-requests?author=4089")?.authors).toBeUndefined();
    expect(matchedSearch("/pull-requests?labels=4089")?.labels).toBeUndefined();
  });

  it("accepts a legacy single author and deduplicates the author list by login", () => {
    expect(matchedSearch("/pull-requests?author=alice")?.authors).toEqual(["alice"]);
    const authors = encodeURIComponent(JSON.stringify(["alice", "ALICE", "bob"]));
    expect(matchedSearch(`/pull-requests?authors=${authors}`)?.authors).toEqual(["alice", "bob"]);
  });

  it("validates a team in the URL against the shared filter schema", () => {
    const valid = encodeURIComponent(JSON.stringify(team));
    const invalid = encodeURIComponent(JSON.stringify({ ...team, slug: "one/two" }));
    expect(matchedSearch(`/pull-requests?authorTeam=${valid}`)?.authorTeam).toEqual(team);
    expect(matchedSearch(`/pull-requests?authorTeam=${invalid}`)?.authorTeam).toBeUndefined();
  });

  it("restores saved authors and team on a PR deep link and respects clearing them", () => {
    const held = new Map<string, string>();
    const storage = {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
    };
    vi.stubGlobal("window", { localStorage: storage });
    try {
      const preferences = { involvement: "all", state: "open" } as const;
      writePullRequestListPreferences({
        ...preferences,
        authors: ["alice", "bob"],
        authorTeam: team,
      });
      const link = "/pull-requests?repository=example%2Frepo&number=12";
      expect(matchedSearch(link)).toMatchObject({ authors: ["alice", "bob"], authorTeam: team });

      writePullRequestListPreferences(preferences);
      expect(matchedSearch(link)?.authors).toBeUndefined();
      expect(matchedSearch(link)?.authorTeam).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
