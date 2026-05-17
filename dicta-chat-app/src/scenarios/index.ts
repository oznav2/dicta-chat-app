// Scenario router — picks the right per-use-case prompt module given the
// latest user message (and, optionally, recent history).
//
// Order matters: more specific scenarios go first, with the catch-all
// `conversationScenario` last (its `matches` always returns true). Adding a
// new scenario is a two-step move:
//   1. Drop a `src/scenarios/<name>.ts` file exporting a `Scenario`.
//   2. Register it here, ordered by selectivity.
//
// Future seam — `pickScenario` can be upgraded to a cheap LLM classifier
// call when heuristics aren't enough; the public signature stays the same.
import { chartScenario } from "./chart";
import { conversationScenario } from "./conversation";
import { factualScenario } from "./factual";
import { formScenario } from "./form";
import { mathScenario } from "./math";
import { tableScenario } from "./table";
import { wikipediaScenario } from "./wikipedia";
import type { Scenario, ScenarioContext } from "./types";

const SCENARIOS: Scenario[] = [
  chartScenario, //     "show me a bar chart / graph / pie chart"
  tableScenario, //     "table / compare / top N / ranking"
  formScenario, //      "build me a form / dashboard / wizard"
  mathScenario, //      "calculate / כפול / what time / random"
  wikipediaScenario, // "who was X / what is Y" — augmented with live Wikipedia data
  factualScenario, //   same triggers, kept as a fallback (model-only knowledge)
  conversationScenario, // fallback — greetings, thanks, follow-ups
];

// Component-name signatures we look for in the last assistant Lang to
// pick a "sticky" scenario for follow-up turns. The model's prior reply
// is the strongest signal about what shape the user is currently
// iterating on — much stronger than running the regex on a terse
// follow-up like "add Java" or "make it red".
const SHAPE_TO_SCENARIO: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(BarChart|LineChart|AreaChart|HorizontalBarChart|RadarChart|PieChart|RadialChart|SingleStackedBarChart|ScatterChart)\s*\(/,
    "chart",
  ],
  [/\bTable\s*\(\s*\[\s*Col\s*\(/, "table"],
  [
    /\b(Form|Tabs|Accordion|SectionBlock|Steps|Carousel|ImageGallery)\s*\(/,
    "form",
  ],
  [/\bQuery\s*\(\s*"wikipedia_lookup"/, "wikipedia"],
];

function findLastAssistantContent(
  history: ScenarioContext["history"],
): string | null {
  if (!history?.length) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role === "assistant" && typeof m.content === "string" && m.content) {
      return m.content;
    }
  }
  return null;
}

function detectShapeScenario(lang: string): Scenario | null {
  for (const [re, name] of SHAPE_TO_SCENARIO) {
    if (re.test(lang)) return SCENARIOS.find((s) => s.name === name) ?? null;
  }
  return null;
}

export function pickScenario(ctx: ScenarioContext): Scenario {
  // 1. Specific scenario regex on the latest user message wins. The user
  //    can pivot at any time ("now show as a pie chart", "צור לי טופס
  //    יצירת קשר"); these explicit triggers always override stickiness.
  for (const s of SCENARIOS) {
    if (s.name === "conversation") continue; // catch-all — defer
    if (s.matches(ctx)) return s;
  }

  // 2. No specific match. If a prior assistant turn emitted a known
  //    component shape, stay in that scenario so the follow-up keeps
  //    the relevant rules. The first turn was the user's explicit opt-in
  //    to structured UI; follow-ups inherit that intent regardless of
  //    phrasing length or verb. To pivot, the user just names a new
  //    shape — which step 1 catches.
  const lastAssistant = findLastAssistantContent(ctx.history);
  if (lastAssistant) {
    const sticky = detectShapeScenario(lastAssistant);
    if (sticky) return sticky;
  }

  // 3. Genuine fall-through — greetings, thanks, true chit-chat.
  return conversationScenario;
}

export { SCENARIOS };
export type { Scenario, ScenarioContext } from "./types";
