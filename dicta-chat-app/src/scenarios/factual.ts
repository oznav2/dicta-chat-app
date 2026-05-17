// Factual / encyclopedic / explanatory Q&A — rendered as structured UI.
// Triggers on "who/what/when/where/why/how" framings in Hebrew + English.
// The prime goal of generative UI is interactive UI, not plain text — so
// this scenario always emits OpenUI Lang (Card outer + TextContent title +
// MarkDownRenderer body) instead of falling back to markdown. The body's
// rich formatting still happens — just nested inside a MarkDownRenderer
// component the Renderer parses and styles.
import type { PromptSpec } from "@openuidev/lang-core";
import { COMMON_PREAMBLE, COMMON_RULES } from "./_shared";
import type { Scenario } from "./types";

// `\b` is ASCII-only in JS regex, so Hebrew tokens need their own pattern.
const MATCH_EN =
  /\b(who|what|when|where|why|how|explain|describe|tell me about|history of|what is)\b/i;
const MATCH_HE =
  /(^|[\s.,!?:;'"()־׳״])(מי\s+(הוא|היה|הם)|מה\s+(זה|הוא)|מתי|איפה|למה|איך|הסבר|ספר\s+לי|מהי|מהו|תאר)(?=[\s.,!?:;'"()־׳״]|$)/;

const SCENARIO_RULES: string[] = [
  "Render the answer as a Card with a TextContent heading and a MarkDownRenderer body. NEVER answer in plain markdown prose only — the user-facing response is always structured UI.",
  "Structure (copy this shape, expanding as needed):\n```\nroot = Card([title, body])\ntitle = TextContent(\"<subject name>\", \"large-heavy\")\nbody = MarkDownRenderer(\"## Background\\n…\\n## Key events\\n…\\n## Legacy\\n…\")\n```",
  "Aim for a thorough, well-organized answer — at least 3 sections (`##` h2 headings) when the topic supports it. Each section should contain 2–4 sentences OR a focused bullet list. Sub-sections (`###`) are fine when a section naturally subdivides.",
  "Cover the topic comprehensively. Typical sections for a person: Background / Early life · Career / Major events · Notable achievements · Legacy / Influence. Adapt section names to the subject — a place, concept, or event has its own natural headings.",
  "Be detailed and concrete — include specific dates, places, names, works, and direct context. Avoid generic platitudes (\"a very important figure\") and prefer specific facts (\"crowned Emperor of the French on 2 December 1804 at Notre-Dame\"). Use bullet lists for enumerations (dates, achievements, list of works); use numbered lists when order matters.",
  "Typography: **bold** for the subject's name on first mention, *italics* for foreign-language terms or book titles, en-dash `–` for date ranges (e.g. *1769–1821*).",
  "Target length: roughly 250–500 words of body content for a substantive factual question. Do NOT artificially shorten to a few sentences — but also do not pad with filler. Stop when you've covered the topic well.",
  "Match the user's language. If the user asked in Hebrew, write the heading and the entire MarkDownRenderer content in Hebrew. Proper nouns stay in their conventional form (e.g. \"נפוליאון בונפרטה\").",
  'Escape any literal `"` inside the MarkDownRenderer string as `\\"`. Inside Hebrew abbreviations prefer the gershayim ״ over an ASCII `"`.',
];

const SCENARIO_EXAMPLES: string[] = [
  // English example — multi-section, ~280 words. Shows the depth and
  // structure the model should aim for: subject intro, several h2
  // sections each with concrete facts, ending with a Legacy section.
  'root = Card([title, body])\n' +
    'title = TextContent("Napoleon Bonaparte", "large-heavy")\n' +
    'body = MarkDownRenderer("**Napoleon Bonaparte** (*1769–1821*) was a French military and political leader who rose to prominence during the French Revolution and reshaped the political map of Europe in the early 19th century. Born in Ajaccio, Corsica, into a minor noble family, he was educated at French military schools and was a young artillery officer when the revolution erupted in 1789.\\n\\n## Rise to Power\\nNapoleon\'s early successes in the Italian and Egyptian campaigns earned him national fame. In November 1799 he seized power in the *coup of 18 Brumaire*, becoming First Consul. He crowned himself **Emperor of the French** on 2 December 1804 at Notre-Dame de Paris, inaugurating the First French Empire.\\n\\n## Reforms\\n- The *Code Napoléon* (1804) unified French civil law and became a model for legal systems across Europe and Latin America\\n- Established the Banque de France, reorganised education through the *lycée* system, and concluded the **Concordat of 1801** with the Catholic Church\\n- Centralised administration through prefects and modernised tax collection\\n\\n## Military Campaigns\\nBetween 1805 and 1812, French armies under Napoleon won decisive victories at *Austerlitz*, *Jena*, *Friedland*, and *Wagram*, redrawing borders from Spain to Poland. The disastrous **invasion of Russia in 1812** lost most of the *Grande Armée* and triggered his decline.\\n\\n## Fall and Exile\\nAfter the Battle of Leipzig (1813) and the Allied capture of Paris (1814), Napoleon abdicated and was exiled to **Elba**. He returned for the *Hundred Days* in 1815, was finally defeated at **Waterloo** by Wellington and Blücher, and lived out his last six years on **Saint Helena**, where he died on 5 May 1821.\\n\\n## Legacy\\nThe *Code Napoléon* still underpins civil law in much of Europe and Latin America; his administrative reforms shape French government to this day; and his military doctrines are studied in academies worldwide.")',
  // Hebrew example — same depth, fully localized.
  'root = Card([title, body])\n' +
    'title = TextContent("נפוליאון בונפרטה", "large-heavy")\n' +
    'body = MarkDownRenderer("**נפוליאון בונפרטה** (*1769–1821*) היה מצביא ומדינאי צרפתי שעלה לגדולה במהלך המהפכה הצרפתית ועיצב מחדש את המפה המדינית של אירופה בתחילת המאה ה-19. הוא נולד באייצ׳ו שבקורסיקה למשפחת אצולה זוטרה, התחנך בבתי-ספר צבאיים בצרפת, והיה קצין תותחנים צעיר כשפרצה המהפכה בשנת 1789.\\n\\n## עלייה לשלטון\\nהצלחותיו המוקדמות במסעות באיטליה ובמצרים הקנו לו תהילה. בנובמבר 1799 תפס את השלטון בהפיכת ה-*18 בברימר* והפך לקונסול הראשון. ב-2 בדצמבר 1804 הכתיר את עצמו ל**קיסר הצרפתים** בנוטרדאם שבפריז, ופתח את עידן האימפריה הצרפתית הראשונה.\\n\\n## רפורמות\\n- **קוד נפוליאון** (1804) איחד את המשפט האזרחי הצרפתי והפך לדגם משפטי ברחבי אירופה ואמריקה הלטינית\\n- הקים את **בנק צרפת**, ארגן מחדש את החינוך באמצעות מערכת ה-*ליצֵאוֹן*, וחתם על **קונקורדט 1801** עם הכנסייה הקתולית\\n- ריכז את המינהל באמצעות מושלי מחוז ומיסה מודרני\\n\\n## מסעות צבאיים\\nבין 1805 ל-1812 ניצח צבא צרפת בקרבות *אוסטרליץ*, *יֵנָה*, *פרידלנד* ו-*וַגרם*, ושירטט מחדש את גבולות אירופה מספרד עד פולין. **מסע הכיבוש הכושל ברוסיה ב-1812** מוטט את ה-*גראנד ארמה* והאיץ את נפילתו.\\n\\n## נפילה וגלות\\nלאחר קרב לייפציג (1813) וכיבוש פריז ב-1814, נפוליאון התפטר והוגלה ל**אֵלבָּה**. הוא שב לשלטון לתקופת *מאה הימים* ב-1815, הובס סופית ב**ווטרלו** בידי ולינגטון ובלוכר, וחי את שש שנותיו האחרונות ב**סנט הלנה**, שם מת ב-5 במאי 1821.\\n\\n## מורשת\\nקוד נפוליאון עדיין משמש כבסיס למשפט האזרחי ברחבי אירופה ואמריקה הלטינית; הרפורמות המינהליות שלו עיצבו את הממשל הצרפתי המודרני; ותורתו הצבאית נלמדת באקדמיות צבאיות ברחבי העולם.")',
];

export const factualScenario: Scenario = {
  name: "factual",
  description: "Encyclopedic / explanatory Q&A rendered as Card + MarkDownRenderer.",
  matches: ({ userMessage }) =>
    MATCH_EN.test(userMessage) || MATCH_HE.test(userMessage),
  build: (base): PromptSpec => ({
    ...base,
    preamble: COMMON_PREAMBLE,
    additionalRules: [...COMMON_RULES, ...SCENARIO_RULES],
    toolCalls: false,
    bindings: false,
    // No inlineMode — we require Lang so the Renderer always fires.
    inlineMode: false,
    examples: SCENARIO_EXAMPLES,
  }),
};
