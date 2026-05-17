// Wikipedia-augmented factual scenario. Matches the same "who/what/when…"
// triggers as factualScenario but takes precedence in the router. Instead
// of relying on DictaLM's pre-trained knowledge, the model calls
// `Query("wikipedia_lookup", …)` to fetch the real article server-side
// (via /api/wikipedia proxy), then renders the consolidated payload as a
// Card with the Wikipedia logo, hero image, title, multi-section markdown
// body, and source link footer.
//
// Design choice: the server proxy composes a single markdown body string
// from the article. The model never iterates over sections in Lang — it
// just passes `wiki.body` straight to `MarkDownRenderer`. This keeps the
// worked example tiny enough for DictaLM to copy reliably.
import type { PromptSpec } from "@openuidev/lang-core";
import { wikipediaLookupTool } from "@/tools";
import { COMMON_PREAMBLE, COMMON_RULES } from "./_shared";
import type { Scenario } from "./types";

// Same patterns as factualScenario (kept in sync deliberately so both
// scenarios see the same set of queries; the router picks wikipedia
// first). `\b` is ASCII-only in JS regex, so Hebrew needs its own pattern.
const MATCH_EN =
  /\b(who|what|when|where|why|how|explain|describe|tell me about|history of|what is)\b/i;
const MATCH_HE =
  /(^|[\s.,!?:;'"()־׳״])(מי\s+(הוא|היה|הם)|מה\s+(זה|הוא)|מתי|איפה|למה|איך|הסבר|ספר\s+לי|מהי|מהו|תאר)(?=[\s.,!?:;'"()־׳״]|$)/;

const SCENARIO_RULES: string[] = [
  'For factual questions, call `Query("wikipedia_lookup", { query: "…", language: "he" })` (or `"en"`) exactly once. The `query` is the subject/topic in the user\'s language; the `language` is "he" if the user wrote in Hebrew, otherwise "en".',
  "Render the result as a Card in this exact order: [logo, title, hero, body, footer]. Copy the worked example shape literally — do not add, omit, or reorder children.",
  "Pass `wiki.body` directly to MarkDownRenderer — it already contains the full structured markdown (intro paragraphs + `##` section bodies + `###` subsection bodies). Do NOT compose your own markdown, paraphrase the sections, or duplicate content.",
  "Pass `wiki.thumbnail` to ImageBlock even though it might be an empty string — the component handles the empty case with a placeholder. Do NOT fall back to a different image or omit the ImageBlock.",
  "The footer is a MarkDownRenderer with the source URL: `\"מקור: [ויקיפדיה](\" + wiki.url + \") · עודכן: \" + wiki.lastModified` (Hebrew) or `\"Source: [Wikipedia](\" + wiki.url + \") · Updated: \" + wiki.lastModified` (English). Do NOT invent or alter the URL.",
  "If the tool returns an empty `title` (no Wikipedia article matched), emit a single `root = Card([t])` with `t = TextContent(\"לא נמצא ערך תואם בוויקיפדיה\", \"default\")` (Hebrew) or `t = TextContent(\"No matching Wikipedia article was found\", \"default\")` (English). Do NOT invent facts when the tool returned nothing.",
];

// Served from public/wikipedia-logo.svg. Hosting the asset ourselves
// avoids upload.wikimedia.org rejecting requests on UA policy and
// removes the cross-origin image-load failure that surfaced in Next's
// dev overlay every time a Wikipedia card rendered.
const WIKI_LOGO_URL = "/wikipedia-logo.svg";

const SCENARIO_EXAMPLES: string[] = [
  // Hebrew worked example — query like "מי היה ברל כצנלסון?".
  `wiki = Query("wikipedia_lookup", { query: "ברל כצנלסון", language: "he" }, { title: " ", description: "", url: "", thumbnail: "/wikipedia-logo.svg", body: "", lastModified: "" })\n` +
    `root = Card([logo, title, hero, body, footer])\n` +
    `logo = Image("Wikipedia", "${WIKI_LOGO_URL}")\n` +
    `title = TextContent(wiki.title, "large-heavy")\n` +
    `hero = ImageBlock(wiki.thumbnail, wiki.title)\n` +
    `body = MarkDownRenderer(wiki.body)\n` +
    `footer = MarkDownRenderer("מקור: [ויקיפדיה](" + wiki.url + ") · עודכן: " + wiki.lastModified)`,
  // English worked example — same structure, English copy in the footer.
  `wiki = Query("wikipedia_lookup", { query: "Barbara McClintock", language: "en" }, { title: " ", description: "", url: "", thumbnail: "/wikipedia-logo.svg", body: "", lastModified: "" })\n` +
    `root = Card([logo, title, hero, body, footer])\n` +
    `logo = Image("Wikipedia", "${WIKI_LOGO_URL}")\n` +
    `title = TextContent(wiki.title, "large-heavy")\n` +
    `hero = ImageBlock(wiki.thumbnail, wiki.title)\n` +
    `body = MarkDownRenderer(wiki.body)\n` +
    `footer = MarkDownRenderer("Source: [Wikipedia](" + wiki.url + ") · Updated: " + wiki.lastModified)`,
];

export const wikipediaScenario: Scenario = {
  name: "wikipedia",
  description: "Factual Q&A backed by a live Wikipedia article lookup.",
  matches: ({ userMessage }) =>
    MATCH_EN.test(userMessage) || MATCH_HE.test(userMessage),
  build: (base): PromptSpec => ({
    ...base,
    preamble: COMMON_PREAMBLE,
    additionalRules: [...COMMON_RULES, ...SCENARIO_RULES],
    tools: [wikipediaLookupTool],
    toolExamples: SCENARIO_EXAMPLES,
    toolCalls: true,
    bindings: false,
    inlineMode: false,
  }),
};
