import { Spinner } from "~/components/ui/spinner";
import {
  MAX_PULL_REQUEST_AUTHOR_FILTERS,
  type EnvironmentId,
  type ProjectId,
  type PullRequestAuthorTeam,
  type PullRequestFilterOptionsInput,
  type PullRequestInvolvement,
  type PullRequestListFilters,
  type PullRequestListState,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  CircleXIcon,
  EyeOffIcon,
  FolderGit2Icon,
  LayersIcon,
  ListFilterIcon,
  SearchIcon,
  TagIcon,
  UserRoundIcon,
  UsersRoundIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { type ElementType, useState } from "react";

import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";
import { useDebouncedValue } from "~/state/queries";
import { type EnvironmentQueryTarget, usePullRequestFilterOptions } from "~/state/pullRequests";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Button } from "../ui/button";

import {
  Menu,
  MenuCheckboxItem,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSearchInput,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import {
  pullRequestAuthorChoices,
  selectedPullRequestAuthor,
  selectedPullRequestLabels,
  pullRequestLabelChoices,
  pullRequestLabelColor,
  type PullRequestAuthorFacet,
  type PullRequestLabelFacet,
} from "./pullRequestList.logic";
import { resolveFilterOptions } from "./pullRequestListOptions";
import { PullRequestActorAvatar } from "./pullRequestPresentation";
import { PullRequestGlyph } from "./pullRequestIcons";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export interface PullRequestFilterOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly Icon: ElementType<{ className?: string }>;
  readonly project?: ProjectFaviconProject;
  readonly unavailable?: string | undefined;
}

export function PullRequestFilterOptionIcon<Value extends string>({
  option,
}: {
  option: PullRequestFilterOption<Value>;
}) {
  return option.project ? (
    <ProjectFavicon project={option.project} className="size-3.5" />
  ) : (
    <option.Icon aria-hidden className="size-3.5" />
  );
}

export interface PullRequestExpectedHost {
  readonly host: string;
  readonly kind: SourceControlProviderKind;
}

export function pullRequestHostLabel(
  entries: ReadonlyArray<{ readonly host: string; readonly kind: SourceControlProviderKind }>,
  entry: { readonly host: string; readonly kind: SourceControlProviderKind },
): string {
  const sharing = entries.filter((candidate) => candidate.kind === entry.kind);
  return sharing.length > 1
    ? entry.host
    : getSourceControlPresentationForKind(entry.kind).providerName;
}

export function PullRequestSearchInput({
  value,
  busy,
  label,
  placeholder,
  onChange,
  onSubmit,
}: {
  value: string;
  busy?: boolean;
  label: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <InputGroup className="min-w-0 flex-1 **:[input]:h-9 sm:**:[input]:h-8">
      <InputGroupAddon>
        {busy ? <Spinner aria-hidden /> : <SearchIcon aria-hidden />}
      </InputGroupAddon>
      {/* Native search inputs clear on Escape even during IME composition. */}
      <InputGroupInput
        type="text"
        role="searchbox"
        value={draft ?? value}
        onFocus={() => setDraft(value)}
        onBlur={() => setDraft(null)}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          onChange(event.currentTarget.value);
          if ((event.nativeEvent as InputEvent).inputType === "insertFromPaste") {
            onSubmit(event.currentTarget.value);
          }
        }}
        onKeyDown={(event) => {
          const composing = event.nativeEvent.isComposing || event.keyCode === 229;
          if (event.key === "Enter" && !composing) onSubmit(event.currentTarget.value);
          if (event.key !== "Escape" || event.defaultPrevented) return;
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (!composing && !event.currentTarget.value) return;
          // The pull requests page leaves on an Escape that reaches it.
          event.stopPropagation();
          if (composing) return;
          setDraft("");
          onChange("");
        }}
        placeholder={placeholder}
        aria-label={label}
      />
    </InputGroup>
  );
}

const ALL_PROJECTS_VALUE = "all";
const ALL_HOSTS_VALUE = "";
const ALL_SERVERS_VALUE = "";
const UNFILTERED_VALUE = "all";
/** Project ids are unique only within an environment. */
export const pullRequestProjectKey = (project: {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
}) => JSON.stringify([project.environmentId, project.id]);

const DRAFT_OPTIONS = [
  {
    value: UNFILTERED_VALUE,
    label: msg("All", { $context: "pull request filter" }),
    Icon: LayersIcon,
  },
  { value: "only", label: msg("Drafts only"), Icon: PullRequestGlyph.draft },
  { value: "hide", label: msg("Hide drafts"), Icon: EyeOffIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<string>>;

const REVIEW_OPTIONS = [
  {
    value: UNFILTERED_VALUE,
    label: msg("All", { $context: "pull request filter" }),
    Icon: LayersIcon,
  },
  {
    value: "approved",
    label: msg("Approved", { $context: "review decision" }),
    Icon: CircleCheckIcon,
  },
  { value: "changes-requested", label: msg("Changes requested"), Icon: CircleXIcon },
  { value: "review-required", label: msg("Review required"), Icon: CircleDashedIcon },
  { value: "none", label: msg("No reviews"), Icon: CircleSlashIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<string>>;

const CHECKS_OPTIONS = [
  {
    value: UNFILTERED_VALUE,
    label: msg("All", { $context: "pull request filter" }),
    Icon: LayersIcon,
  },
  { value: "passing", label: msg("Passing", { $context: "checks filter" }), Icon: CircleCheckIcon },
  { value: "failing", label: msg("Failing", { $context: "checks filter" }), Icon: CircleXIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<string>>;

function PullRequestFilterRadioGroup<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (value: Value) => void;
}) {
  const gt = useGT();
  return (
    <MenuRadioGroup
      value={value}
      onValueChange={(next) => {
        if (next !== value) onChange(next as Value);
      }}
    >
      <MenuGroupLabel>{label}</MenuGroupLabel>
      {options.map((option) => {
        const item = (
          <MenuRadioItem
            key={option.value}
            value={option.value}
            className={option.unavailable ? "data-disabled:pointer-events-auto" : undefined}
            disabled={option.unavailable !== undefined}
          >
            <span className="flex min-w-0 items-center gap-2">
              <PullRequestFilterOptionIcon option={option} />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.unavailable ? (
                <span className="shrink-0">
                  · {gt("Unavailable", { $context: "filter option" })}
                </span>
              ) : null}
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        );
        if (!option.unavailable) return item;
        return <SharedTooltipTrigger key={option.value} render={item} label={option.unavailable} />;
      })}
    </MenuRadioGroup>
  );
}

export function PullRequestFilterRadioSubmenu<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (value: Value) => void;
}) {
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <MenuSub>
      <MenuSubTrigger>
        <PullRequestFilterOptionIcon option={current} />
        <span className="flex-1">{label}</span>
        <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
          {current.label}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        <PullRequestFilterRadioGroup
          label={label}
          value={value}
          options={options}
          onChange={onChange}
        />
      </MenuSubPopup>
    </MenuSub>
  );
}

/** The listing's own scope, which the pickers search the host within. */
export type PullRequestFilterOptionScope = EnvironmentQueryTarget<
  Omit<PullRequestFilterOptionsInput, "kind" | "query">
>;

const OPTION_SEARCH_DEBOUNCE_MS = 250;

function useHostedFilterOptions(
  scope: ReadonlyArray<PullRequestFilterOptionScope>,
  kind: PullRequestFilterOptionsInput["kind"],
  query: string,
) {
  const typed = query.trim().slice(0, 100);
  const sent = useDebouncedValue(typed, OPTION_SEARCH_DEBOUNCE_MS);
  const hosted = usePullRequestFilterOptions(
    scope.map(({ environmentId, input }) => ({
      environmentId,
      input: { ...input, kind, ...(sent ? { query: sent } : {}) },
    })),
  );
  // Until the search catches up with the typing, the host's answers are for older text.
  return sent === typed
    ? hosted
    : { labels: [], authors: [], teams: [], error: null, isPending: true };
}

function PullRequestAuthorChoices({
  value,
  options,
  scope,
  onChange,
}: {
  value: ReadonlyArray<string>;
  options: ReadonlyArray<PullRequestAuthorFacet>;
  scope: ReadonlyArray<PullRequestFilterOptionScope>;
  onChange: (authors: ReadonlyArray<string>) => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const hosted = useHostedFilterOptions(scope, "authors", query);
  const selected = new Set(value.map((login) => login.toLowerCase()));
  const visible = [
    ...value.flatMap((login) => selectedPullRequestAuthor(options, hosted.authors, login) ?? []),
    ...pullRequestAuthorChoices(options, hosted.authors, query)
      .filter(({ actor }) => !selected.has(actor.login.toLowerCase()))
      .slice(0, 30),
  ];
  return (
    <>
      <MenuSearchInput
        autoFocus
        busy={hosted.isPending}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder={gt("Search authors")}
        aria-label={gt("Search authors")}
      />
      {value.length > 0 ? (
        <MenuItem closeOnClick={false} onClick={() => onChange([])}>
          <T>Clear authors</T>
        </MenuItem>
      ) : null}
      {visible.map((option) => {
        const login = option.actor.login.toLowerCase();
        const checked = selected.has(login);
        return (
          <MenuCheckboxItem
            key={login}
            checked={checked}
            disabled={!checked && value.length >= MAX_PULL_REQUEST_AUTHOR_FILTERS}
            onCheckedChange={(next) =>
              onChange(
                next
                  ? [...value, option.actor.login]
                  : value.filter((held) => held.toLowerCase() !== login),
              )
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <PullRequestActorAvatar actor={option.actor} />
              <span className="min-w-0 flex-1 truncate">{option.actor.login}</span>
              {option.mergedCount > 0 ? (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {gt("{count, plural, one {{count} merge loaded} other {{count} merges loaded}}", {
                    count: option.mergedCount,
                  })}
                </span>
              ) : null}
            </span>
          </MenuCheckboxItem>
        );
      })}
      {visible.length === 0 && !hosted.isPending ? (
        <MenuItem disabled>
          {hosted.error === null
            ? gt("No authors found")
            : gt("Couldn't search authors on the host")}
        </MenuItem>
      ) : null}
    </>
  );
}

function PullRequestAuthorFilter({
  value,
  hasTeam,
  options,
  scope,
  onChange,
}: {
  value: ReadonlyArray<string>;
  hasTeam: boolean;
  options: ReadonlyArray<PullRequestAuthorFacet>;
  scope: ReadonlyArray<PullRequestFilterOptionScope>;
  onChange: (authors: ReadonlyArray<string>) => void;
}) {
  const gt = useGT();
  return (
    <MenuSub>
      <MenuSubTrigger>
        <UserRoundIcon aria-hidden className="size-3.5" />
        <span className="flex-1">
          <T>Authors</T>
        </span>
        <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
          {value.length === 0 && !hasTeam ? gt("Anyone") : value.join(", ")}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        <PullRequestAuthorChoices
          value={value}
          options={options}
          scope={scope}
          onChange={onChange}
        />
      </MenuSubPopup>
    </MenuSub>
  );
}

const authorTeamKey = ({ host, organization, slug }: PullRequestAuthorTeam) =>
  `${host}/${organization}/${slug}`.toLowerCase();

function authorTeamLabel({ host, organization, slug }: PullRequestAuthorTeam) {
  return host === "github.com" ? `${organization}/${slug}` : `${host}/${organization}/${slug}`;
}

function PullRequestAuthorTeamChoices({
  value,
  scope,
  onChange,
}: {
  value: PullRequestAuthorTeam | undefined;
  scope: ReadonlyArray<PullRequestFilterOptionScope>;
  onChange: (team: PullRequestAuthorTeam | undefined) => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const hosted = useHostedFilterOptions(scope, "teams", query);
  const selected = value ? authorTeamKey(value) : "";
  const teams = new Map(hosted.teams.map((team) => [authorTeamKey(team), team]));
  if (value) teams.set(selected, value);
  return (
    <>
      <MenuSearchInput
        autoFocus
        busy={hosted.isPending}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder={gt("Search GitHub teams")}
        aria-label={gt("Search GitHub teams")}
      />
      <MenuRadioGroup value={selected} onValueChange={(key) => onChange(teams.get(key))}>
        <MenuRadioItem value="">
          <T>No team</T>
        </MenuRadioItem>
        {[...teams].map(([key, team]) => (
          <MenuRadioItem key={key} value={key}>
            {authorTeamLabel(team)}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {hosted.error !== null ? (
        <MenuItem disabled>
          <T>Couldn't load GitHub teams</T>
        </MenuItem>
      ) : !hosted.isPending && teams.size === 0 ? (
        <MenuItem disabled>
          <T>No GitHub teams found</T>
        </MenuItem>
      ) : null}
    </>
  );
}

function PullRequestAuthorTeamFilter({
  value,
  scope,
  onChange,
}: Parameters<typeof PullRequestAuthorTeamChoices>[0]) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        <UsersRoundIcon aria-hidden className="size-3.5" />
        <span className="flex-1">
          <T>Author team</T>
        </span>
        <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
          {value ? authorTeamLabel(value) : <T>No team</T>}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        <PullRequestAuthorTeamChoices value={value} scope={scope} onChange={onChange} />
      </MenuSubPopup>
    </MenuSub>
  );
}

function PullRequestLabelChoices({
  value,
  options,
  scope,
  onChange,
}: {
  value: ReadonlyArray<string>;
  options: ReadonlyArray<PullRequestLabelFacet>;
  scope: ReadonlyArray<PullRequestFilterOptionScope>;
  onChange: (labels: ReadonlyArray<string>) => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const hosted = useHostedFilterOptions(scope, "labels", query);
  const selected = new Set(value.map((name) => name.toLowerCase()));
  const choices = pullRequestLabelChoices(options, hosted.labels, query);
  const visible = [
    ...selectedPullRequestLabels(options, hosted.labels, value).filter(
      (label) => !choices.some((option) => option.name.toLowerCase() === label.name.toLowerCase()),
    ),
    ...choices,
  ];
  return (
    <>
      <MenuSearchInput
        autoFocus
        busy={hosted.isPending}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder={gt("Search labels")}
        aria-label={gt("Search labels")}
      />
      {visible.length === 0 && !hosted.isPending ? (
        <MenuItem disabled>
          {hosted.error === null ? gt("No labels found") : gt("Couldn't search labels on the host")}
        </MenuItem>
      ) : null}
      {visible.map((option) => {
        const key = option.name.toLowerCase();
        const dot = pullRequestLabelColor(option.color);
        return (
          <MenuCheckboxItem
            key={key}
            checked={selected.has(key)}
            onCheckedChange={(next) =>
              onChange(
                next
                  ? [...value, option.name]
                  : value.filter((name) => name.toLowerCase() !== option.name.toLowerCase()),
              )
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full bg-muted-foreground"
                {...(dot ? { style: { backgroundColor: dot } } : {})}
              />
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              {option.count > 0 ? (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {option.count}
                </span>
              ) : null}
            </span>
          </MenuCheckboxItem>
        );
      })}
    </>
  );
}

function PullRequestLabelFilter({
  value,
  options,
  scope,
  onChange,
}: {
  value: ReadonlyArray<string>;
  options: ReadonlyArray<PullRequestLabelFacet>;
  scope: ReadonlyArray<PullRequestFilterOptionScope>;
  onChange: (labels: ReadonlyArray<string>) => void;
}) {
  const gt = useGT();
  return (
    <MenuSub>
      <MenuSubTrigger>
        <TagIcon aria-hidden className="size-3.5" />
        <span className="flex-1">
          <T>Labels</T>
        </span>
        <span className="text-xs text-muted-foreground">
          {value.length === 0
            ? gt("Any", { $context: "no label filter" })
            : gt("{count, plural, one {{count} selected} other {{count} selected}}", {
                count: value.length,
              })}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        <PullRequestLabelChoices
          value={value}
          options={options}
          scope={scope}
          onChange={onChange}
        />
      </MenuSubPopup>
    </MenuSub>
  );
}

export function PullRequestFiltersMenu({
  onOpenChange,
  state,
  stateOptions,
  onState,
  involvement,
  involvementOptions,
  onInvolvement,
  filters,
  onFilters,
  authorOptions = [],
  labelOptions = [],
  optionScope,
  canFilterByAuthorTeam,
  host,
  hostOptions,
  onHost,
  server,
  serverOptions,
  onServer,
  projects,
  projectId,
  projectEnvironmentId,
  unavailable,
  onProject,
}: {
  onOpenChange?: (open: boolean) => void;
  state: PullRequestListState;
  stateOptions: ReadonlyArray<PullRequestFilterOption<PullRequestListState>>;
  onState: (state: PullRequestListState) => void;
  involvement: PullRequestInvolvement;
  involvementOptions: ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>>;
  onInvolvement: (involvement: PullRequestInvolvement) => void;
  filters: PullRequestListFilters;
  onFilters: (filters: PullRequestListFilters) => void;
  authorOptions?: ReadonlyArray<PullRequestAuthorFacet>;
  labelOptions?: ReadonlyArray<PullRequestLabelFacet>;
  optionScope: ReadonlyArray<PullRequestFilterOptionScope>;
  canFilterByAuthorTeam: boolean;
  host: string | undefined;
  hostOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onHost: (host: string | undefined) => void;
  server: EnvironmentId | undefined;
  serverOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onServer: (server: EnvironmentId | undefined) => void;
  projects: ReadonlyArray<ProjectFaviconProject & { readonly id: ProjectId }>;
  projectId: ProjectId | undefined;
  projectEnvironmentId: EnvironmentId | undefined;
  unavailable: ReadonlyMap<string, string>;
  onProject: (projectId: ProjectId | undefined, environmentId: EnvironmentId | undefined) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const selectedLabels = (filters.labels ?? []).flatMap((group) => group);
  const selectedAuthors = filters.authors ?? (filters.author ? [filters.author] : []);
  const filterCount = [
    state !== "open",
    involvement !== "all",
    host,
    server,
    projectId,
    filters.draft,
    filters.review,
    filters.checks,
    filters.authorTeam,
    ...selectedAuthors,
    ...selectedLabels,
  ].filter(Boolean).length;
  const updateFilters = (next: Partial<PullRequestListFilters>) =>
    onFilters(
      Object.fromEntries(
        Object.entries({ ...filters, ...next }).filter(([, value]) => value !== undefined),
      ) as PullRequestListFilters,
    );
  const updateFilter = (key: keyof PullRequestListFilters, value: string) =>
    updateFilters({
      [key]: value === UNFILTERED_VALUE ? undefined : value,
    } as Partial<PullRequestListFilters>);
  const projectValue =
    projectId === undefined || projectEnvironmentId === undefined
      ? ALL_PROJECTS_VALUE
      : pullRequestProjectKey({ id: projectId, environmentId: projectEnvironmentId });
  const projectOptions: ReadonlyArray<PullRequestFilterOption<string>> = [
    { value: ALL_PROJECTS_VALUE, label: gt("All projects"), Icon: LayersIcon },
    ...projects
      .toSorted(
        (left, right) =>
          Number(unavailable.has(pullRequestProjectKey(left))) -
          Number(unavailable.has(pullRequestProjectKey(right))),
      )
      .map((project) => ({
        value: pullRequestProjectKey(project),
        label: project.title,
        Icon: FolderGit2Icon,
        project,
        ...(unavailable.has(pullRequestProjectKey(project))
          ? { unavailable: unavailable.get(pullRequestProjectKey(project)) }
          : {}),
      })),
  ];
  return (
    <Menu onOpenChange={onOpenChange}>
      <MenuTrigger render={<Button variant="outline" />}>
        <ListFilterIcon className="size-4" />
        <span>
          <T>Filters</T>
        </span>
        {filterCount > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
            {filterCount}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        <PullRequestFilterRadioSubmenu
          label={gt("State", { $context: "pull request filter" })}
          value={state}
          options={stateOptions}
          onChange={onState}
        />
        <PullRequestFilterRadioSubmenu
          label={gt("Involvement")}
          value={involvement}
          options={involvementOptions}
          onChange={onInvolvement}
        />
        <MenuSeparator />
        <PullRequestAuthorFilter
          value={selectedAuthors}
          hasTeam={filters.authorTeam !== undefined}
          options={authorOptions}
          scope={optionScope}
          onChange={(authors) =>
            updateFilters({ author: undefined, authors: authors.length ? authors : undefined })
          }
        />
        {canFilterByAuthorTeam || filters.authorTeam !== undefined ? (
          <PullRequestAuthorTeamFilter
            value={filters.authorTeam}
            scope={optionScope}
            onChange={(authorTeam) => updateFilters({ authorTeam })}
          />
        ) : null}
        <PullRequestLabelFilter
          value={selectedLabels}
          options={labelOptions}
          scope={optionScope}
          onChange={(labels) =>
            updateFilters({
              labels: labels.length === 0 ? undefined : labels.slice(0, 10).map((label) => [label]),
            })
          }
        />
        <PullRequestFilterRadioSubmenu
          label={gt("Draft", { $context: "pull request filter" })}
          value={filters.draft ?? UNFILTERED_VALUE}
          options={resolveFilterOptions(DRAFT_OPTIONS, resolve)}
          onChange={(draft) => updateFilter("draft", draft)}
        />
        <PullRequestFilterRadioSubmenu
          label={gt("Review", { $context: "pull request filter" })}
          value={filters.review ?? UNFILTERED_VALUE}
          options={resolveFilterOptions(REVIEW_OPTIONS, resolve)}
          onChange={(review) => updateFilter("review", review)}
        />
        <PullRequestFilterRadioSubmenu
          label={gt("Checks", { $context: "pull request filter" })}
          value={filters.checks ?? UNFILTERED_VALUE}
          options={resolveFilterOptions(CHECKS_OPTIONS, resolve)}
          onChange={(checks) => updateFilter("checks", checks)}
        />
        {hostOptions.length > 2 ? (
          <>
            <MenuSeparator />
            <PullRequestFilterRadioSubmenu
              label={gt("Host", { $context: "pull request filter" })}
              value={host ?? ALL_HOSTS_VALUE}
              options={hostOptions}
              onChange={(next) => onHost(next === ALL_HOSTS_VALUE ? undefined : next)}
            />
          </>
        ) : null}
        {serverOptions.length > 2 ? (
          <>
            <MenuSeparator />
            <PullRequestFilterRadioSubmenu
              label={gt("Server", { $context: "pull request filter" })}
              value={server ?? ALL_SERVERS_VALUE}
              options={serverOptions}
              onChange={(next) =>
                onServer(next === ALL_SERVERS_VALUE ? undefined : (next as EnvironmentId))
              }
            />
          </>
        ) : null}
        <MenuSeparator />
        <PullRequestFilterRadioSubmenu
          label={gt("Project", { $context: "pull request filter" })}
          value={projectValue}
          options={projectOptions}
          onChange={(next) => {
            const project = projects.find((candidate) => pullRequestProjectKey(candidate) === next);
            if (project) onProject(project.id, project.environmentId);
            else if (projectId !== undefined) onProject(undefined, undefined);
          }}
        />
      </MenuPopup>
    </Menu>
  );
}
