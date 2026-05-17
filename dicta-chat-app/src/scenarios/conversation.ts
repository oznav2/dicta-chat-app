// Default fallback scenario — short, conversational replies in any
// language. Greetings, thanks, follow-up confirmations, generic small-talk.
// The leanest prompt of the four: no tools, no bindings, no Lang
// requirement. `inlineMode: true` so the model is free to answer in plain
// prose without `root = …`.
import type { PromptSpec } from "@openuidev/lang-core";
import { COMMON_PREAMBLE, COMMON_RULES } from "./_shared";
import type { Scenario } from "./types";

const SCENARIO_RULES: string[] = [
  "Answer in one or two short sentences of plain markdown prose. Do NOT emit OpenUI Lang or `root = …`.",
  "No headings, no bullet lists, no code blocks unless the user explicitly asked for one.",
  "Match the user's language and tone (greetings stay informal; questions about your capabilities stay concise).",
];

export const conversationScenario: Scenario = {
  name: "conversation",
  description: "Fallback for chit-chat, greetings, short confirmations.",
  // Always matches — used as the last scenario in the registry.
  matches: () => true,
  build: (base): PromptSpec => ({
    ...base,
    preamble: COMMON_PREAMBLE,
    additionalRules: [...COMMON_RULES, ...SCENARIO_RULES],
    toolCalls: false,
    bindings: false,
    inlineMode: true,
  }),
};
