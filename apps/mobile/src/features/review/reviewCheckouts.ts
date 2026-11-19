import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ReviewDiffPreviewInput } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { formatEnvironmentQueryError } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import {
  buildReviewGitSectionItem,
  type LiveReviewSectionKind,
  type ReviewSectionItem,
} from "./reviewModel";

export interface ReviewCheckout {
  readonly cwd: string;
  readonly projectId: ProjectId;
  readonly label: string;
}

export interface ReviewCheckoutGroup {
  readonly cwd: string;
  readonly title: string;
  readonly section: ReviewSectionItem | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

const EMPTY_CHECKOUTS: ReadonlyArray<ReviewCheckout> = Object.freeze([]);
const checkoutSelectionsAtom = Atom.family((threadKey: string) =>
  Atom.make(EMPTY_CHECKOUTS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:checkouts:${threadKey}`),
  ),
);

export function useReviewCheckoutSelection(threadKey: string) {
  const atom = checkoutSelectionsAtom(threadKey);
  const checkouts = useAtomValue(atom);
  return {
    checkouts,
    toggleCheckout(checkout: ReviewCheckout) {
      const current = appAtomRegistry.get(atom);
      const key = normalizeProjectPathForComparison(checkout.cwd);
      const remaining = current.filter(
        (item) => normalizeProjectPathForComparison(item.cwd) !== key,
      );
      appAtomRegistry.set(
        atom,
        remaining.length === current.length ? [...remaining, checkout] : remaining,
      );
    },
  };
}

export function useReviewCheckoutDiffs(input: {
  readonly environmentId: EnvironmentId;
  readonly checkouts: ReadonlyArray<ReviewCheckout>;
  readonly kind: LiveReviewSectionKind | null;
  readonly fullPatchCwd: string | null;
}) {
  const { environmentId, checkouts, kind, fullPatchCwd } = input;
  const queries = useMemo(
    () =>
      kind === null
        ? []
        : checkouts.map((checkout) => {
            const previewInput = {
              cwd: checkout.cwd,
              checkoutProjectId: checkout.projectId,
              sourceKind: kind,
              ...(checkout.cwd === fullPatchCwd ? {} : { metadataOnly: true }),
            } satisfies ReviewDiffPreviewInput;
            return {
              checkout,
              previewInput,
              atom: reviewEnvironment.diffPreview({ environmentId, input: previewInput }),
            };
          }),
    [checkouts, environmentId, kind, fullPatchCwd],
  );
  const results = useAtomValue(
    useMemo(() => Atom.make((get) => queries.map((query) => get(query.atom))), [queries]),
  );
  const groups = queries.map(({ checkout, previewInput }, index): ReviewCheckoutGroup => {
    const result = results[index]!;
    const data = AsyncResult.getOrElse(result, () => null);
    const source = data?.sources.find(
      (entry): entry is typeof entry & { kind: LiveReviewSectionKind } =>
        entry.kind === previewInput.sourceKind,
    );
    return {
      cwd: checkout.cwd,
      title: checkout.label,
      section: source
        ? {
            ...buildReviewGitSectionItem(source),
            id: JSON.stringify([normalizeProjectPathForComparison(checkout.cwd), source.kind]),
            previewInput,
          }
        : null,
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      isPending: result.waiting,
    };
  });

  return {
    groups,
    refreshCheckouts() {
      for (const query of queries) appAtomRegistry.refresh(query.atom);
    },
  };
}
