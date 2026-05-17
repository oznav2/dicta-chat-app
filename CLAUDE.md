# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository

OpenUI is a pnpm monorepo (workspace globs: `packages/*`, `examples/**/*`, `docs/`). CI runs on Node 20 with pnpm 9.0.6 (`.github/workflows/build-js.yml`).

## Common commands

Run from the repo root:

```bash
pnpm install                       # bootstrap workspace
pnpm -r build                      # build every package (CI step 1)
pnpm -r run ci                     # lint:check + format:check across all packages (CI step 2)
pnpm --filter @openuidev/react-lang build        # build a single package
pnpm --filter @openuidev/react-lang test         # run vitest in a single package
pnpm --filter @openuidev/react-lang test -- <pattern>   # single test file/name
pnpm --filter @openuidev/react-ui storybook      # component dev environment (port 6006)
```

Per-package scripts that exist in most workspaces: `build`, `typecheck` (`tsc --noEmit`), `lint:check`/`lint:fix`, `format:check`/`format:fix`, `ci` (lint + format check). `lang-core`, `react-lang`, `react-headless` use Vitest. `react-ui` has no `test` script — verify changes via Storybook or an example app.

`react-ui` build is multi-step (`pnpm build` = `generate:css-utils` → SCSS compile → `tsc` → tsdown for CJS → copy CSS). Don't substitute `tsc` alone.

Publish pipelines (`prepublishOnly`) additionally run `publint` and `@arethetypeswrong/cli` — package.json `exports`, dual `.mjs`/`.cjs` entry points, and `.d.mts`/`.d.cts` must stay consistent if you touch exports.

## Architecture

The pipeline is the mental model — every package fills one slot:

```
Component Library  →  System Prompt  →  LLM  →  OpenUI Lang stream  →  Parser  →  Renderer  →  Live UI
```

OpenUI Lang is a compact line-oriented DSL the LLM emits instead of JSON. One statement per line (`identifier = Expression`), first statement must assign to `root`, positional arguments map to component props by Zod schema key order, forward references render as skeletons until defined.

### Package layout

- `packages/lang-core` — Framework-agnostic core. Parser (`src/parser/`: lexer, AST, streaming parser, prompt generator, merge, serialize), runtime (`src/runtime/`: evaluator, store, query manager, MCP tool provider, reactive bindings), validation utils. Zero React/Vue/Svelte dependencies. Optional peer dep on `@modelcontextprotocol/sdk`.
- `packages/react-lang` — React bindings on top of `lang-core`. Exposes `defineComponent`, `createLibrary`, `<Renderer />`, and the hooks component renderers consume (`useStateField`, `useFormValidation`, `useTriggerAction`, etc.). Re-exports the parser/prompt generator from `lang-core` for backend use.
- `packages/react-headless` — Chat state and streaming. `ChatProvider` (Zustand store), thread management, and stream adapters (`openai-completions`, `openai-responses`, `openai-readable-stream`, `langgraph`, `ag-ui`) plus message format converters. No UI.
- `packages/react-ui` — Prebuilt React components, two built-in libraries (`openuiLibrary`, `openuiChatLibrary` in `src/genui-lib/`), prebuilt chat shells (`CopilotShell`, `Shell`, `BottomTray`, `OpenUIChat`), Radix primitives, Recharts, markdown. Ships compiled SCSS.
- `packages/openui-cli` — `openui` binary. `create` scaffolds a Next.js app from `src/templates/openui-chat/` (excluded from workspace globs); `generate <library.ts>` builds a system prompt from a user's library file.
- `packages/svelte-lang`, `packages/vue-lang`, `packages/react-email`, `packages/browser-bundle` — Alternate framework bindings / distributions on top of `lang-core`.

`lang-core` is the root of the dependency graph; the framework bindings only depend on it (and their framework's peer deps). Workspace imports use `workspace:^` / `workspace:*` — keep that pattern.

### Cross-cutting conventions

- TypeScript is strict, including `noUncheckedIndexedAccess` and `noPropertyAccessFromIndexSignature` (`tsconfig.json`). Index access returns `T | undefined`; account for it rather than asserting.
- ESLint forbids `console.log` (allows `console.error/warn/info`) and unused imports. Storybook files, test files (`__tests__/`, `*.test.*`, `*.spec.*`), and `src/templates/**` are ignored or use a separate `tsconfig.test.json`.
- Prettier: 100-col width, double quotes, semicolons, trailing commas, 2-space indent. `prettier-plugin-organize-imports` rewrites import order on save/format.
- Renderer code paths must handle partial input (the parser is streaming) — don't assume nodes are fully populated before rendering.

## Examples and skill

`examples/` contains end-to-end framework integrations (Next.js, Vercel AI SDK, LangChain via `mastra-chat`, Supabase, Svelte, Vue, React Native, shadcn, dashboards, etc.) — useful references when wiring a new stream adapter or layout. The canonical scaffold is `examples/openui-chat`.

`skills/openui/SKILL.md` is the agent skill that ships with the repo for AI coding assistants. It documents OpenUI Lang syntax, the four-stage pipeline, and points at `https://www.openui.com/llms-full.txt` and per-topic docs. Consult it before changing anything user-facing about the Lang DSL — its description is the source of truth users see.
