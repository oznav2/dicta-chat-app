// Shared scenario interface. Each scenario module owns its triggering
// heuristic and its prompt-construction strategy. The router (./index.ts)
// walks the registered scenarios first-match-wins.
import type { PromptSpec } from "@openuidev/lang-core";

/** Subset of PromptSpec produced by `openui generate --json-schema`. */
export type ComponentSpec = Pick<PromptSpec, "root" | "components"> &
  Partial<Pick<PromptSpec, "examples">>;

export interface ScenarioContext {
  /** The latest user message text. */
  userMessage: string;
  /**
   * Recent conversation history (latest last). Roles match OpenAI shape:
   * "user" | "assistant" | "system". Provided so future scenarios can
   * inspect prior turns (e.g. detect a follow-up to a tool result).
   */
  history?: ReadonlyArray<{ role: string; content: string }>;
}

export interface Scenario {
  /** Stable identifier — surfaced for logging / debugging. */
  name: string;
  /** Brief human description. */
  description: string;
  /** Heuristic — return true to claim the message. */
  matches: (ctx: ScenarioContext) => boolean;
  /** Build the final PromptSpec given the pre-generated component spec. */
  build: (base: ComponentSpec) => PromptSpec;
}
