// Table / list-of / comparison scenario. Fires on explicit tabular
// requests in English or Hebrew. Tables use the `Table(columns: Col[])`
// shape with typed columns (`"string"` / `"number"` / `"action"`), so the
// renderer can align numbers right, format them, and wire action columns
// as buttons. The model generates plausible data inline when none is
// supplied. Ends with a FollowUpBlock for follow-up questions.
//
// `bindings: false` and `toolCalls: false` strip the reactive-state and
// tool sections from the prompt — tables don't need either.
import type { PromptSpec } from "@openuidev/lang-core";
import { COMMON_PREAMBLE, COMMON_RULES } from "./_shared";
import type { Scenario } from "./types";

// `\b` is ASCII-only in JS regex, so Hebrew tokens need their own pattern.
const MATCH_EN =
  /\b(table|tabular|spreadsheet|columns|rows|compare|comparison|comparing|side[-\s]?by[-\s]?side|ranking|ranked|top\s+\d+|list\s+of|matrix|leaderboard)\b/i;
const MATCH_HE =
  /(^|[\s.,!?:;'"()־׳״])(טבלה|טבלת|טבלאות|רשימת|השוואה|להשוות|מדורג|דירוג|מטריצה|עמודות|שורות|טבלאי)(?=[\s.,!?:;'"()־׳״]|$)/;

const SCENARIO_RULES: string[] = [
  "Render the answer as a `Card([title, table, followUps])` where `table = Table([Col(label, data, type?), …])`. Each `Col` is a vertical column — the first column is typically a string label column, the rest are numeric or string data columns.",
  'Pass the column type as the third positional argument: `Col("Revenue", values, "number")` for numbers (right-aligned, formatted), `Col("Name", labels, "string")` for text, `Col("Status", flags, "string")` for short categorical labels. Omit the type only when defaulting to string.',
  "All Col arrays MUST have the same length — one entry per row. Use empty strings (\"\") or 0 for missing cells, never null/undefined.",
  "Generate realistic, plausible data when the user doesn't supply numbers — pick values that match the topic's scale (prices in the right currency, populations in the right magnitude, percentages summing sensibly).",
  "Title with a `TextContent(\"<table title>\", \"large-heavy\")` on the line above the table. Match the user's language for the title, column labels, and string cells. Lang keywords (Card, Table, Col, TextContent) stay in English.",
  "Pick a sensible row count: 5–10 rows for a comparison, up to 15 for a leaderboard / top-N list. Don't pad with filler rows.",
];

const SCENARIO_EXAMPLES: string[] = [
  // English comparison table — mixed string and number columns.
  'root = Card([title, tbl, fu])\n' +
    'title = TextContent("Programming Language Comparison", "large-heavy")\n' +
    'tbl = Table([langCol, yearCol, paradigmCol, popCol])\n' +
    'langCol = Col("Language", langs, "string")\n' +
    'yearCol = Col("First Released", years, "number")\n' +
    'paradigmCol = Col("Paradigm", paradigms, "string")\n' +
    'popCol = Col("Users (M)", users, "number")\n' +
    'langs = ["Python", "JavaScript", "Java", "C#", "Go", "Rust"]\n' +
    'years = [1991, 1995, 1995, 2000, 2009, 2015]\n' +
    'paradigms = ["Multi-paradigm", "Multi-paradigm", "OOP", "OOP", "Concurrent", "Systems"]\n' +
    'users = [15.7, 17.4, 12.1, 8.5, 6.3, 3.2]\n' +
    'fu = FollowUpBlock([FollowUpItem("Sort by Users descending"), FollowUpItem("Add TypeScript and Kotlin"), FollowUpItem("Which is best for backend APIs?")])',
  // Hebrew ranking table — top-N format.
  'root = Card([title, tbl, fu])\n' +
    'title = TextContent("עשר הערים הגדולות בישראל", "large-heavy")\n' +
    'tbl = Table([rankCol, cityCol, popCol, districtCol])\n' +
    'rankCol = Col("דירוג", ranks, "number")\n' +
    'cityCol = Col("עיר", cities, "string")\n' +
    'popCol = Col("אוכלוסייה (אלפים)", pops, "number")\n' +
    'districtCol = Col("מחוז", districts, "string")\n' +
    'ranks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]\n' +
    'cities = ["ירושלים", "תל אביב-יפו", "חיפה", "ראשון לציון", "פתח תקווה", "אשדוד", "נתניה", "באר שבע", "בני ברק", "חולון"]\n' +
    'pops = [981, 467, 285, 260, 256, 226, 224, 213, 213, 200]\n' +
    'districts = ["ירושלים", "תל אביב", "חיפה", "מרכז", "מרכז", "דרום", "מרכז", "דרום", "תל אביב", "תל אביב"]\n' +
    'fu = FollowUpBlock([FollowUpItem("הראה את האוכלוסייה כתרשים עמודות"), FollowUpItem("הוסף את שטח העיר וצפיפות האוכלוסין"), FollowUpItem("איזה עיר גדלה הכי מהר בעשור האחרון?")])',
];

export const tableScenario: Scenario = {
  name: "table",
  description: "Tables, comparisons, rankings — typed-column Table+Col with realistic inline data.",
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
