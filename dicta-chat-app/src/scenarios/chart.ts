// Chart / graph / plot scenario. Fires on explicit visualization requests
// in English or Hebrew. The model generates realistic data inline (no tool
// calls — keeps the prompt small and the round-trip latency tight) and
// renders a Card containing the requested chart type plus a FollowUpBlock
// for sensible next questions.
//
// `bindings: false` and `toolCalls: false` strip the large reactive-state
// and tool-protocol prompt sections — chart authoring doesn't need them
// and DictaLM is more reliable with a leaner system prompt.
import type { PromptSpec } from "@openuidev/lang-core";
import { COMMON_PREAMBLE, COMMON_RULES } from "./_shared";
import type { Scenario } from "./types";

// `\b` is ASCII-only in JS regex, so Hebrew tokens need their own pattern.
const MATCH_EN =
  /\b(chart|graph|plot|bar\s*chart|line\s*chart|pie\s*chart|area\s*chart|scatter|histogram|distribution|trend|trends|metrics|visualize|visualization|visualise|visualisation)\b/i;
const MATCH_HE =
  /(^|[\s.,!?:;'"()־׳״])(תרשים|תרשימים|גרף|גרפים|דיאגרמה|דיאגרמות|פאי|עוגה|עמודות|מגמה|מגמות|התפלגות|המחשה|לתאר|להמחיש)(?=[\s.,!?:;'"()־׳״]|$)/;

const SCENARIO_RULES: string[] = [
  "Pick the chart shape that matches the data: `BarChart` for categories, `LineChart` for time series / trends, `AreaChart` for cumulative trends, `PieChart` or `RadialChart` for parts-of-a-whole, `ScatterChart` for correlations, `RadarChart` for multi-axis comparisons. If the user named a specific chart type, use exactly that one.",
  "Use POSITIONAL arguments — `BarChart(labels, series, variant?, xLabel?, yLabel?)`. Pass labels as an array of strings and series as an array of `Series(category, values)` calls.",
  'For `PieChart` / `RadialChart`, pass `PieChart(labels, values, "pie")` or `RadialChart(labels, values)`. No `Series` wrapper.',
  "Generate realistic, plausible data when the user doesn't supply numbers — pick values that match the scale of the topic (percentages sum to ~100; revenue in thousands or millions; counts in proportion).",
  "Title the chart with a `CardHeader(title, subtitle?)` at the top of the Card, then the chart, then the FollowUpBlock.",
  "Match the user's language for labels, series categories, the title, and the FollowUpItem text. Lang keywords (Card, CardHeader, BarChart, Series, etc.) stay in English.",
];

const SCENARIO_EXAMPLES: string[] = [
  // English bar chart — categorical data, single series.
  'root = Card([header, chart, fu])\n' +
    'header = CardHeader("Top 5 Programming Languages by Users", "Estimated millions of active developers")\n' +
    'chart = BarChart(labels, [Series("Users (M)", values)], "grouped", "Language", "Users (millions)")\n' +
    'labels = ["JavaScript", "Python", "Java", "C#", "Go"]\n' +
    'values = [17.4, 15.7, 12.1, 8.5, 6.3]\n' +
    'fu = FollowUpBlock([FollowUpItem("Show the same data as a pie chart"), FollowUpItem("Add TypeScript and Rust to the comparison"), FollowUpItem("Which of these is growing fastest?")])',
  // Hebrew line chart — time series, multiple series.
  'root = Card([header, chart, fu])\n' +
    'header = CardHeader("הכנסות רבעוניות 2024", "במיליוני שקלים")\n' +
    'chart = LineChart(months, [Series("מוצר A", a), Series("מוצר B", b)], "natural", "רבעון", "הכנסות")\n' +
    'months = ["Q1", "Q2", "Q3", "Q4"]\n' +
    'a = [4.2, 5.1, 5.8, 6.4]\n' +
    'b = [3.8, 3.6, 4.3, 5.2]\n' +
    'fu = FollowUpBlock([FollowUpItem("הוסף תחזית לשנת 2025"), FollowUpItem("הראה גם את אחוזי הצמיחה"), FollowUpItem("השווה למתחרים בענף")])',
  // English pie chart — parts of a whole.
  'root = Card([header, chart, fu])\n' +
    'header = CardHeader("Browser Market Share", "Global desktop, % share")\n' +
    'chart = PieChart(labels, values, "donut")\n' +
    'labels = ["Chrome", "Safari", "Edge", "Firefox", "Other"]\n' +
    'values = [65, 12, 11, 7, 5]\n' +
    'fu = FollowUpBlock([FollowUpItem("Break Other down further"), FollowUpItem("Show the mobile market share instead"), FollowUpItem("How has this changed over the last 5 years?")])',
];

export const chartScenario: Scenario = {
  name: "chart",
  description: "Charts, graphs, plots — categorical, time series, parts-of-whole, scatter, radar.",
  matches: ({ userMessage }) =>
    MATCH_EN.test(userMessage) || MATCH_HE.test(userMessage),
  build: (base): PromptSpec => ({
    ...base,
    preamble: COMMON_PREAMBLE,
    additionalRules: [...COMMON_RULES, ...SCENARIO_RULES],
    toolCalls: false,
    bindings: false,
    inlineMode: false,
    examples: SCENARIO_EXAMPLES,
  }),
};
