// Barrel that composes the tool registry from the per-tool modules.
// Adding a new tool is a two-step move:
//   1. Drop a `src/tools/<name>.ts` file exporting a `Tool` object.
//   2. Import it here and add it to `REGISTRY`.
// The `tools` (descriptors) and `toolProvider` (implementations) maps are
// derived automatically — there's no other place to wire it up.
import type { ToolSpec } from "@openuidev/lang-core";
import { calculate } from "./calculate";
import { getCurrentTime } from "./get-current-time";
import { randomNumber } from "./random-number";
import { wikipediaLookup } from "./wikipedia-lookup";
import type { Tool, ToolArgs } from "./types";

const REGISTRY: Tool[] = [
  calculate,
  getCurrentTime,
  randomNumber,
  wikipediaLookup,
];

// Descriptors the prompt generator sees (passed via PromptSpec.tools).
export const tools: ToolSpec[] = REGISTRY.map((t) => t.spec);

// Function map the Renderer dispatches against for `Query(name, …)` /
// `Mutation(name, …)` reserved calls.
export const toolProvider: Record<string, (args: ToolArgs) => Promise<unknown>> =
  Object.fromEntries(REGISTRY.map((t) => [t.spec.name, t.impl]));

// Individual descriptor re-exports — scenarios import only the ones they
// advertise. Naming follows `<toolName>Tool` to match the previous flat
// module shape so existing imports in scenarios keep working.
export const calculateTool: ToolSpec = calculate.spec;
export const getCurrentTimeTool: ToolSpec = getCurrentTime.spec;
export const randomNumberTool: ToolSpec = randomNumber.spec;
export const wikipediaLookupTool: ToolSpec = wikipediaLookup.spec;

export type { Tool, ToolArgs, ToolImpl } from "./types";
