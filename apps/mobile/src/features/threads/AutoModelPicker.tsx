import type { AutoModelRouting, ModelCapabilities, ModelSelection } from "@t3tools/contracts";
import {
  autoModelCandidateKey,
  getAutoModelReasoningOption,
  getModelSelectionStringOptionValue,
  withAutoModelReasoningOption,
} from "@t3tools/shared/model";
import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

type Model = {
  readonly label: string;
  readonly selection: ModelSelection;
  readonly capabilities?: ModelCapabilities | null;
  readonly isUnavailable?: boolean;
};
type Slot = "quick" | "standard" | "deep";

type AutoModelPickerProps = {
  readonly visible: boolean;
  readonly routing: AutoModelRouting | null;
  readonly currentModel: ModelSelection;
  readonly models: ReadonlyArray<Model>;
  readonly available: boolean;
  readonly keySaved: boolean;
  readonly onChange: (routing: AutoModelRouting | null) => void;
  readonly onClose: () => void;
};

function AutoModelPickerContent(props: AutoModelPickerProps) {
  const models = useMemo(
    () =>
      props.models.filter(
        (model) =>
          !model.isUnavailable && model.selection.instanceId === props.currentModel.instanceId,
      ),
    [props.models, props.currentModel.instanceId],
  );
  const defaultDeep =
    models.find((model) => model.selection.model === props.currentModel.model)?.selection.model ??
    models[models.length - 1]?.selection.model ??
    "";
  const defaultQuick =
    models.find((model) => model.selection.model !== defaultDeep)?.selection.model ?? "";
  const selectionFor = (model: string): ModelSelection =>
    model === props.currentModel.model
      ? props.currentModel
      : (models.find((candidate) => candidate.selection.model === model)?.selection ?? {
          instanceId: props.currentModel.instanceId,
          model,
        });
  const candidates = props.routing?.candidates;
  const [quick, setQuick] = useState<ModelSelection>(
    () => candidates?.[0] ?? selectionFor(defaultQuick),
  );
  const [standard, setStandard] = useState<ModelSelection | null>(() =>
    candidates?.length === 3 ? (candidates[1] ?? null) : null,
  );
  const [deep, setDeep] = useState<ModelSelection>(
    () => candidates?.[candidates.length - 1] ?? selectionFor(defaultDeep),
  );
  const [slot, setSlot] = useState<Slot>("quick");

  const selected = slot === "quick" ? quick : slot === "standard" ? standard : deep;
  const reasoning = getAutoModelReasoningOption(
    models.find((model) => model.selection.model === selected?.model)?.capabilities,
  );
  const choose = (model: string) => {
    const next = selected?.model === model ? selected : model ? selectionFor(model) : null;
    if (slot === "quick") setQuick(next ?? selectionFor(""));
    else if (slot === "standard") setStandard(next);
    else setDeep(next ?? selectionFor(""));
  };
  const chooseReasoning = (value: string | null) => {
    if (!selected || !reasoning) return;
    const next = withAutoModelReasoningOption(selected, reasoning.id, value);
    if (slot === "quick") setQuick(next);
    else if (slot === "standard") setStandard(next);
    else setDeep(next);
  };
  const valid =
    quick.model !== "" &&
    deep.model !== "" &&
    new Set([quick, deep, ...(standard ? [standard] : [])].map(autoModelCandidateKey)).size ===
      (standard ? 3 : 2);
  const save = () => {
    if (!valid) return;
    props.onChange({
      candidates: [quick, ...(standard ? [standard] : []), deep],
    });
    props.onClose();
  };

  return (
    <View className="flex-1 justify-end bg-black/50">
      <View className="max-h-[85%] rounded-t-3xl bg-background px-5 pb-10 pt-5">
        <Text className="text-lg font-semibold text-foreground">Auto model</Text>
        <Text className="mt-1 text-sm text-muted-foreground">
          The latest prompt is sent to TypeSafe AI's Jev for each turn. Deep is used when routing is
          uncertain.
        </Text>
        {!props.available ? (
          <Text className="mt-2 text-sm text-muted-foreground">
            Enable Auto in Settings → Environments → this environment.
          </Text>
        ) : !props.keySaved ? (
          <Text className="mt-2 text-sm text-muted-foreground">
            Add a TypeSafe API key in that environment's settings, or set TYPESAFE_API_KEY on its
            server.
          </Text>
        ) : null}
        <View className="mt-5 flex-row gap-2">
          {(
            [
              ["quick", quick],
              ["standard", standard],
              ["deep", deep],
            ] as const
          ).map(([value, model]) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityLabel={`Choose ${value} model`}
              onPress={() => setSlot(value)}
              className={`min-w-0 flex-1 rounded-xl border px-2 py-3 ${slot === value ? "border-primary bg-primary/10" : "border-border"}`}
            >
              <Text className="text-xs font-semibold text-foreground">
                {value[0]!.toUpperCase() + value.slice(1)}
              </Text>
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                {models.find((item) => item.selection.model === model?.model)?.label ?? "Optional"}
              </Text>
            </Pressable>
          ))}
        </View>
        <ScrollView className="mt-4 max-h-48">
          {slot === "standard" ? (
            <Pressable onPress={() => choose("")} className="border-b border-border py-3">
              <Text className="text-sm text-foreground">No middle model</Text>
            </Pressable>
          ) : null}
          {models.map((model) => (
            <Pressable
              key={model.selection.model}
              onPress={() => choose(model.selection.model)}
              className="border-b border-border py-3"
            >
              <Text
                className={`text-sm ${selected?.model === model.selection.model ? "font-semibold text-primary" : "text-foreground"}`}
              >
                {model.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        {reasoning && selected ? (
          <View className="mt-4 gap-2">
            <Text className="text-sm font-semibold text-foreground">Intelligence</Text>
            <View className="flex-row flex-wrap gap-2">
              {[{ id: "", label: "Provider default" }, ...reasoning.choices].map((choice) => {
                const chosen =
                  (getModelSelectionStringOptionValue(selected, reasoning.id) ?? "") === choice.id;
                return (
                  <Pressable
                    key={choice.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: chosen }}
                    onPress={() => chooseReasoning(choice.id || null)}
                    className={`rounded-lg border px-3 py-2 ${chosen ? "border-primary bg-primary/10" : "border-border"}`}
                  >
                    <Text className={`text-xs ${chosen ? "text-primary" : "text-foreground"}`}>
                      {choice.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}
        {!valid ? (
          <Text className="mt-2 text-xs text-destructive">
            Choose two or three different model and intelligence combinations.
          </Text>
        ) : null}
        <View className="mt-5 flex-row justify-end gap-5">
          {props.routing ? (
            <Pressable
              onPress={() => {
                props.onChange(null);
                props.onClose();
              }}
              accessibilityRole="button"
            >
              <Text className="font-medium text-foreground">Turn off</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={props.onClose} accessibilityRole="button">
            <Text className="font-medium text-foreground">Cancel</Text>
          </Pressable>
          <Pressable
            onPress={save}
            disabled={!valid || !props.available}
            accessibilityRole="button"
          >
            <Text
              className={`font-semibold ${valid && props.available ? "text-primary" : "text-muted-foreground"}`}
            >
              {props.routing ? "Save" : "Turn on"}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export function AutoModelPicker(props: AutoModelPickerProps) {
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      {props.visible ? <AutoModelPickerContent {...props} /> : null}
    </Modal>
  );
}
