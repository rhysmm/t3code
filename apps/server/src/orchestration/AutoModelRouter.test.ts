import { describe, expect, it, vi } from "@effect/vitest";
import { ProviderInstanceId, type AutoModelRouting } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { routeAutoModel, validateAutoModelRouting } from "./AutoModelRouter.ts";

const instanceId = ProviderInstanceId.make("codex");
const encodeTestJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeTestJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const routing: AutoModelRouting = {
  candidates: [
    { instanceId, model: "fast" },
    { instanceId, model: "balanced" },
    { instanceId, model: "strong" },
  ],
};

describe("Auto model routing", () => {
  it.effect("selects a stronger model for a deeper turn", () =>
    Effect.gen(function* () {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          encodeTestJson({
            answers: { complexity: { type: "choice", choice: "deep", confidence: 0.93 } },
          }),
          { status: 200 },
        ),
      );

      const selected = yield* routeAutoModel({
        routing,
        prompt: "Trace the race across server and clients, then fix it.",
        threadTitle: "Chat",
        apiKey: "test-key",
        fetcher,
      });

      expect(selected.model).toBe("strong");
      expect(fetcher).toHaveBeenCalledOnce();
      const [url, request] = fetcher.mock.calls[0]!;
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(decodeTestJson(String(request?.body))).toMatchObject({
        model: "jev-latest",
        state: { prompt: "Trace the race across server and clients, then fix it." },
        questions: { complexity: { type: "choice" } },
      });
    }),
  );

  it.effect("keeps the chosen model's intelligence setting", () =>
    Effect.gen(function* () {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          encodeTestJson({
            answers: { complexity: { type: "choice", choice: "quick", confidence: 0.93 } },
          }),
          { status: 200 },
        ),
      );
      const candidates: AutoModelRouting = {
        candidates: [
          { instanceId, model: "fast", options: [{ id: "reasoningEffort", value: "low" }] },
          { instanceId, model: "strong", options: [{ id: "reasoningEffort", value: "high" }] },
        ],
      };
      const selected = yield* routeAutoModel({
        routing: candidates,
        prompt: "Quick question",
        threadTitle: "Chat",
        apiKey: "test-key",
        fetcher,
      });
      expect(selected).toEqual(candidates.candidates[0]);
    }),
  );

  it.effect("uses the strongest allowed model when Jev is uncertain", () =>
    Effect.gen(function* () {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          encodeTestJson({
            answers: { complexity: { type: "choice", choice: "quick", confidence: 0.2 } },
          }),
          { status: 200 },
        ),
      );

      const selected = yield* routeAutoModel({
        routing,
        prompt: "Do it",
        threadTitle: "Chat",
        apiKey: "test-key",
        fetcher,
      });
      expect(selected.model).toBe("strong");
    }),
  );

  it.effect("reports a rejected API key instead of silently routing", () =>
    Effect.gen(function* () {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 401 }));
      const error = yield* Effect.flip(
        routeAutoModel({ routing, prompt: "Fix it", threadTitle: "Chat", apiKey: "bad", fetcher }),
      );
      expect(error.message).toContain("TypeSafe AI rejected the API key");
    }),
  );

  it("rejects a shortlist that would move an established thread between providers", () => {
    expect(() => validateAutoModelRouting(routing, ProviderInstanceId.make("claudeAgent"))).toThrow(
      "provider instance",
    );
  });

  it("allows one model at different intelligence levels but rejects identical choices", () => {
    const quick = {
      instanceId,
      model: "same-model",
      options: [{ id: "reasoningEffort", value: "low" }],
    };
    const deep = {
      instanceId,
      model: "same-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    expect(() => validateAutoModelRouting({ candidates: [quick, deep] })).not.toThrow();
    expect(() => validateAutoModelRouting({ candidates: [quick, { ...quick }] })).toThrow(
      "distinct model and intelligence combinations",
    );
  });
});
