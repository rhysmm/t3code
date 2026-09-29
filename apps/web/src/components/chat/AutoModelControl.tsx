import type { AutoModelRouting, ModelCapabilities, ModelSelection } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  autoModelCandidateKey,
  canConfigureAutoModelSelections,
  getAutoModelReasoningOption,
  getModelSelectionStringOptionValue,
  withAutoModelReasoningOption,
} from "@t3tools/shared/model";
import { useState } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useComposerMenuProps } from "./composerEventScope";

type Slot = "quick" | "standard" | "deep";
type Draft = { quick: ModelSelection; standard: ModelSelection | null; deep: ModelSelection };

export function AutoModelControl(props: {
  readonly enabled: boolean;
  readonly routing: AutoModelRouting | null;
  readonly currentModel: ModelSelection;
  readonly currentChoice: ModelSelection | null;
  readonly models: ReadonlyArray<{
    slug: string;
    name: string;
    capabilities?: ModelCapabilities | null;
    isUnavailable?: boolean;
  }>;
  readonly disabled: boolean;
  readonly available: boolean;
  readonly keySaved: boolean;
  readonly onChange: (enabled: boolean, routing: AutoModelRouting | null) => void;
  readonly getModelDisabledReason: (model: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const floatingLayerProps = useComposerMenuProps();
  const [draft, setDraft] = useState<Draft | null>(null);
  const choiceModel = props.models.find((model) => model.slug === props.currentChoice?.model);
  const choiceReasoning = getAutoModelReasoningOption(choiceModel?.capabilities);
  const choiceLevel = choiceReasoning?.choices.find(
    (choice) =>
      choice.id === getModelSelectionStringOptionValue(props.currentChoice, choiceReasoning.id),
  )?.label;
  const choiceLabel = props.currentChoice
    ? `${choiceModel?.name ?? props.currentChoice.model}${choiceLevel ? ` · ${choiceLevel}` : ""}`
    : null;
  const models = props.models.filter(
    (model) => !model.isUnavailable && props.getModelDisabledReason(model.slug) === null,
  );
  const defaultDeep = models.some((model) => model.slug === props.currentModel.model)
    ? props.currentModel.model
    : models[models.length - 1]?.slug;
  const defaultQuick = models.find((model) => model.slug !== defaultDeep)?.slug;
  const selected: ReadonlyArray<ModelSelection> = props.routing?.candidates ?? [
    { instanceId: props.currentModel.instanceId, model: defaultQuick ?? "" },
    defaultDeep === props.currentModel.model
      ? props.currentModel
      : { instanceId: props.currentModel.instanceId, model: defaultDeep ?? "" },
  ];
  const selectable = (selection: ModelSelection | undefined) =>
    selection && models.some((model) => model.slug === selection.model)
      ? selection
      : { instanceId: props.currentModel.instanceId, model: "" };
  const current: Draft = draft ?? {
    quick: selectable(selected[0]),
    standard: selected.length === 3 ? selectable(selected[1]) : null,
    deep: selectable(selected[selected.length - 1]),
  };
  const { quick, standard, deep } = current;
  const chooseModel = (selection: ModelSelection | null, model: string): ModelSelection =>
    selection?.model === model
      ? selection
      : model === props.currentModel.model
        ? props.currentModel
        : { instanceId: props.currentModel.instanceId, model };
  const valid =
    quick.model !== "" &&
    deep.model !== "" &&
    (standard === null || standard.model !== "") &&
    new Set([quick, ...(standard ? [standard] : []), deep].map(autoModelCandidateKey)).size ===
      (standard ? 3 : 2);

  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        setDraft(null);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant={props.enabled ? "secondary" : "ghost-muted"}
            disabled={props.disabled || !canConfigureAutoModelSelections(models)}
            aria-label={
              props.enabled && choiceLabel
                ? `Auto currently using ${choiceLabel}. Configure automatic model selection`
                : "Configure automatic model selection"
            }
          >
            Auto
            {props.enabled ? (
              choiceLabel ? (
                <span className="max-w-32 truncate">· {choiceLabel}</span>
              ) : (
                " on"
              )
            ) : null}
          </Button>
        }
      />
      <PopoverPopup {...floatingLayerProps} width="md" align="start">
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">Choose a model each turn</p>
            <p className="text-xs text-muted-foreground">
              The latest prompt is sent to TypeSafe AI's Jev for each turn. Quick goes first; Deep
              is the fallback if routing is uncertain or unavailable.
            </p>
          </div>
          {!props.available ? (
            <p className="text-xs text-muted-foreground">
              Enable Auto for this environment in{" "}
              <Link to="/settings/integrations" className="underline">
                Settings → Integrations
              </Link>
              .
            </p>
          ) : !props.keySaved ? (
            <p className="text-xs text-muted-foreground">
              Add a TypeSafe API key in Settings → Integrations, or set TYPESAFE_API_KEY on the
              server.
            </p>
          ) : null}
          {(
            [
              ["quick", "Quick", quick],
              ["standard", "Standard (optional)", standard],
              ["deep", "Deep", deep],
            ] as const satisfies ReadonlyArray<readonly [Slot, string, ModelSelection | null]>
          ).map(([slot, label, selection]) => {
            const reasoning = getAutoModelReasoningOption(
              models.find((model) => model.slug === selection?.model)?.capabilities,
            );
            return (
              <div
                key={slot}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 text-xs"
              >
                <label className="grid gap-1">
                  <span>{label}</span>
                  <select
                    className="min-w-0 rounded-md border border-input bg-background px-2 py-1 text-xs"
                    value={selection?.model ?? ""}
                    onChange={(event) =>
                      setDraft({
                        ...current,
                        [slot]:
                          slot === "standard" && !event.target.value
                            ? null
                            : chooseModel(selection, event.target.value),
                      })
                    }
                  >
                    <option value="">
                      {slot === "standard" ? "No middle model" : "Choose model"}
                    </option>
                    {models.map((model) => (
                      <option key={model.slug} value={model.slug}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </label>
                {reasoning && selection ? (
                  <label className="grid gap-1">
                    <span>Intelligence</span>
                    <select
                      className="min-w-0 rounded-md border border-input bg-background px-2 py-1 text-xs"
                      value={getModelSelectionStringOptionValue(selection, reasoning.id) ?? ""}
                      onChange={(event) =>
                        setDraft({
                          ...current,
                          [slot]: withAutoModelReasoningOption(
                            selection,
                            reasoning.id,
                            event.target.value || null,
                          ),
                        })
                      }
                    >
                      <option value="">Provider default</option>
                      {reasoning.choices.map((choice) => (
                        <option key={choice.id} value={choice.id}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            );
          })}
          {!valid ? (
            <p className="text-xs text-destructive">
              Choose two or three different model and intelligence combinations.
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            {props.enabled ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  props.onChange(false, props.routing);
                  setOpen(false);
                }}
              >
                Turn off
              </Button>
            ) : null}
            <Button
              size="xs"
              disabled={!valid || !props.available}
              onClick={() => {
                const candidates = [quick, ...(standard ? [standard] : []), deep];
                props.onChange(true, { candidates });
                setOpen(false);
              }}
            >
              {props.enabled ? "Done" : "Turn on"}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
