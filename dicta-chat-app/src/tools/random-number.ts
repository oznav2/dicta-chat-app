// `random_number` — returns a uniformly distributed integer in [min, max]
// inclusive. Used by `mathScenario`.
import type { Tool } from "./types";

export const randomNumber: Tool = {
  spec: {
    name: "random_number",
    description: "Returns a uniformly distributed integer in [min, max] (inclusive).",
    inputSchema: {
      type: "object",
      properties: {
        min: { type: "integer", description: "Lower bound (inclusive)." },
        max: { type: "integer", description: "Upper bound (inclusive)." },
      },
      required: ["min", "max"],
    },
    outputSchema: {
      type: "object",
      properties: {
        min: { type: "integer" },
        max: { type: "integer" },
        value: { type: "integer" },
        error: { type: "string" },
      },
    },
  },
  impl: async ({ min, max }) => {
    const lo = Math.floor(Number(min));
    const hi = Math.floor(Number(max));
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
      return { error: "Invalid range." };
    }
    const value = Math.floor(Math.random() * (hi - lo + 1)) + lo;
    return { min: lo, max: hi, value };
  },
};
