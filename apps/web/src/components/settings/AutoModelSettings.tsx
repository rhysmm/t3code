import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function AutoModelEnvironmentSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.autoModel);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save Auto model settings",
  });
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const keySaved = saved.apiKey.length > 0;

  const save = async (patch: { enabled?: boolean; apiKey?: string }) => {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { autoModel: patch } },
      });
      if (result._tag !== "Success") return;
      if (
        (patch.enabled !== undefined && result.value.autoModel.enabled !== patch.enabled) ||
        (patch.apiKey !== undefined &&
          Boolean(result.value.autoModel.apiKey) !== Boolean(patch.apiKey))
      ) {
        setSaveError(
          "This environment did not save the Auto setting. Restart or update its T3 server, then try again.",
        );
        return;
      }
      if (patch.apiKey !== undefined) setApiKey("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["autoModel"]}
        title="Enable Auto model selection"
        description="Allow the composer to choose a model for each turn using TypeSafe AI's Jev. Configure Quick and Deep models in the composer."
        control={
          <Switch
            checked={saved.enabled}
            disabled={saving}
            onCheckedChange={(enabled) => void save({ enabled: Boolean(enabled) })}
            aria-label="Enable Auto model selection"
          />
        }
      />
      <form
        className="grid gap-3 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (apiKey.trim()) void save({ apiKey: apiKey.trim(), enabled: true });
        }}
      >
        <label htmlFor={`typesafe-api-key-${environmentId}`} className="text-sm font-medium">
          TypeSafe API key
        </label>
        <Input
          id={`typesafe-api-key-${environmentId}`}
          type="password"
          autoComplete="off"
          size="sm"
          placeholder={keySaved ? "Stored key; enter a new one to replace it" : "Paste your key"}
          value={apiKey}
          disabled={saving}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {keySaved
              ? "A key is saved on this environment. It is never shown again."
              : "Saved on this environment. An existing TYPESAFE_API_KEY also works."}
          </p>
          <div className="flex shrink-0 gap-2">
            {keySaved ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={saving}
                onClick={() => void save({ apiKey: "" })}
              >
                Remove
              </Button>
            ) : null}
            <Button type="submit" size="xs" disabled={saving || !apiKey.trim()}>
              Save key
            </Button>
          </div>
        </div>
        {saveError ? (
          <p role="alert" className="text-xs text-destructive">
            {saveError}
          </p>
        ) : null}
      </form>
    </>
  );
}

export function AutoModelSettings() {
  const { scope, environment } = useSettingsScope();
  const environmentId = scope.environmentIds.length === 1 ? environment?.environmentId : null;
  return (
    <SettingsSection id="auto-model" title="Auto model selection">
      {environmentId ? (
        <AutoModelEnvironmentSettings environmentId={environmentId} />
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Select one environment to configure its TypeSafe API key and Auto setting.
        </p>
      )}
    </SettingsSection>
  );
}
