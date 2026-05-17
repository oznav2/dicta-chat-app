// Form / dashboard / wizard / multi-panel UI generation. Chart and table
// requests now have their own scenarios — this one focuses on interactive
// data-capture and navigation surfaces (Form, Tabs, Accordion, Steps,
// SectionBlock, Carousel). The prime goal demands the answer be rendered
// UI, so this scenario insists on Lang output. We keep `toolCalls: true`
// so the model can fetch data with `Query(...)` when needed, but DROP
// `bindings: true` — a contact form doesn't need reactive $variables, and
// disabling bindings strips the (large) reactive-state + built-in-
// functions sections from the generated prompt. Saves ~1500 tokens, which
// is the difference between DictaLM emitting Lang vs. looping in <think>.
import type { PromptSpec } from "@openuidev/lang-core";
import { COMMON_PREAMBLE, COMMON_RULES } from "./_shared";
import type { Scenario } from "./types";

// `\b` is ASCII-only in JS regex, so Hebrew tokens need their own pattern.
// `chart` and `table` are intentionally NOT in this regex — the chart /
// table scenarios handle those triggers and register first in the router.
const MATCH_EN =
  /\b(form|dashboard|panel|wizard|stepper|gallery|tabs|accordion|sections?|steps|carousel|card with|sign\s*up|sign\s*in|login|register|contact form)\b/i;
const MATCH_HE =
  /(^|[\s.,!?:;'"()־׳״])(טופס|דשבורד|לוח|מסך|כרטיסיות|אשף|מקטעים|שלבים|קרוסלה|הרשמה|התחברות|הזדהות)(?=[\s.,!?:;'"()־׳״]|$)/;

const SCENARIO_RULES: string[] = [
  "Emit OpenUI Lang only. Pick the shape that fits the request: `Form` for data capture, `Tabs` / `Accordion` / `SectionBlock` for grouped content, `Steps` for sequential guidance, `Carousel` for slideshow-like content. Wrap everything in a single `root = Card([…])`.",
  "For Form fields, wire each input through a `FormControl(label, Input/TextArea/Select, hint?)`. Use the right input `type` (`\"email\"`, `\"password\"`, `\"number\"`, `\"text\"`) and the right `rules` object (`{ required: true, email: true, min: 0, … }`) to get client-side validation.",
  'Submit buttons dispatch back to the assistant via `Action([@ToAssistant("…")])` wrapped in `Buttons([Button("…", Action([@ToAssistant("…")]), "primary")])`. The form\'s field values flow with the action automatically — the assistant turn will receive both `humanFriendlyMessage` and `formState`.',
  "For Tabs / Accordion / SectionBlock / Steps, each item's `content` is an array of child component references — assign each child a top-level identifier and pass `[id]` (not the expression inline).",
  "Match the user's language for every label, placeholder, button caption, tab trigger, and section heading. Tag names and Lang keywords stay in English.",
  "One Card per response. Inside that Card you can mix a Form, a Tabs, an Accordion — but never nest a Card inside another Card.",
];

const SCENARIO_EXAMPLES: string[] = [
  // English contact form + FollowUpBlock at the end.
  'root = Card([title, form, fu])\n' +
    'title = TextContent("Contact Us", "large-heavy")\n' +
    'form = Form("contact", btns, [name, email, msg])\n' +
    'name = FormControl("Name", Input("name", "Your name", "text", { required: true }))\n' +
    'email = FormControl("Email", Input("email", "you@example.com", "email", { required: true, email: true }))\n' +
    'msg = FormControl("Message", TextArea("message", "Tell us more…", 4, { required: true }))\n' +
    'btns = Buttons([Button("Send", Action([@ToAssistant("Submit contact form")]), "primary")])\n' +
    'fu = FollowUpBlock([FollowUpItem("Add a phone field"), FollowUpItem("Make the message optional"), FollowUpItem("Add a department dropdown")])',
  // Hebrew contact form — same shape, localized strings.
  'root = Card([title, form, fu])\n' +
    'title = TextContent("צור קשר", "large-heavy")\n' +
    'form = Form("contact", btns, [name, email, msg])\n' +
    'name = FormControl("שם משתמש", Input("name", "הזן את שמך", "text", { required: true }))\n' +
    'email = FormControl("אימייל", Input("email", "you@example.com", "email", { required: true, email: true }))\n' +
    'msg = FormControl("הודעה", TextArea("message", "כתוב הודעתך…", 4, { required: true }))\n' +
    'btns = Buttons([Button("שלח", Action([@ToAssistant("שליחת טופס יצירת קשר")]), "primary")])\n' +
    'fu = FollowUpBlock([FollowUpItem("הוסף שדה טלפון"), FollowUpItem("הפוך את ההודעה לאופציונלית"), FollowUpItem("הוסף תפריט נושאים")])',
  // English Tabs with content blocks per tab — shows how to wire grouped
  // content. Each tab item's `content` array references top-level ids;
  // never inline a component expression inside the array literal.
  'root = Card([title, tabs, fu])\n' +
    'title = TextContent("Product Documentation", "large-heavy")\n' +
    'tabs = Tabs([overviewTab, installTab, apiTab])\n' +
    'overviewTab = TabItem("overview", "Overview", [overviewBody])\n' +
    'installTab = TabItem("install", "Install", [installBody])\n' +
    'apiTab = TabItem("api", "API", [apiBody])\n' +
    'overviewBody = MarkDownRenderer("**Acme SDK** is a lightweight client library for the Acme platform. Single dependency, works in Node 18+ and modern browsers, MIT licensed.")\n' +
    'installBody = CodeBlock("bash", "npm install @acme/sdk")\n' +
    'apiBody = MarkDownRenderer("### `acme.fetch(path)`\\nReturns a Promise<Response>. Auth is auto-injected from `ACME_API_KEY`.\\n\\n### `acme.stream(path)`\\nReturns a ReadableStream for streaming endpoints.")\n' +
    'fu = FollowUpBlock([FollowUpItem("Show an end-to-end usage example"), FollowUpItem("List the available endpoints"), FollowUpItem("How do I configure ACME_API_KEY?")])',
  // English Accordion — FAQ-style grouped Q&A. Same `content`-as-ids
  // pattern as Tabs.
  'root = Card([title, faq, fu])\n' +
    'title = TextContent("Frequently Asked Questions", "large-heavy")\n' +
    'faq = Accordion([q1, q2, q3])\n' +
    'q1 = AccordionItem("pricing", "How much does it cost?", [a1])\n' +
    'q2 = AccordionItem("trial", "Is there a free trial?", [a2])\n' +
    'q3 = AccordionItem("support", "What support is included?", [a3])\n' +
    'a1 = MarkDownRenderer("**$29 / month** for the standard plan, **$99 / month** for the team plan. Annual billing saves 20%.")\n' +
    'a2 = MarkDownRenderer("Yes — **14 days, no credit card required**. You\'ll get full access to all features during the trial.")\n' +
    'a3 = MarkDownRenderer("Email support is included on all plans. Team plan gets priority response under 4 hours. Enterprise plans add a dedicated Slack channel.")\n' +
    'fu = FollowUpBlock([FollowUpItem("Compare the plans side by side"), FollowUpItem("Start the free trial"), FollowUpItem("Tell me about the enterprise plan")])',
];

export const formScenario: Scenario = {
  name: "form",
  description: "Forms, dashboards, wizards, Tabs / Accordion / Steps. Lang only — bindings disabled to keep the prompt small.",
  matches: ({ userMessage }) =>
    MATCH_EN.test(userMessage) || MATCH_HE.test(userMessage),
  build: (base): PromptSpec => ({
    ...base,
    preamble: COMMON_PREAMBLE,
    additionalRules: [...COMMON_RULES, ...SCENARIO_RULES],
    toolCalls: true,
    // `bindings: false` — drop $variable / @Set / @Reset / built-in
    // function rules from the prompt. The model still has access to the
    // Form/Action/@ToAssistant primitives via the component spec.
    bindings: false,
    inlineMode: false,
    examples: SCENARIO_EXAMPLES,
  }),
};
