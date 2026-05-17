// Per-request system prompt builder. Delegates the per-use-case prompt
// construction to `@/scenarios` — each scenario is a self-contained
// TypeScript module that owns its triggering heuristic, preamble overrides,
// rules, tool subset, and feature flags. This file is the seam where the
// pre-generated component spec is plugged in and `generatePrompt` is
// invoked; everything else lives in the scenario files.
import { generatePrompt } from "@openuidev/lang-core";
import componentSpec from "@/generated/component-spec.json";
import { pickScenario } from "@/scenarios";
import { FOLLOWUP_RULES } from "@/scenarios/_shared";
import type { ComponentSpec } from "@/scenarios/types";

export interface BuildSystemPromptResult {
  prompt: string;
  intent: string;
  scenarioDescription: string;
  isFollowup: boolean;
}

function hasPriorAssistantTurn(
  history?: ReadonlyArray<{ role: string; content: string }>,
): boolean {
  if (!history?.length) return false;
  for (const m of history) {
    if (
      m?.role === "assistant" &&
      typeof m.content === "string" &&
      m.content.trim().length > 0
    ) {
      return true;
    }
  }
  return false;
}

export function buildSystemPrompt(
  userMessage: string,
  history?: ReadonlyArray<{ role: string; content: string }>,
): BuildSystemPromptResult {
  const scenario = pickScenario({ userMessage, history });
  const spec = scenario.build(componentSpec as unknown as ComponentSpec);
  const isFollowup = hasPriorAssistantTurn(history);

  if (isFollowup) {
    // The model has already seen its own prior Lang in the conversation
    // history — that's its best shape reference. Re-injecting the
    // scenario's worked examples on top of that pressures the model to
    // re-emit the sample data instead of modifying the live structure
    // the user is iterating on. Drop the examples + the toolExamples
    // (which carry the same risk for tool-using scenarios) and append
    // the FOLLOWUP_RULES so the model treats this as a continuation.
    spec.examples = [];
    if (Array.isArray(spec.toolExamples)) spec.toolExamples = [];
    spec.additionalRules = [
      ...(spec.additionalRules ?? []),
      ...FOLLOWUP_RULES,
    ];
  }

  return {
    prompt: generatePrompt(spec),
    intent: scenario.name,
    scenarioDescription: scenario.description,
    isFollowup,
  };
}
