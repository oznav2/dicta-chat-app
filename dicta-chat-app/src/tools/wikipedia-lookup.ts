// `wikipedia_lookup` — fetch a real Wikipedia article via the local
// /api/wikipedia proxy and return a consolidated payload for rendering.
// The server route composes intro + section summaries + see-also into a
// single markdown body, so the Renderer just hands `result.body` to
// MarkDownRenderer. Used by `wikipediaScenario`.
import type { Tool } from "./types";

const EMPTY_RESULT = {
  title: "",
  description: "",
  url: "",
  // Local logo — non-empty so `ImageBlock(wiki.thumbnail, …)` never
  // renders an `<img src="">` warning when the lookup fails or is
  // still in flight.
  thumbnail: "/wikipedia-logo.svg",
  body: "",
  lastModified: "",
};

export const wikipediaLookup: Tool = {
  spec: {
    name: "wikipedia_lookup",
    description:
      "Fetch a real Wikipedia article and return a consolidated payload for rendering. " +
      "Use this for any factual question about a person, place, event, work, organisation, or concept. " +
      "The server-side proxy handles the API calls and composes a single markdown body containing the intro, top-level sections, and a 'see also' list.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The topic / subject / question to look up. Natural language is fine.",
        },
        language: {
          type: "string",
          description:
            'ISO 639-1 Wikipedia edition code. Use "he" for Hebrew queries, "en" for English. Default "en".',
          enum: ["en", "he", "fr", "de", "es", "ar", "ru", "it"],
        },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Canonical Wikipedia article title." },
        description: { type: "string", description: "One-line description." },
        url: { type: "string", description: "Article URL." },
        thumbnail: {
          type: "string",
          description: "Hero image URL (empty string if the article has none).",
        },
        body: {
          type: "string",
          description:
            "Pre-composed markdown with intro + ## sections + ## ראה גם list. Pass directly to MarkDownRenderer.",
        },
        lastModified: { type: "string", description: "ISO date of last edit." },
      },
      required: ["title", "url", "body"],
    },
  },
  impl: async (args) => {
    const query = typeof args.query === "string" ? args.query : "";
    const language =
      typeof args.language === "string" && args.language.length === 2
        ? args.language
        : "en";
    if (!query) return { ...EMPTY_RESULT };
    try {
      const res = await fetch(
        `/api/wikipedia?query=${encodeURIComponent(query)}&language=${encodeURIComponent(
          language,
        )}`,
        { method: "GET", headers: { Accept: "application/json" } },
      );
      if (!res.ok) {
        return {
          ...EMPTY_RESULT,
          error: `Wikipedia fetch failed: HTTP ${res.status}`,
        };
      }
      return await res.json();
    } catch (err) {
      return {
        ...EMPTY_RESULT,
        error: err instanceof Error ? err.message : "Wikipedia fetch failed",
      };
    }
  },
};
