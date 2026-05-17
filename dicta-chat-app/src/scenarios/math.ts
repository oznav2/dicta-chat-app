// Math / time / random scenario — small, tool-aware prompt.
// Triggers on arithmetic verbs, time/date words, and random-number requests
// in Hebrew or English. Enables `toolCalls` so the model can emit Query()
// calls, but skips `bindings` (no $variables) since these answers are
// one-shot: compute → render → done.
import type { PromptSpec } from "@openuidev/lang-core";
import { calculateTool, getCurrentTimeTool, randomNumberTool } from "@/tools";
import { COMMON_PREAMBLE, COMMON_RULES } from "./_shared";
import type { Scenario } from "./types";

// `\b` is ASCII-only in JS regex, so Hebrew tokens need their own pattern.
const MATCH_EN =
  /\b(calculate|calc|compute|math|sum|product|times|multiply|divide|square|root|date|now|random)\b/i;
const MATCH_HE =
  /(^|[\s.,!?:;'"()־׳״])(כפול|פעמים|חלקי|חישוב|חשב|זמן|אקראי|מקרי|מספר אקראי)(?=[\s.,!?:;'"()־׳״]|$)/;

// U+200E is the Unicode LEFT-TO-RIGHT MARK (LRM) — an invisible strong-LTR
// character. Prefixing a mostly-numeric string with LRM forces the rendered
// paragraph to flow left-to-right even inside an RTL bubble (Hebrew chat
// context). The character is invisible to the user but visible to the
// bidi algorithm. Without it, "34 ÷ 12 = 2.83…" reads right-to-left
// because digits + ÷ + = are all neutral/weak characters and inherit the
// enclosing Hebrew direction.
const LRM = "‎";

const SCENARIO_RULES: string[] = [
  "ALWAYS render the answer as a Card with TextContent. Never reply in plain markdown — every numeric answer is structured UI.",
  'Shape (copy exactly):\n```\ncalc = Query("calculate", { expression: "<the expression>" }, { result: 0 })\nroot = Card([t])\nt = TextContent("\\u200E<lhs> = " + calc.result, "large-heavy")\n```',
  "Always use the calculate tool via Query for numeric results — do not pre-compute the answer yourself, the runtime resolves the value client-side and the result appears in the rendered Card.",
  "Keep the Card minimal: ONE TextContent only. No extra follow-ups, related queries, or supplementary commentary.",
  "LANGUAGE LOCK: write EVERY user-visible string entirely in the user's language. If the user asked in Hebrew, the displayed string contains ONLY Hebrew characters, digits, math operators (×/÷/+/−), and the result number — NO English words at all. Do NOT write 'Answer:', 'Result:', 'is', 'equals', '(rounded …)' or any parenthetical English clarifier. Use 'כפול' or '×' for multiplication, 'חלקי' or '÷' for division, 'ועוד' or '+' for addition, 'פחות' or '−' for subtraction. The Lang keywords (root, Card, Query, TextContent) stay English, but they are NOT visible to the user.",
  'LEFT-TO-RIGHT LOCK FOR MATH: every visible math expression string MUST begin with the literal escape "\\u200E" (the LRM / left-to-right mark, U+200E) so it renders left-to-right inside the Hebrew chat context. Example: `TextContent("\\u200E34 ÷ 12 = " + calc.result, "large-heavy")`. Do not add `\\u200E` to time / non-math strings; only to numeric ones.',
  'TIME QUERIES — STRICT: when the user asks for the current time, emit EXACTLY these three lines and NOTHING ELSE in the body:\n```\nnow = Query("get_current_time", {}, { now: "" })\nroot = Card([t])\nt = TextContent(now.now, "large-heavy")\n```\nRules:\n• You DO NOT know the current time. The ONLY way to obtain it is via the `Query("get_current_time", ...)` call shown above; the runtime substitutes the actual value at render time.\n• NEVER invent or hardcode a time string like "14:37", "2025-08-19", or any other date/time literal — that is a HALLUCINATION bug. The tool returns the real time formatted as "HH:MM AM/PM" (e.g. "20:04 PM"); writing your own guess produces wrong output.\n• Do NOT add `## Current Time` headings, descriptive paragraphs, server-clock disclaimers, timezone notes, or any other prose. ONE Card containing ONE TextContent — period.\n• The TextContent\'s first argument is the bare identifier `now.now` (no quotes, no concatenation, no template syntax).',
];

const SCENARIO_EXAMPLES: string[] = [
  // English calculate. LRM is harmless here (no RTL context to fight) but
  // included for consistency so the model always copies the same shape.
  `calc = Query("calculate", { expression: "45 * 12" }, { expression: "", result: 0 })\n` +
    `root = Card([t])\n` +
    `t = TextContent("${LRM}45 × 12 = " + calc.result, "large-heavy")`,
  // Hebrew calculate (division — the user-visible string starts with LRM
  // and contains ONLY digits + math operator + numeric result, zero
  // English words. Reads left-to-right even in an RTL bubble.).
  `calc = Query("calculate", { expression: "34 / 12" }, { expression: "", result: 0 })\n` +
    `root = Card([t])\n` +
    `t = TextContent("${LRM}34 ÷ 12 = " + calc.result, "large-heavy")`,
  // Current time — kept deliberately minimal: NO prefix label, just the
  // bare formatted time as a single TextContent. This sidesteps the
  // template-literal trap entirely (the model doesn't have to concatenate
  // anything; the time value is the WHOLE visible string). The tool
  // already returns "HH:MM AM/PM" (e.g. "20:04 PM"), so the rendered Card
  // shows exactly that — no "(server clock)" / "(local time)" prose.
  // Identifier MUST be `now` to match the Query binding; do NOT invent
  // alternates like `calc.now` or `${now}`.
  `now = Query("get_current_time", {}, { now: "" })\n` +
    `root = Card([t])\n` +
    `t = TextContent(now.now, "large-heavy")`,
];

export const mathScenario: Scenario = {
  name: "math",
  description: "Arithmetic, time, and random-number queries. Minimal prompt + 3 tools.",
  matches: ({ userMessage }) =>
    MATCH_EN.test(userMessage) || MATCH_HE.test(userMessage),
  build: (base): PromptSpec => ({
    ...base,
    preamble: COMMON_PREAMBLE,
    additionalRules: [...COMMON_RULES, ...SCENARIO_RULES],
    tools: [calculateTool, getCurrentTimeTool, randomNumberTool],
    toolExamples: SCENARIO_EXAMPLES,
    toolCalls: true,
    bindings: false,
    inlineMode: false,
  }),
};
