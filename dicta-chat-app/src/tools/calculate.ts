// `calculate` — safely evaluate a basic arithmetic expression.
// Allowed characters: digits, + - * / ( ) . and whitespace. Anything else
// is rejected before evaluation. Used by `mathScenario`.
import type { Tool } from "./types";

export const calculate: Tool = {
  spec: {
    name: "calculate",
    description:
      "Safely evaluate a basic arithmetic expression. " +
      "Allowed characters: digits, + - * / ( ) . and whitespace. Example: '2 + 3 * 4'.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Arithmetic expression to evaluate.",
        },
      },
      required: ["expression"],
    },
    outputSchema: {
      type: "object",
      properties: {
        expression: { type: "string" },
        result: { type: "number" },
        error: { type: "string" },
      },
    },
  },
  impl: async ({ expression }) => {
    const expr = String(expression ?? "");
    if (!/^[\d+\-*/().\s]+$/.test(expr)) {
      return { error: "Expression contains disallowed characters." };
    }
    try {
      const result = new Function(`"use strict"; return (${expr})`)();
      if (typeof result !== "number" || !isFinite(result)) {
        return { error: "Expression did not evaluate to a finite number." };
      }
      return { expression: expr, result };
    } catch {
      return { error: "Could not evaluate expression." };
    }
  },
};
