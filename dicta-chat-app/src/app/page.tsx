"use client";
import "@openuidev/react-ui/components.css";
import "@openuidev/react-ui/styles/index.css";

import {
  EventType,
  openAIMessageFormat,
  type AssistantMessage,
  type StreamProtocolAdapter,
  type UserMessage,
  useThread,
} from "@openuidev/react-headless";
import type { ActionEvent } from "@openuidev/lang-core";
import { Renderer } from "@openuidev/react-lang";
import { FullScreen, MarkDownRenderer } from "@openuidev/react-ui";
import { library } from "@/library";
import { toolProvider } from "@/tools";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Custom adapter for DictaLM via a local OpenAI-compatible server.
// Handles two reasoning-emission styles that llama.cpp/Ollama variants use:
//   1. `<think>...</think>` wrapped inline inside `delta.content`
//   2. `delta.reasoning_content` (or `delta.reasoning`) as a side channel
// In case (2), we synthesize `<think>...</think>` tokens so downstream
// splitting logic only has to handle one shape.
const dictaAdapter = (): StreamProtocolAdapter => ({
  async *parse(response: Response) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    const messageId = crypto.randomUUID();
    let messageStarted = false;
    let inReasoning = false;
    let buffer = "";

    const startMessage = function* () {
      if (messageStarted) return;
      messageStarted = true;
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant" as const,
      };
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;

        let json: any;
        try {
          json = JSON.parse(data);
        } catch (e) {
          console.error("dictaAdapter: JSON parse error", e, data);
          continue;
        }

        if (json.error) {
          yield {
            type: EventType.RUN_ERROR,
            message: typeof json.error === "string" ? json.error : JSON.stringify(json.error),
          } as any;
          continue;
        }

        const choice = json.choices?.[0];
        const delta = choice?.delta;
        if (!delta) continue;

        const reasoningDelta: string | undefined = delta.reasoning_content ?? delta.reasoning;
        const contentDelta: string | undefined = delta.content ?? undefined;

        if (reasoningDelta || contentDelta || delta.role) {
          yield* startMessage();
        }

        if (reasoningDelta) {
          if (!inReasoning) {
            yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "<think>" };
            inReasoning = true;
          }
          yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: reasoningDelta };
        }

        if (contentDelta) {
          if (inReasoning) {
            yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "</think>\n" };
            inReasoning = false;
          }
          yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: contentDelta };
        }

        if (choice.finish_reason && choice.finish_reason !== "null") {
          if (inReasoning) {
            yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "</think>\n" };
            inReasoning = false;
          }
          yield { type: EventType.TEXT_MESSAGE_END, messageId };
        }
      }
    }

    if (messageStarted) {
      if (inReasoning) {
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "</think>\n" };
      }
      yield { type: EventType.TEXT_MESSAGE_END, messageId };
    }
  },
});

// Shape mirrors the Thesys docs ThinkItem (title + content, plus an optional
// ephemeral flag we keep for parity even though we don't currently use it).
type ThinkItem = { title: string; content: string; ephemeral?: boolean };

// Whitelist of reasoning-tag families a thinking model is known to emit.
// Keep this list in sync with REASONING_TAG_NAMES in src/app/api/chat/route.ts.
// Matching is case-insensitive, tolerates whitespace and attributes inside
// the opener (e.g. `<think foo="bar">`), and treats any tag in the whitelist
// as a valid closer for any opener in the whitelist — so a model that emits
// `<think>...</thinking>` still gets stripped cleanly.
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
const REASONING_OPEN_RE = new RegExp(
  `<\\s*(?:${REASONING_NAMES_RE})\\b[^>]*>`,
  "i",
);
const REASONING_CLOSE_RE = new RegExp(
  `<\\s*/\\s*(?:${REASONING_NAMES_RE})\\s*>`,
  "i",
);

function findFromIdx(content: string, from: number, re: RegExp): { idx: number; len: number } | null {
  const slice = content.slice(from);
  const m = slice.match(re);
  if (!m || m.index == null) return null;
  return { idx: from + m.index, len: m[0].length };
}

function isHebrew(s: string): boolean {
  return /\p{Script=Hebrew}/u.test(s);
}

function titleFor(index: number, total: number, lang: "he" | "en"): string {
  if (total <= 1) return lang === "he" ? "חשיבה" : "Reasoning";
  return lang === "he" ? `שלב ${index + 1}` : `Step ${index + 1}`;
}

// Walk the message content, extracting every reasoning block into a ThinkItem
// array and returning the surrounding text as the final response. A still-open
// trailing reasoning block (streaming edge) is captured as the last ThinkItem
// with whatever has arrived so far, and the response is held back as null
// until the closing tag arrives. Open and close tag names need not match as
// long as both are in the whitelist — defensive against models that swap
// names mid-stream.
//
// Discards any prose that appeared BEFORE the first reasoning opener once at
// least one block is found. This mirrors the Dicta jinja chat template, which
// does `content.split("</think>")[0].split("<think>")[-1]` and silently drops
// any meta-narration the model emitted before opening the reasoning tag.
function parseThinking(content: string): {
  thinkItems: ThinkItem[];
  response: string | null;
} {
  if (!content) return { thinkItems: [], response: null };

  const lang: "he" | "en" = isHebrew(content) ? "he" : "en";
  const blocks: string[] = [];
  let preReasoning = "";
  let postReasoning = "";
  let sawAnyOpener = false;
  let i = 0;
  let stillOpen = false;

  while (i < content.length) {
    const open = findFromIdx(content, i, REASONING_OPEN_RE);
    if (!open) {
      // No more openers — text from here on is response (post-reasoning).
      if (sawAnyOpener) postReasoning += content.slice(i);
      else preReasoning += content.slice(i);
      break;
    }
    const gap = content.slice(i, open.idx);
    if (sawAnyOpener) postReasoning += gap;
    else preReasoning += gap;
    sawAnyOpener = true;
    const contentStart = open.idx + open.len;

    // Depth-count nested reasoning tags so a literal `<think>` mentioned
    // inside the body doesn't prematurely close the block. The model
    // sometimes paraphrases the rules and writes `<think>...</think>` as
    // text, which would otherwise short-circuit at the inner closer.
    let depth = 1;
    let scanIdx = contentStart;
    let outerCloseIdx = -1;
    let outerCloseEnd = -1;
    while (scanIdx < content.length) {
      const nextOpen = findFromIdx(content, scanIdx, REASONING_OPEN_RE);
      const nextClose = findFromIdx(content, scanIdx, REASONING_CLOSE_RE);
      if (!nextClose) break; // streaming edge — no close found yet
      if (nextOpen && nextOpen.idx < nextClose.idx) {
        depth++;
        scanIdx = nextOpen.idx + nextOpen.len;
        continue;
      }
      depth--;
      if (depth === 0) {
        outerCloseIdx = nextClose.idx;
        outerCloseEnd = nextClose.idx + nextClose.len;
        break;
      }
      scanIdx = nextClose.idx + nextClose.len;
    }

    if (outerCloseIdx === -1) {
      // Still inside an unfinished reasoning block.
      blocks.push(content.slice(contentStart));
      stillOpen = true;
      break;
    }
    blocks.push(content.slice(contentStart, outerCloseIdx));
    i = outerCloseEnd;
  }

  // Safety net: thinking models sometimes paraphrase the rule structure in
  // their native language (e.g., Hebrew "0-תגובה" as a pseudo section marker)
  // and never emit the literal `</think>` close tag, so the entire reply —
  // including the actual `root = …` Lang code — stays buried inside the open
  // think block and never reaches the Renderer. Other times they close the
  // block but emit nothing after, leaving `root = …` inside the reasoning.
  // Either way: if any think block contains a top-level `root = …` line and
  // there is no response yet, split: everything up to that line is reasoning,
  // everything from it onward is the response body.
  if (blocks.length > 0) {
    const lastIdx = blocks.length - 1;
    const last = blocks[lastIdx]!;
    const noResponseYet = postReasoning.trim().length === 0;
    if ((stillOpen || noResponseYet) && /(^|\n)\s*root\s*=/.test(last)) {
      const m = last.match(/(^|\n)\s*(root\s*=)/);
      if (m && m.index != null) {
        const splitAt = m.index + (m[1] ?? "").length;
        const reasoningPart = last.slice(0, splitAt);
        const responsePart = last.slice(splitAt);
        blocks[lastIdx] = reasoningPart;
        postReasoning += responsePart;
        stillOpen = false;
      }
    }
  }

  // DictaLM occasionally falls into a "step 1 → step 2 → step 3…" loop where
  // each new <think> block restates the previous one (sometimes with extra
  // tail content, so an exact-match dedupe misses). Strategy: merge every
  // block into one combined string, run a GLOBAL paragraph dedupe (first
  // occurrence wins), and surface it as a single ThinkItem. The user gets a
  // single clean reasoning panel regardless of how many times the model
  // looped.
  const merged = blocks.map((b) => b.trim()).filter(Boolean).join("\n\n");
  const collapsed = dedupeConsecutiveParagraphs(
    collapseRepeatedParagraphs(merged),
  ).trim();

  const thinkItems: ThinkItem[] = collapsed
    ? [{ title: titleFor(0, 1, lang), content: collapsed }]
    : [];

  // When we found reasoning blocks, `preReasoning` is leaked meta-narration —
  // drop it. When we found none, treat the whole content as the response.
  const rawResponse = sawAnyOpener ? postReasoning : preReasoning;
  const trimmedResponse = rawResponse.replace(/^\s+|\s+$/g, "");
  return {
    thinkItems,
    response: stillOpen ? null : trimmedResponse.length > 0 ? trimmedResponse : null,
  };
}

// React error boundary around <Renderer />. The model occasionally emits
// OpenUI Lang where component args are in the wrong shape (e.g., passing a
// `{required: true}` rules object into a slot that expects a React child),
// which surfaces as "Objects are not valid as a React child" and would
// otherwise crash the entire chat surface. We catch the error and show the
// raw Lang as a code block so the user still has something readable. New
// content (next message) resets the boundary via the `resetKey` prop.
class RendererErrorBoundary extends React.Component<
  { resetKey: string; fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: {
    resetKey: string;
    fallback: React.ReactNode;
    children: React.ReactNode;
  }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.warn("OpenUI Renderer threw — falling back to markdown.", error);
  }
  override componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }
  override render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

// Some models defensively wrap their OpenUI Lang in <root>…</root> markers
// (mimicking the <tool_call> XML convention). The Renderer expects raw Lang
// starting with `root = …`, so we strip the wrapper if present.
function unwrapRootTags(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^<\s*root\s*>([\s\S]*?)<\s*\/\s*root\s*>\s*$/i);
  return m ? m[1]!.trim() : trimmed;
}

// Replace ASCII double-quote sandwiched between Hebrew letters with the Hebrew
// gershayim character ״ (U+05F4). In Hebrew typography this is the correct
// glyph for abbreviation marks inside words like דוא"ל → דוא״ל; using the
// ASCII " breaks the OpenUI Lang string parser since it looks like a closing
// string boundary. Safe transform: the substitution only fires when there are
// Hebrew code points on BOTH sides, so legitimate Lang string boundaries
// (which sit next to commas/parentheses/etc.) are never touched.
function sanitizeHebrewQuotes(s: string): string {
  return s.replace(/(\p{Script=Hebrew})"(?=\p{Script=Hebrew})/gu, "$1״");
}

// The model sometimes emits a literal empty string as the `src` argument
// of `Image(alt, src?)` or `ImageBlock(src, alt?)` — either because it
// truncated a URL mid-token or because it copied a placeholder default.
// Once that Lang reaches the Renderer, the underlying `<img src="">`
// triggers a browser warning ("An empty string was passed to the src
// attribute") and re-downloads the page. Rewrite both shapes to the
// same local `/wikipedia-logo.svg` placeholder we ship in `public/`.
// Conservative: only matches a literal `""`, never an identifier, so
// `ImageBlock(wiki.thumbnail, …)` with a real value flows through.
function normalizeEmptyImageSrc(s: string): string {
  // Pattern `"\/?"` matches both `""` (empty) and `"/"` (lone slash,
  // which happens mid-stream when the Lang parser snapshots `src="/"`
  // before the rest of `/wikipedia-logo.svg` arrives).
  return s
    .replace(
      /(Image\s*\(\s*"(?:[^"\\]|\\.)*"\s*,\s*)"\/?"/g,
      '$1"/wikipedia-logo.svg"',
    )
    .replace(/(ImageBlock\s*\(\s*)"\/?"/g, '$1"/wikipedia-logo.svg"');
}

// Collapse runs of identical consecutive paragraphs. When the model loops
// mid-stream it tends to re-emit the same paragraph verbatim several times
// (e.g., five copies of "כך: root = Card([title]) …"). The dedupe is
// case-insensitive and whitespace-normalised so near-identical repeats also
// fold together. Paragraphs are split on blank-line boundaries.
function dedupeConsecutiveParagraphs(s: string): string {
  if (!s) return s;
  const paragraphs = s.split(/\n{2,}/);
  const out: string[] = [];
  let prevNorm: string | null = null;
  for (const p of paragraphs) {
    const norm = p.trim().replace(/\s+/g, " ").toLowerCase();
    if (norm.length === 0) continue;
    if (norm === prevNorm) continue;
    out.push(p.trim());
    prevNorm = norm;
  }
  return out.join("\n\n");
}

// Stricter: keep only the FIRST occurrence of each distinct paragraph (across
// the entire string, not just consecutive). Use this to break "step 2/3/4"
// loops where each new step block is a superset of the previous one — the
// shared prefix paragraphs collapse to a single occurrence.
function collapseRepeatedParagraphs(s: string): string {
  if (!s) return s;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of s.split(/\n{2,}/)) {
    const norm = p.trim().replace(/\s+/g, " ").toLowerCase();
    if (!norm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(p.trim());
  }
  return out.join("\n\n");
}

// OpenUI Lang requires the first statement to be `identifier = ...`. If the
// model emits prose/markdown instead (common for thinking models on creative
// prompts like "write a song"), render it as markdown so the user sees
// something useful instead of a blank message.
function looksLikeOpenUILang(s: string): boolean {
  const firstLine = unwrapRootTags(s).split("\n", 1)[0] ?? "";
  return /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(firstLine.trimStart());
}

// Chevron icon mirroring lucide's ChevronDown so we don't pull a transitive dep.
const ChevronDown = ({ open }: { open: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{
      transition: "transform 180ms ease",
      transform: open ? "rotate(180deg)" : "rotate(0deg)",
    }}
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

// Type matches the Thesys docs `ThinkComponent` signature so the shape is
// portable: a custom thinking-state UI receives a progressive list of items
// (each with title + markdown content) plus a boolean indicating whether the
// model is still mid-think. We adapt the pattern to our @openuidev/react-ui
// stack since @thesysai/genui-sdk's C1Chat / customizeC1 is not in play here.
type ThinkComponent = (props: {
  thinkItems: ThinkItem[];
  thinkingInProgress: boolean;
}) => React.ReactElement | null;

const DictaThinkComponent: ThinkComponent = ({ thinkItems, thinkingInProgress }) => {
  const [override, setOverride] = useState<boolean | null>(null);
  const wasThinking = useRef(thinkingInProgress);

  // Reset the user override when a fresh thinking pass starts on this slot.
  useEffect(() => {
    if (thinkingInProgress && !wasThinking.current) setOverride(null);
    wasThinking.current = thinkingInProgress;
  }, [thinkingInProgress]);

  if (thinkItems.length === 0) return null;

  const isHe = isHebrew(thinkItems[0]?.content ?? "");
  const open = override !== null ? override : thinkingInProgress;
  const label = thinkingInProgress
    ? isHe
      ? "חושב…"
      : "Thinking…"
    : isHe
      ? "חשיבה"
      : "Reasoning";

  return (
    <div className="openui-behind-the-scenes dicta-thinking">
      <button
        type="button"
        className="openui-behind-the-scenes__toggle"
        aria-expanded={open}
        onClick={() => setOverride((prev) => (prev !== null ? !prev : !open))}
      >
        <ChevronDown open={open} />
        <span className={thinkingInProgress ? "dicta-thinking__label--pulse" : undefined}>
          {label}
        </span>
      </button>
      {open && (
        <div className="openui-behind-the-scenes__items dicta-thinking__content" dir="auto">
          {thinkItems.map((item, idx) => (
            <div key={idx} className="dicta-think-item">
              <div className="dicta-think-item__title">{item.title}</div>
              <div className="dicta-think-item__content" dir="auto">
                <MarkDownRenderer textMarkdown={item.content} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Per-message footer with quick actions (copy / regenerate / feedback).
// Rendered at the bottom of a completed assistant bubble, mirroring the
// Thesys response-footer pattern. The footer only appears after streaming
// finishes — keeping it hidden mid-stream avoids accidental clicks and
// keeps the layout calm while the body is still landing.
const ResponseFooter = ({
  message,
  copyText,
}: {
  message: AssistantMessage;
  copyText: string;
}) => {
  const processMessage = useThread((s) => s.processMessage);
  const messages = useThread((s) => s.messages);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const [copied, setCopied] = useState(false);
  const isHe = isHebrew(copyText);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // permissions denied — no-op, user can still select text manually
    }
  };

  const onRegenerate = () => {
    // Find the user message that produced this assistant turn and resubmit
    // it. We don't delete the current bubble — the new response is appended.
    const idx = messages.findIndex((m) => m.id === message.id);
    if (idx <= 0) return;
    for (let i = idx - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "user" && typeof m.content === "string") {
        processMessage({ role: "user", content: m.content });
        return;
      }
    }
  };

  const label = (en: string, he: string) => (isHe ? he : en);

  return (
    <div className="dicta-response-footer" dir={isHe ? "rtl" : "ltr"}>
      <button
        type="button"
        className="dicta-response-footer__btn"
        onClick={onCopy}
        title={label("Copy response", "העתק תשובה")}
        aria-label={label("Copy response", "העתק תשובה")}
      >
        <CopyIcon />
        <span>{copied ? label("Copied", "הועתק") : label("Copy", "העתק")}</span>
      </button>
      <button
        type="button"
        className="dicta-response-footer__btn"
        onClick={onRegenerate}
        title={label("Regenerate", "צור שוב")}
        aria-label={label("Regenerate", "צור שוב")}
      >
        <RegenerateIcon />
        <span>{label("Regenerate", "צור שוב")}</span>
      </button>
      <span className="dicta-response-footer__spacer" />
      <button
        type="button"
        className={
          "dicta-response-footer__btn" +
          (feedback === "up" ? " dicta-response-footer__btn--active" : "")
        }
        onClick={() => setFeedback((f) => (f === "up" ? null : "up"))}
        title={label("Helpful", "מועיל")}
        aria-label={label("Mark helpful", "סמן כמועיל")}
        aria-pressed={feedback === "up"}
      >
        <ThumbsUpIcon />
      </button>
      <button
        type="button"
        className={
          "dicta-response-footer__btn" +
          (feedback === "down" ? " dicta-response-footer__btn--active" : "")
        }
        onClick={() => setFeedback((f) => (f === "down" ? null : "down"))}
        title={label("Not helpful", "לא מועיל")}
        aria-label={label("Mark not helpful", "סמן כלא מועיל")}
        aria-pressed={feedback === "down"}
      >
        <ThumbsDownIcon />
      </button>
    </div>
  );
};

const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const RegenerateIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
);

const ThumbsUpIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 10v12" />
    <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7V10l4.34-9.66a1.93 1.93 0 0 1 3.66 1.54Z" />
  </svg>
);

const ThumbsDownIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17 14V2" />
    <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H17v12l-4.34 9.66a1.93 1.93 0 0 1-3.66-1.54Z" />
  </svg>
);

const ReasoningAssistantMessage = ({
  message,
  isStreaming,
}: {
  message: AssistantMessage;
  isStreaming: boolean;
}) => {
  const messages = useThread((s) => s.messages);
  const processMessage = useThread((s) => s.processMessage);
  const { thinkItems, response } = useMemo(
    () => parseThinking(message.content ?? ""),
    [message.content],
  );

  // TS port of the Python `render_openui` reference's `handleAction`.
  // Interactive components emit `ActionEvent`s via @ToAssistant / @OpenUrl
  // (or `Button` without an explicit Action, which auto-sends its label).
  // Map each event back into a chat round so clicks/submits/follow-ups
  // round-trip into `/api/chat` — the prime goal "responses are UI, not
  // text" only works if the UI can talk back.
  const handleAction = useCallback(
    (event: ActionEvent) => {
      if (event?.type === "open_url") {
        const url = event.params?.url;
        if (typeof url === "string" && url.length > 0) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
        return;
      }
      let prompt =
        event?.humanFriendlyMessage ||
        (typeof event?.params?.message === "string" ? event.params.message : "");
      const formState = event?.formState;
      if (formState && Object.keys(formState).length > 0) {
        const formDataStr = Object.entries(formState)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join("\n");
        prompt = prompt
          ? `${prompt}\n\nForm data:\n${formDataStr}`
          : `Form submission${
              event.formName ? ` (${event.formName})` : ""
            }:\n${formDataStr}`;
      }
      if (!prompt && event?.type) {
        const paramsStr = event.params
          ? `\n${JSON.stringify(event.params)}`
          : "";
        prompt = `User action: ${event.type}${paramsStr}`;
      }
      if (prompt) {
        processMessage({ role: "user", content: prompt });
      }
    },
    [processMessage],
  );

  const stillStreamingThis = useMemo(() => {
    if (!isStreaming) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") return messages[i]?.id === message.id;
    }
    return false;
  }, [isStreaming, messages, message.id]);

  const useLang = response ? looksLikeOpenUILang(response) : false;
  // Order matters: unwrap <root>…</root> first, dedupe repeated `root = …`
  // paragraphs the model emitted in a loop, then sanitize Hebrew quote chars
  // that would otherwise break the Lang string parser.
  const langSource =
    response && useLang
      ? normalizeEmptyImageSrc(
          sanitizeHebrewQuotes(
            dedupeConsecutiveParagraphs(unwrapRootTags(response)),
          ),
        )
      : response;

  return (
    <div className="openui-shell-thread-message-assistant">
      <div className="openui-shell-thread-message-assistant__content" dir="auto">
        {thinkItems.length > 0 && (
          <DictaThinkComponent
            thinkItems={thinkItems}
            thinkingInProgress={stillStreamingThis && !response}
          />
        )}
        {response && useLang && langSource && (
          <RendererErrorBoundary
            resetKey={message.id}
            fallback={
              <MarkDownRenderer
                textMarkdown={"```openui-lang\n" + langSource + "\n```"}
              />
            }
          >
            <Renderer
              response={langSource}
              library={library}
              toolProvider={toolProvider}
              isStreaming={stillStreamingThis}
              onAction={handleAction}
            />
          </RendererErrorBoundary>
        )}
        {response && !useLang && <MarkDownRenderer textMarkdown={response} />}
        {!stillStreamingThis && response && (
          <ResponseFooter message={message} copyText={response} />
        )}
      </div>
    </div>
  );
};

// Per-message direction-aware user bubble. `dir="auto"` lets the browser pick
// LTR or RTL based on the first strong directional character — Hebrew/Arabic
// input flows right-to-left, English stays left-to-right, no manual toggle.
const RtlAwareUserMessage = ({ message }: { message: UserMessage }) => {
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part): part is { type: "text"; text: string } => part?.type === "text")
            .map((part) => part.text)
            .join("")
        : "";

  return (
    <div className="openui-shell-thread-message-user">
      <div className="openui-shell-thread-message-user__content" dir="auto">
        {text}
      </div>
    </div>
  );
};

export default function Home() {
  return (
    <div className="h-screen w-screen overflow-hidden">
      <FullScreen
        processMessage={async ({ messages, abortController }) => {
          // The route builds the system prompt per-request from the
          // pre-generated component spec + intent detection. Client just
          // forwards messages.
          return fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: openAIMessageFormat.toApi(messages),
            }),
            signal: abortController.signal,
          });
        }}
        streamProtocol={dictaAdapter()}
        componentLibrary={library}
        assistantMessage={ReasoningAssistantMessage}
        userMessage={RtlAwareUserMessage}
        agentName="DictaLM Chat"
      />
    </div>
  );
}
