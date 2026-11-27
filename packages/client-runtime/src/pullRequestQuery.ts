import { MAX_PULL_REQUEST_AUTHOR_FILTERS, type PullRequestListFilters } from "@t3tools/contracts";

const REVIEW_VALUES: Record<string, PullRequestListFilters["review"]> = {
  approved: "approved",
  changes_requested: "changes-requested",
  "changes-requested": "changes-requested",
  required: "review-required",
  "review-required": "review-required",
  none: "none",
};
const CHECKS_VALUES: Record<string, PullRequestListFilters["checks"]> = {
  success: "passing",
  passing: "passing",
  failure: "failing",
  failing: "failing",
};

const QUERY_TOKEN = /(?:[^\s"]|"[^"]*")+/g;
const MAX_QUALIFIER_VALUES = 10;
const MAX_QUALIFIER_LENGTH = 200;
const MAX_TEXT_LENGTH = 200;

function qualifierValue(raw: string): string {
  return raw.replaceAll('"', "").trim();
}

function splitQualifierList(raw: string): string[] {
  return (raw.match(/(?:[^,"]|"[^"]*")+/g) ?? [])
    .map((part) => qualifierValue(part))
    .filter((part) => part.length > 0);
}

/** `me` and `@me` both name the viewer; logins are case-insensitive. */
function authorKey(login: string): string {
  return login.toLowerCase().replace(/^@me$/, "me");
}

function boundedNames(names: ReadonlyArray<string>): string[] {
  return names
    .slice(0, MAX_QUALIFIER_VALUES)
    .map((name) => name.slice(0, MAX_QUALIFIER_LENGTH).trim())
    .filter((name) => name.length > 0);
}

export function parsePullRequestQuery(raw: string): {
  readonly text: string;
  readonly filters: PullRequestListFilters;
} {
  const text: string[] = [];
  const labels: string[][] = [];
  const excludedLabels: string[] = [];
  const authors = new Map<string, string>();
  let draft: PullRequestListFilters["draft"];
  let review: PullRequestListFilters["review"];
  let checks: PullRequestListFilters["checks"];
  for (const [token] of raw.matchAll(QUERY_TOKEN)) {
    const qualifier = /^(-?)([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(token);
    const value = qualifier === null ? "" : qualifierValue(qualifier[3] ?? "");
    const negated = qualifier?.[1] === "-";
    switch (value.length === 0 ? "" : (qualifier?.[2]?.toLowerCase() ?? "")) {
      case "label": {
        const names = boundedNames(splitQualifierList(qualifier?.[3] ?? ""));
        if (names.length === 0) break;
        if (negated) excludedLabels.push(...names);
        else labels.push(names);
        continue;
      }
      case "author": {
        if (negated) break;
        const login = value.slice(0, MAX_QUALIFIER_LENGTH).trim();
        const key = authorKey(login);
        if (authors.size < MAX_PULL_REQUEST_AUTHOR_FILTERS && !authors.has(key)) {
          authors.set(key, login);
        }
        continue;
      }
      case "draft":
        if (value.toLowerCase() !== "true" && value.toLowerCase() !== "false") break;
        draft = (value.toLowerCase() === "true") !== negated ? "only" : "hide";
        continue;
      case "review": {
        const key = value.toLowerCase();
        const decision =
          !negated && Object.hasOwn(REVIEW_VALUES, key) ? REVIEW_VALUES[key] : undefined;
        if (decision === undefined) break;
        review = decision;
        continue;
      }
      case "status":
      case "checks": {
        const key = value.toLowerCase();
        const state =
          !negated && Object.hasOwn(CHECKS_VALUES, key) ? CHECKS_VALUES[key] : undefined;
        if (state === undefined) break;
        checks = state;
        continue;
      }
      // GitHub's own search qualifiers, not labels: the list sets scope and order itself.
      case "is":
      case "archived":
      case "state":
      case "repo":
      case "org":
      case "user":
      case "sort":
        continue;
      case "":
        break;
      default:
        if (!value.startsWith("/")) {
          const names = boundedNames(
            splitQualifierList(qualifier?.[3] ?? "").map((name) =>
              name.includes(":") ? name : `${qualifier?.[2] ?? ""}:${name}`,
            ),
          );
          if (names.length === 0) break;
          if (negated) excludedLabels.push(...names);
          else labels.push(names);
          continue;
        }
    }
    text.push(token);
  }
  const selectedAuthors = [...authors.values()];
  const firstAuthor = selectedAuthors[0];
  return {
    text: text.join(" ").slice(0, MAX_TEXT_LENGTH).trim(),
    filters: {
      ...(labels.length === 0 ? {} : { labels: labels.slice(0, MAX_QUALIFIER_VALUES) }),
      ...(excludedLabels.length === 0
        ? {}
        : { excludedLabels: excludedLabels.slice(0, MAX_QUALIFIER_VALUES) }),
      ...(selectedAuthors.length === 1 && firstAuthor !== undefined ? { author: firstAuthor } : {}),
      ...(selectedAuthors.length > 1 ? { authors: selectedAuthors } : {}),
      ...(draft === undefined ? {} : { draft }),
      ...(review === undefined ? {} : { review }),
      ...(checks === undefined ? {} : { checks }),
    },
  };
}

export function mergePullRequestListFilters(
  menu: PullRequestListFilters,
  typed: PullRequestListFilters,
): PullRequestListFilters {
  if (typed.author === undefined && typed.authors === undefined) return { ...menu, ...typed };
  const { author: _author, authors: _authors, authorTeam: _authorTeam, ...remaining } = menu;
  return { ...remaining, ...typed };
}

/** The Filters menu's radio qualifiers: it shows a typed one in place of its own value. */
const MENU_QUALIFIERS = ["draft", "review", "checks"] as const;
type MenuQualifier = (typeof MENU_QUALIFIERS)[number];

export function pullRequestMenuFilters(
  typed: PullRequestListFilters,
  menuFilters: PullRequestListFilters,
): PullRequestListFilters {
  return {
    ...menuFilters,
    draft: typed.draft ?? menuFilters.draft,
    review: typed.review ?? menuFilters.review,
    checks: typed.checks ?? menuFilters.checks,
  };
}

/**
 * Picking another menu value takes the matching typed qualifier out of the query: left in, it
 * would keep outranking whatever the menu stores.
 */
export function applyPullRequestFilterChange(
  query: string,
  menuFilters: PullRequestListFilters,
  next: PullRequestListFilters,
) {
  const typed = parsePullRequestQuery(query).filters;
  const changed = (key: MenuQualifier) => next[key] !== (typed[key] ?? menuFilters[key]);
  const replaced = MENU_QUALIFIERS.filter((key) => typed[key] !== undefined && changed(key));
  const removes = (token: string) => {
    const filters = parsePullRequestQuery(token).filters;
    return replaced.some((key) => filters[key] !== undefined);
  };
  return {
    // Cut by source span so text the tokenizer skips, like an unclosed quote, stays as typed.
    query:
      replaced.length === 0
        ? query
        : [...query.matchAll(QUERY_TOKEN)]
            .reduceRight(
              (rest, match) =>
                removes(match[0])
                  ? rest.slice(0, match.index) +
                    rest.slice(match.index + match[0].length).trimStart()
                  : rest,
              query,
            )
            .trim(),
    filters: {
      ...next,
      draft: changed("draft") ? next.draft : menuFilters.draft,
      review: changed("review") ? next.review : menuFilters.review,
      checks: changed("checks") ? next.checks : menuFilters.checks,
    },
  };
}
