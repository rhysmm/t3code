import type { AutoModelRouting, ModelSelection } from "@t3tools/contracts";
import { autoModelCandidateKey } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const JevResponse = Schema.Struct({
  answers: Schema.Struct({
    complexity: Schema.Struct({
      type: Schema.Literal("choice"),
      choice: Schema.Literals(["quick", "standard", "deep"]),
      confidence: Schema.Number,
    }),
  }),
});
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(JevResponse));

class AutoModelConfigurationError extends Schema.TaggedError<AutoModelConfigurationError>()(
  "AutoModelConfigurationError",
  { message: Schema.String },
) {}

export function validateAutoModelRouting(
  routing: AutoModelRouting,
  boundInstanceId?: ModelSelection["instanceId"],
): void {
  const candidates = routing.candidates;
  if (candidates.length < 2 || candidates.length > 3) {
    throw new Error("Auto needs two or three choices, ordered from fast to strong.");
  }
  const instanceId = candidates[0]?.instanceId;
  if (
    !instanceId ||
    candidates.some((candidate) => candidate.instanceId !== instanceId) ||
    (boundInstanceId && instanceId !== boundInstanceId)
  ) {
    throw new Error("Auto models must belong to the thread's provider instance.");
  }
  if (new Set(candidates.map(autoModelCandidateKey)).size !== candidates.length) {
    throw new Error("Choose distinct model and intelligence combinations for Auto.");
  }
}

export const routeAutoModel = Effect.fn("routeAutoModel")(function* (input: {
  readonly routing: AutoModelRouting;
  readonly prompt: string;
  readonly threadTitle: string;
  readonly boundInstanceId?: ModelSelection["instanceId"];
  readonly apiKey: string | undefined;
  readonly fetcher?: typeof fetch;
}) {
  validateAutoModelRouting(input.routing, input.boundInstanceId);
  const candidates = input.routing.candidates;
  const strongest = candidates[candidates.length - 1]!;
  if (!input.apiKey) {
    return yield* new AutoModelConfigurationError({
      message: "Add a TypeSafe API key in Settings → Integrations to use Auto.",
    });
  }

  const result = yield* Effect.gen(function* () {
    const body = yield* encodeRequest({
      model: "jev-latest",
      state: { threadTitle: input.threadTitle, prompt: input.prompt },
      questions: {
        complexity: {
          type: "choice",
          instructions:
            "How much coding-agent work does the user's latest request require? Judge the work, not the length of the message.",
          criteria: {
            quick: "A narrow answer, small edit, or routine task with little investigation.",
            standard: "Several steps or files, with some investigation and verification.",
            deep: "Ambiguous, architectural, high-risk, or broad work requiring substantial investigation and verification.",
          },
        },
      },
    });
    const response = yield* Effect.tryPromise(async () => {
      const response = await (input.fetcher ?? fetch)("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 401 || response.status === 403) return { kind: "auth" } as const;
      if (!response.ok) throw new Error(`Jev returned ${response.status}`);
      return { kind: "answer", text: await response.text() } as const;
    });
    return response.kind === "auth"
      ? response
      : ({ kind: "answer", value: yield* decodeResponse(response.text) } as const);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Auto model routing fell back to the strongest candidate", {
        cause,
      }).pipe(Effect.as(null)),
    ),
  );

  if (result?.kind === "auth") {
    return yield* new AutoModelConfigurationError({
      message: "TypeSafe AI rejected the API key. Update it in Settings → Integrations.",
    });
  }
  if (!result || result.value.answers.complexity.confidence < 0.45) return strongest;
  const choice = result.value.answers.complexity.choice;
  return choice === "quick" ? candidates[0]! : choice === "standard" ? candidates[1]! : strongest;
});
