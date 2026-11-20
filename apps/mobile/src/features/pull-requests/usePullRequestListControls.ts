import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { DEFAULT_PR_LIST_CONTROLS, type PullRequestListControls } from "./pullRequestList";

export function usePullRequestListControls() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.pullRequestListFilters
    : undefined;
  const environmentId = saved?.environmentId ?? null;
  const controlsFor = (environment: string | null) =>
    saved?.controls[environment ?? ""] ?? DEFAULT_PR_LIST_CONTROLS;
  const setEnvironmentId = (next: string | null) =>
    savePreferences({
      transform: (current) => ({
        pullRequestListFilters: {
          controls: current.pullRequestListFilters?.controls ?? {},
          environmentId: next,
        },
      }),
    });
  const setControls = (
    environment: string | null,
    controls:
      | PullRequestListControls
      | ((current: PullRequestListControls) => PullRequestListControls),
  ) =>
    savePreferences({
      transform: (current) => {
        const savedFilters = current.pullRequestListFilters;
        const key = environment ?? "";
        const previous = savedFilters?.controls[key] ?? DEFAULT_PR_LIST_CONTROLS;
        return {
          pullRequestListFilters: {
            environmentId: savedFilters?.environmentId ?? null,
            controls: {
              ...savedFilters?.controls,
              [key]: typeof controls === "function" ? controls(previous) : controls,
            },
          },
        };
      },
    });
  return { environmentId, controlsFor, setEnvironmentId, setControls } as const;
}
