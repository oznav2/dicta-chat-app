// Shared types for the per-tool modules. Each tool exports a single object
// `{ spec, impl }` — `spec` is the ToolSpec descriptor the prompt
// generator sees, `impl` is the function the Renderer dispatches against
// when it evaluates a `Query(name, …)` reserved call.
import type { ToolSpec } from "@openuidev/lang-core";

export type ToolArgs = Record<string, unknown>;

export type ToolImpl = (args: ToolArgs) => Promise<unknown>;

export interface Tool {
  spec: ToolSpec;
  impl: ToolImpl;
}
