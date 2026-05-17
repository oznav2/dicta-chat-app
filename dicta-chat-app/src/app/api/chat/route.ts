import { NextRequest } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { buildSystemPrompt } from "@/lib/build-prompt";

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || "http://localhost:5002/v1",
  apiKey: process.env.OPENAI_API_KEY || "sk-no-key-required",
});

const MODEL = process.env.MODEL || "DictaLM-3.0-24B-Thinking.i1-Q4_K_M.gguf";

// ─── Reasoning-tag scrubbing (history hygiene) ────────────────────────────
// Thinking models condition on conversation history. If we echo back assistant
// messages that still contain a reasoning block, the model reads "I already
// reasoned for this turn" and skips emitting a new one. Strip every reasoning
// tag variant — and any half-open opener — before sending history upstream.
const REASONING_TAG_NAMES = [
  "think",
  "thinking",
  "reasoning",
  "thought",
  "thoughts",
  "analysis",
  "scratchpad",
  "internal",
  "plan",
  "reflection",
  "monologue",
];
const REASONING_NAMES_RE = REASONING_TAG_NAMES.join("|");
const REASONING_BLOCK = new RegExp(
  `<\\s*(?:${REASONING_NAMES_RE})\\b[^>]*>[\\s\\S]*?<\\s*/\\s*(?:${REASONING_NAMES_RE})\\s*>\\s*`,
  "gi",
);
const REASONING_HALF_OPEN = new RegExp(
  `<\\s*(?:${REASONING_NAMES_RE})\\b[^>]*>[\\s\\S]*$`,
  "i",
);
function stripThink(content: unknown): unknown {
  if (typeof content !== "string") return content;
  return content.replace(REASONING_BLOCK, "").replace(REASONING_HALF_OPEN, "").trimStart();
}

// ─── Lang detection + prose-to-Lang wrapping ──────────────────────────────
// The model often answers `factual` queries (and sometimes `math`) in plain
// prose despite the strict scenario rules. To uphold the prime goal —
// "responses are interactive UI, not text" — we buffer the body and, if no
// OpenUI Lang signature appears, wrap it as a Card+MarkDownRenderer pair so
// the Renderer always fires.
const HAS_LANG_RE = /(^|\n)\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*[A-Z]/;

function looksLikeLang(s: string): boolean {
  return HAS_LANG_RE.test(s.trim());
}

// Server-side fix-up for the recurring "model writes ${var} or {{var}} inside
// a Lang string" failure mode. The Lang parser doesn't interpolate either
// syntax, so those tokens would otherwise render literally in the Card.
// Rewrite them to proper `+` concatenation:
//
//   "Result: ${calc.result}"       →  "Result: " + calc.result + ""
//   "The time is {{now.now}} now"  →  "The time is " + now.now + " now"
//
// We only touch strings that appear inside Lang code (after `looksLikeLang`
// has already accepted the body). Trailing empty "" segments are harmless;
// the Lang parser collapses them.
function fixTemplateInterpolations(lang: string): string {
  // ${ident.field} or ${ident}
  let out = lang.replace(
    /"((?:[^"\\]|\\.)*?)"/g,
    (match, inner: string) => {
      let changed = false;
      const replaced = inner
        .replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (_m, expr) => {
          changed = true;
          return `" + ${expr} + "`;
        })
        .replace(/\{\{([A-Za-z_][A-Za-z0-9_.]*)\}\}/g, (_m, expr) => {
          changed = true;
          return `" + ${expr} + "`;
        });
      return changed ? `"${replaced}"` : match;
    },
  );
  return out;
}

// The model has seen Wikipedia logo URLs at training time and also in
// its own past assistant turns within a session. Even after we switch
// the worked example to a local path, it sometimes regresses to the
// upstream `upload.wikimedia.org` URL — which then 404s in the browser
// (Wikimedia rejects the request on User-Agent policy) and clutters
// the dev overlay with image-load failures. We host the logo ourselves
// at `/wikipedia-logo.svg` (see `public/wikipedia-logo.svg`), so any
// upstream Wikipedia-logo URL gets normalized to that local path
// before the Lang reaches the Renderer.
const WIKIPEDIA_LOGO_RE =
  /https?:\/\/upload\.wikimedia\.org\/[^"'\s)]*Wikipedia[_-]logo[^"'\s)]*/gi;
function normalizeWikipediaLogoUrls(lang: string): string {
  return lang.replace(WIKIPEDIA_LOGO_RE, "/wikipedia-logo.svg");
}

function escapeForLangString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n");
}

function wrapAsCardMarkdown(body: string, title?: string): string {
  const md = escapeForLangString(body.trim());
  if (title) {
    const t = escapeForLangString(title);
    return (
      `root = Card([t, b])\n` +
      `t = TextContent("${t}", "large-heavy")\n` +
      `b = MarkDownRenderer("${md}")`
    );
  }
  return `root = Card([b])\nb = MarkDownRenderer("${md}")`;
}

// Synthetic pre-think items the user sees IMMEDIATELY when they hit Send,
// before the model's first token arrives. Two complete <think>…</think>
// blocks — parseThinking on the client merges them with whatever the model's
// own reasoning_content adds. Localized by detecting Hebrew in the message.
function preThinkBlock(intent: string, isHebrew: boolean): string {
  const intentLabelEn: Record<string, string> = {
    math: "Math / tool",
    form: "Form / UI",
    factual: "Factual Q&A",
    conversation: "Conversational",
  };
  const intentLabelHe: Record<string, string> = {
    math: "חישוב / כלי",
    form: "טופס / ממשק",
    factual: "שאלה עובדתית",
    conversation: "שיחה",
  };
  if (isHebrew) {
    return (
      `<think>` +
      `תרחיש: ${intentLabelHe[intent] ?? intent}\n` +
      `מבקש מהמודל לחבר תשובה…` +
      `</think>\n`
    );
  }
  return (
    `<think>` +
    `Scenario: ${intentLabelEn[intent] ?? intent}\n` +
    `Asking the model for a structured answer…` +
    `</think>\n`
  );
}

function hasHebrew(s: string): boolean {
  return /\p{Script=Hebrew}/u.test(s);
}

// Pure-time queries are simple enough that we don't trust DictaLM to emit
// the canonical Lang reliably (we've seen the model fabricate dates, use
// `${now}` template syntax, and even render an empty year/month/day form).
// Detect them by keyword and short-circuit: emit the canonical Lang
// directly, skipping the model call. Renderer invokes the toolProvider
// client-side just like any other Query.
const TIME_QUERY_EN =
  /\b(what(?:'s| is)? the (?:current )?time|current time|what time is it|the time now)\b/i;
const TIME_QUERY_HE =
  /(^|[\s.,!?:;'"()־׳״])(מה השעה|כמה השעה|מהי השעה|השעה עכשיו)(?=[\s.,!?:;'"()־׳״]|$)/;

function isPureTimeQuery(message: string): boolean {
  return TIME_QUERY_EN.test(message) || TIME_QUERY_HE.test(message);
}

const CANONICAL_TIME_LANG =
  `now = Query("get_current_time", {}, { now: "" })\n` +
  `root = Card([t])\n` +
  `t = TextContent(now.now, "large-heavy")`;

// Local copy of OpenAI's streaming chunk shape — small enough that pulling
// in the full type for one cast isn't worth it.
type ChunkShape = {
  id?: string;
  object?: string;
  model?: string;
  created?: number;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
    };
    finish_reason?: string | null;
  }>;
};

export async function POST(req: NextRequest) {
  const { messages } = await req.json();

  const cleanedHistory: ChatCompletionMessageParam[] = Array.isArray(messages)
    ? messages.map((m: ChatCompletionMessageParam) =>
        m?.role === "assistant"
          ? ({ ...m, content: stripThink(m.content) } as ChatCompletionMessageParam)
          : m,
      )
    : [];

  const lastUserMessage = (() => {
    for (let i = cleanedHistory.length - 1; i >= 0; i--) {
      const m = cleanedHistory[i];
      if (m?.role === "user" && typeof m.content === "string") return m.content;
    }
    return "";
  })();
  // Scenario routing now considers the prior assistant turn so a terse
  // follow-up like "add Java" or "הוסף עמודת מדינה" sticks to the same
  // shape instead of falling through to conversation. The route exposes
  // every prior turn except the latest user message so pickScenario sees
  // both sides of the dialogue.
  const priorHistory: Array<{ role: string; content: string }> = [];
  for (const m of cleanedHistory) {
    if (typeof m?.content === "string" && typeof m.role === "string") {
      priorHistory.push({ role: m.role, content: m.content });
    }
  }
  // Drop the final user turn — that's `lastUserMessage`, already passed
  // separately. Everything before it is the conversation context.
  if (
    priorHistory.length > 0 &&
    priorHistory[priorHistory.length - 1]?.role === "user"
  ) {
    priorHistory.pop();
  }
  const { prompt: finalSystemPrompt, intent } = buildSystemPrompt(
    lastUserMessage,
    priorHistory,
  );
  const isHebrew = hasHebrew(lastUserMessage);

  const encoder = new TextEncoder();
  let closed = false;

  const readable = new ReadableStream({
    async start(controller) {
      const enqueueChunk = (chunk: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        } catch {
          // controller already closed
        }
      };
      const enqueueRaw = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          // controller already closed
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const emitContentDelta = (delta: string) => {
        enqueueChunk({
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
        });
      };

      try {
        // 0. Short-circuit for trivial structured queries. The time tool's
        //    canonical Lang is just 3 lines; the model can't be trusted to
        //    emit them correctly (we've seen invented dates, mustache
        //    templates, and empty-form hallucinations), so we synthesise
        //    the Lang server-side and skip the LLM entirely. Saves several
        //    seconds and guarantees correctness.
        if (isPureTimeQuery(lastUserMessage)) {
          emitContentDelta(preThinkBlock(intent, isHebrew));
          emitContentDelta(CANONICAL_TIME_LANG);
          enqueueRaw("data: [DONE]\n\n");
          close();
          return;
        }

        // 1. Pre-think: surface the scenario routing decision so the user
        //    sees something *immediately* while the model spins up.
        emitContentDelta(preThinkBlock(intent, isHebrew));

        // 2. Open the model stream. We forward `reasoning_content` chunks in
        //    real time so the thinking panel grows progressively, but we
        //    BUFFER `content` chunks. The post-stream wrapping step can only
        //    look at the complete body to decide Lang-vs-prose.
        const stream = await client.chat.completions.create({
          model: MODEL,
          messages: [
            { role: "system", content: finalSystemPrompt },
            ...cleanedHistory,
          ],
          // Generous budget for detailed factual answers, multi-field forms,
          // and long Card+MarkDownRenderer payloads. Math/time intents stay
          // short regardless (their scenario rules cap them to one
          // TextContent), so this only affects intents that need the room.
          max_tokens: 4096,
          frequency_penalty: 0.5,
          stream: true,
        });

        let bodyBuffer = "";

        for await (const raw of stream) {
          const chunk = raw as ChunkShape;
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          // Forward reasoning_content chunks straight through — they
          // animate the thinking panel without depending on full body.
          if (delta.reasoning_content) {
            enqueueChunk(chunk);
            continue;
          }

          if (typeof delta.content === "string" && delta.content.length > 0) {
            bodyBuffer += delta.content;
            // Don't forward — we'll emit either the raw body or a wrapped
            // version at the end.
            continue;
          }

          // Other deltas (role, finish_reason) get forwarded as-is so the
          // client sees TEXT_MESSAGE_START / END at the right moments.
          enqueueChunk(chunk);
        }

        // 3. Post-process the buffered body.
        const trimmed = bodyBuffer.trim();
        if (trimmed.length > 0) {
          if (looksLikeLang(trimmed)) {
            // Model gave us Lang — fix any leftover ${…}/{{…}} template
            // patterns inside Lang strings, then forward as a single
            // content delta so the client renders it.
            emitContentDelta(
              normalizeWikipediaLogoUrls(fixTemplateInterpolations(trimmed)),
            );
          } else {
            // Plain prose — wrap as Card+MarkDownRenderer so the Renderer
            // still fires. This upholds the "responses are UI, not text"
            // prime goal even when the model defaults to prose.
            emitContentDelta(wrapAsCardMarkdown(trimmed));
          }
        } else {
          // Empty body: the model ran out of tokens inside <think> or
          // otherwise produced no content. Emit a friendly Card so the
          // bubble isn't blank.
          const fallbackTitle = isHebrew
            ? "המודל לא הצליח להפיק תשובה"
            : "The model couldn't produce a response";
          const fallbackBody = isHebrew
            ? "נסה לנסח את השאלה מחדש או לפרק אותה לחלקים קטנים יותר. אם הבעיה חוזרת, נסה לרענן את הצ׳אט."
            : "Try rephrasing the question or breaking it into smaller parts. If it keeps happening, refresh the chat.";
          emitContentDelta(wrapAsCardMarkdown(fallbackBody, fallbackTitle));
        }

        enqueueRaw("data: [DONE]\n\n");
        close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error("Chat route error:", message);
        enqueueRaw(`data: ${JSON.stringify({ error: message })}\n\n`);
        close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
