// Server-side proxy to Wikipedia. The client toolProvider's
// `wikipedia_lookup` posts to this route; we fan out to the MediaWiki
// Action API + REST API, compose a single markdown body containing intro
// + section summaries + ראה גם, and return the consolidated payload.
//
// Server-side because (a) consolidating four API calls per request is
// cleaner than running them sequentially in the browser, (b) we control
// the User-Agent (Wikipedia requires a descriptive UA, browsers can't
// override theirs), and (c) future caching can land here without changing
// the client tool surface.
import { NextRequest, NextResponse } from "next/server";

const UA =
  "DictaChatApp/1.0 (https://github.com/ilan/dicta-chat-app; wiki-augmented factual scenario)";

const FETCH_TIMEOUT_MS = 10_000;

async function fetchJson<T = unknown>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ─── Wikitext → plain-text helpers ────────────────────────────────────────
// Mirrors the Python reference: strip templates, file links, references,
// formatting markers, collapse whitespace. Good enough for section preview
// snippets; not a full-featured wikitext renderer.

// File/image namespace prefixes per Wikipedia edition. The Hebrew one
// (`קובץ`) is critical — without it, `[[קובץ:foo.jpg|שמאל|ממוזער|250
// פיקסלים|caption]]` falls through to the regular-wikilink rule and
// leaks the alignment/thumb/size/caption pipe-string as plain text.
const FILE_NAMESPACE_RE =
  /^\s*(?:File|Image|Media|קובץ|תמונה|מדיה|Datei|Bild|Fichier|Image|Archivo|Imagen|Файл|Изображение|画像|Bestand)\s*:/i;

// File links commonly contain nested `[[…]]` inside their caption (for
// links to other articles), so a flat regex can't reliably match them.
// Walk the string with a depth counter; when we see `[[ns:…]]`, drop it
// whole — including the nested brackets.
function stripFileLinks(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "[" && text[i + 1] === "[") {
      const start = i;
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "[" && text[j + 1] === "[") {
          depth++;
          j += 2;
        } else if (text[j] === "]" && text[j + 1] === "]") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      const inner = text.slice(start + 2, j - 2);
      if (FILE_NAMESPACE_RE.test(inner)) {
        // Drop the entire file link, including any nested captions.
        i = j;
        continue;
      }
      // Regular wikilink — leave for the next pass to unwrap.
      out += text.slice(start, j);
      i = j;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

function stripWikitext(text: string): string {
  let out = text;
  // Templates {{…}} (handle nesting via repeated pass)
  let prev = "";
  while (prev !== out) {
    prev = out;
    out = out.replace(/\{\{[^{}]*\}\}/g, "");
  }
  out = stripFileLinks(out);
  out = out.replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, "$1");
  out = out.replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, "$1");
  out = out.replace(/\[https?:\/\/\S+\]/g, "");
  out = out.replace(/'{2,3}/g, "");
  out = out.replace(/={2,}[^=\n]+=*={2,}/g, "");
  out = out.replace(/<ref[^>]*\/?>(?:[\s\S]*?<\/ref>)?/gi, "");
  out = out.replace(/<[^>]+>/g, "");
  out = out.replace(/\n{3,}/g, "\n\n");
  out = out.replace(/[ \t]{2,}/g, " ");
  return out.trim();
}

function cleanText(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .replace(/\[\d+\]/g, "")
    .replace(/\[note \d+\]/g, "")
    .trim();
}

// ─── Wikipedia API helpers ────────────────────────────────────────────────

function apiUrl(lang: string, params: Record<string, string | number>): string {
  const query = new URLSearchParams({
    format: "json",
    utf8: "1",
    origin: "*",
    ...Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ),
  });
  return `https://${lang}.wikipedia.org/w/api.php?${query.toString()}`;
}

function restSummaryUrl(lang: string, title: string): string {
  return `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
    title.replace(/ /g, "_"),
  )}`;
}

function pageUrl(lang: string, title: string): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(
    title.replace(/ /g, "_"),
  )}`;
}

// ─── Section / boilerplate handling ───────────────────────────────────────
// Section titles to skip when composing the body — these are usually
// reference/admin sections we don't want bulking the markdown.
const BOILERPLATE_SECTIONS = new Set<string>([
  // English
  "see also",
  "references",
  "external links",
  "further reading",
  "notes",
  "bibliography",
  "citations",
  "footnotes",
  "sources",
  // Hebrew equivalents
  "ראה גם",
  "הערות שוליים",
  "הערות",
  "קישורים חיצוניים",
  "ביבליוגרפיה",
  "לקריאה נוספת",
  "מקורות",
]);

// ─── Composition ──────────────────────────────────────────────────────────

type WikipediaResult = {
  title: string;
  description: string;
  url: string;
  thumbnail: string;
  body: string;
  lastModified: string;
};

// Per-section content budget. Bumped from 800 → 1600 chars, and we now
// take the whole section (multiple paragraphs) rather than just the
// first one, so the rendered card has real article body and not a
// one-line teaser. Top-level sections we keep up to 10; level-2
// subsections are also emitted (as `###`) so the natural article
// outline shows through.
const SECTION_CHAR_CAP = 1600;
const MAX_BODY_SECTIONS = 10;
const MAX_SECTION_DEPTH = 2;

async function searchTopTitle(query: string, lang: string): Promise<string | null> {
  const data = await fetchJson<{ query?: { search?: Array<{ title: string }> } }>(
    apiUrl(lang, {
      action: "query",
      list: "search",
      srsearch: query,
      srlimit: 1,
      srprop: "snippet",
    }),
  );
  return data?.query?.search?.[0]?.title ?? null;
}

async function fetchIntro(title: string, lang: string): Promise<string> {
  const data = await fetchJson<{
    query?: { pages?: Record<string, { extract?: string }> };
  }>(
    apiUrl(lang, {
      action: "query",
      prop: "extracts",
      titles: title,
      explaintext: 1,
      exintro: 1,
      redirects: 1,
    }),
  );
  const pages = data?.query?.pages ?? {};
  const first = Object.values(pages)[0];
  return cleanText(first?.extract ?? "");
}

async function fetchSections(
  title: string,
  lang: string,
): Promise<Array<{ index: number; line: string; toclevel: number }>> {
  const data = await fetchJson<{
    parse?: { sections?: Array<{ index: string; line: string; toclevel: number }> };
  }>(
    apiUrl(lang, {
      action: "parse",
      page: title,
      prop: "sections",
      redirects: 1,
    }),
  );
  return (data?.parse?.sections ?? []).map((s) => ({
    index: Number(s.index) || 0,
    line: s.line,
    toclevel: s.toclevel,
  }));
}

async function fetchSectionPlaintext(
  title: string,
  lang: string,
  index: number,
): Promise<string> {
  const data = await fetchJson<{
    parse?: { wikitext?: { "*": string } };
  }>(
    apiUrl(lang, {
      action: "parse",
      page: title,
      prop: "wikitext",
      section: index,
      redirects: 1,
      disableeditsection: 1,
    }),
  );
  const wikitext = data?.parse?.wikitext?.["*"] ?? "";
  return cleanText(stripWikitext(wikitext));
}

function truncateNice(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastPara = cut.lastIndexOf("\n\n");
  const cut2 = lastPara > max * 0.6 ? cut.slice(0, lastPara) : cut;
  return cut2.trimEnd() + "…";
}

async function composeWikipediaResult(
  query: string,
  lang: string,
): Promise<WikipediaResult | null> {
  const top = await searchTopTitle(query, lang);
  if (!top) return null;

  // 1. REST summary — title, description, thumbnail, last-modified.
  const rest = await fetchJson<{
    title?: string;
    description?: string;
    extract?: string;
    timestamp?: string;
    thumbnail?: { source?: string };
    originalimage?: { source?: string };
    content_urls?: { desktop?: { page?: string } };
    type?: string;
  }>(restSummaryUrl(lang, top));

  if (rest?.type === "disambiguation") {
    // Not handled specially — treat as a regular result so the user at
    // least sees the disambiguation extract.
  }

  const title = rest?.title ?? top;
  const description = rest?.description ?? "";
  const url = rest?.content_urls?.desktop?.page ?? pageUrl(lang, title);
  // Fall back to the same local Wikipedia logo we use for the Card's
  // `logo` slot when the article has no hero image. This avoids the
  // browser warning ("An empty string was passed to the src attribute")
  // that `ImageBlock(wiki.thumbnail, …)` triggers when the model passes
  // through an empty string.
  const thumbnail =
    rest?.originalimage?.source ?? rest?.thumbnail?.source ?? "/wikipedia-logo.svg";
  const lastModified = rest?.timestamp ? rest.timestamp.slice(0, 10) : "";

  // 2. Intro paragraph(s).
  const intro = await fetchIntro(title, lang);

  // 3. Section bodies. We follow the article's natural outline up to
  //    depth 2: top-level sections render as `##`, level-2 subsections
  //    as `###`. Each section's full text is included (not just the
  //    first paragraph) and capped at SECTION_CHAR_CAP. Boilerplate
  //    sections (references, external links, etc.) are skipped — and
  //    when a top-level section is skipped, its subsections are too.
  const sections = await fetchSections(title, lang);
  const skipped = new Set<number>();
  const keySections: typeof sections = [];
  for (const s of sections) {
    if (s.toclevel > MAX_SECTION_DEPTH) continue;
    const titleLower = s.line.trim().toLowerCase();
    if (BOILERPLATE_SECTIONS.has(titleLower)) {
      if (s.toclevel === 1) skipped.add(s.index);
      continue;
    }
    // Drop subsections nested under a skipped top-level section.
    if (s.toclevel > 1 && skipped.size > 0) {
      const nearestParent = keySections.findLast((k) => k.toclevel < s.toclevel);
      if (!nearestParent) continue;
    }
    keySections.push(s);
    if (keySections.length >= MAX_BODY_SECTIONS) break;
  }

  const sectionBlocks: string[] = [];
  await Promise.all(
    keySections.map(async (s, i) => {
      if (!s.index) return;
      const text = await fetchSectionPlaintext(title, lang, s.index);
      const snippet = truncateNice(text.trim(), SECTION_CHAR_CAP);
      if (snippet.length === 0) return;
      const heading = "#".repeat(Math.min(s.toclevel + 1, 4));
      sectionBlocks[i] = `${heading} ${s.line}\n\n${snippet}`;
    }),
  );

  // 4. Compose final markdown body. Each piece is optional — if intro
  //    is missing we still emit sections, etc. No "See also" — the
  //    Wikipedia URL in the footer is the single canonical exit point.
  const bodyParts = [intro, ...sectionBlocks.filter(Boolean)]
    .filter((p) => p && p.trim().length > 0)
    .map((p) => p.trim());

  const body = bodyParts.join("\n\n");

  return { title, description, url, thumbnail, body, lastModified };
}

// ─── Route handler ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("query") ?? "").trim();
  const language = (searchParams.get("language") ?? "en").trim().toLowerCase();

  if (!query) {
    return NextResponse.json(
      { error: "Missing query parameter" },
      { status: 400 },
    );
  }

  try {
    const result = await composeWikipediaResult(query, language || "en");
    if (!result) {
      // Empty result — return shape with empty fields so the model's Lang
      // doesn't crash on missing keys. The scenario rules tell the model
      // to emit a "no article found" Card in this case.
      return NextResponse.json({
        title: "",
        description: "",
        url: "",
        thumbnail: "",
        body: "",
        lastModified: "",
      });
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Wikipedia fetch failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
