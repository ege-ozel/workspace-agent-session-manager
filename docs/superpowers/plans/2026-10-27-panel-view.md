# Panel View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Panel" view per session: an editor-area webview that renders the session's transcript as a conversation (real tables with Copy / ⤢, visible and enlargeable images) with a message box that types into the session's terminal.

**Architecture:** Providers gain an optional `readTranscript(file, from)` that turns their JSONL transcript into agent-neutral `ChatItem`s, read incrementally by byte offset. The extension host renders Markdown to sanitized HTML (`src/panel/markdown.ts`, testable in node) and posts items to a webview (`src/panel/panel.ts` + plain `media/panel.js` / `media/panel.css`); images travel lazily, on request. The agent keeps running in its terminal; the message box uses `Terminal.sendText`, held back while Claude reports a question on screen (`status: "waiting"`).

**Tech Stack:** TypeScript (VS Code API 1.93), Node built-ins only, `node:test` for unit tests against `out/`.

**Spec:** `docs/superpowers/specs/2026-10-27-panel-view-design.md` (read it first; this plan argues from it).

## Global Constraints

- No new runtime dependencies, no network. No devDependencies for tests either: use `node:test` + `node:assert`.
- `@types/vscode` stays `~1.93.0`; no API newer than 1.93.
- Webview CSP: `default-src 'none'; img-src data: ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-<n>'`. Images only as `data:` URIs.
- All transcript text is untrusted: escape before any HTML is built. Links open only on click, through the host (`vscode.env.openExternal`), only `http:` / `https:`.
- Typing only into terminals in `launched` (extension.ts), and only when that terminal is still on the panel's session.
- Never touch the real `~/.claude` / `~/.codex` in tests: fixtures are synthetic files under `test/fixtures/`.
- Style: terse, small functions, comments only for non-obvious why (AGENTS.md). `extension.ts` gets only wiring.
- `npx tsc -p .` clean after every task; `npm test` green after every task.

## Review Focus

1. **Half-written last line** (agent mid-write when the watcher fires) → nothing lost or duplicated; the partial line is read on the next pass. Test: Task 2 `partial last line`.
2. **Script / HTML inside transcript text** (`<img onerror>`, `<script>`, `javascript:` links) → shown as text, never executed. Test: Task 1 `escapes html`, `drops javascript links`.
3. **`/clear` moves our terminal to another session while its panel is open** → the old panel must stop sending into that terminal (would type into the wrong session). Test: Task 5 `canSend false after the terminal moved`.
4. **Ragged / odd Markdown tables** (missing cells, `\|` escapes, pipes in inline code, alignment row) → still a table, Copy gives one TSV row per table row. Test: Task 1 `ragged table`, `escaped pipe`.
5. **Large image-heavy transcript** (tens of MB) → panel opens with only the last 200 items and no image data in the first message. Test: Task 4 `initial batch is capped and image data is not inlined`.

---

### Task 1: Chat item types, Markdown renderer, test harness

**Files:**
- Modify: `src/api.ts` (add types after `SessionEntry`; add `waitingFor` to `SessionEntry`; add `readTranscript` to `Provider`)
- Create: `src/panel/markdown.ts`
- Create: `test/markdown.test.js`
- Modify: `package.json` (`scripts.test`), `.vscodeignore` (add `docs/**`)

**Interfaces:**
- Produces (api.ts, exact):
  ```ts
  export type ChatItem =
    | { kind: 'user'; text: string }
    | { kind: 'assistant'; text: string }            // Markdown
    | { kind: 'tool'; name: string; summary: string }
    | { kind: 'toolResult'; text: string; error?: boolean }
    | { kind: 'image'; mime: string; data: string };  // base64, no "data:" prefix
  export interface TranscriptChunk { items: ChatItem[]; next: number }
  // SessionEntry:
  /** Claude only: set while the agent's terminal shows a question (permission prompt, menu), e.g. 'dialog open'. */
  waitingFor?: string;
  // Provider:
  /** Enables the Panel view. `from`/`next`: byte offsets, so a live session only parses what was appended. */
  readTranscript?(file: string, from?: number): Promise<TranscriptChunk>;
  ```
- Produces (markdown.ts): `export function renderMarkdown(md: string): string` (HTML) and `export function escapeHtml(s: string): string`.

- [ ] **Step 1: Write the failing tests** in `test/markdown.test.js` (`const { renderMarkdown } = require('../out/panel/markdown')`):
  - `escapes html`: `renderMarkdown('<img src=x onerror=alert(1)>')` contains `&lt;img` and no `<img`.
  - `drops javascript links`: `[a](javascript:alert(1))` → no `href="javascript:`; `[a](https://x.y)` → `<a href="https://x.y"` with `data-href` or plain href (builder's choice, webview intercepts clicks).
  - `table`: `| A | B |\n|---|--:|\n| 1 | 2 |` → one `<table>`, `<th>A</th>`, a `<td` for `2` carrying `text-align:right` (or class `r`).
  - `ragged table`: header with 3 cells, a row with 2 → row padded to 3 `<td>`.
  - `escaped pipe`: cell `a \| b` → single cell text `a | b`; `` `x|y` `` inside a cell stays one cell.
  - `fenced code`: ```` ```ts\nconst a = 1 < 2\n``` ```` → `<pre><code class="lang-ts">` with `&lt;`.
  - `inline`: `**b** *i* \`c\`` → `<strong>b</strong> <em>i</em> <code>c</code>`.
  - `lists and headings`: `# H\n- a\n- b\n1. x` → `<h1>`, one `<ul>` with 2 `<li>`, one `<ol>`.
  - `crlf and turkish`: `"Şu tablo\r\n\r\n| Ğ | ü |\r\n|---|---|\r\n| ı | ç |"` → table with those characters intact.
- [ ] **Step 2:** Add `"test": "tsc -p . && node --test test/"` to `package.json` scripts (edit with node, not PowerShell). Run `npm test` → FAIL (module not found).
- [ ] **Step 3: Implement** `escapeHtml` and `renderMarkdown` in `src/panel/markdown.ts`: line-based block pass (fenced code, headings, `>` quotes, `---`, lists, GitHub tables = a `|` line followed by a delimiter line, paragraphs), then an inline pass on already-escaped text (code spans first, then bold / italic / links). Tables get `<div class="tbl"><table>…</table></div>` so the webview can attach the buttons.
- [ ] **Step 4:** `npm test` → all `markdown` tests PASS; `npx tsc -p .` clean.
- [ ] **Step 5: Commit** `feat(panel): chat item types and markdown renderer`.

### Task 2: Claude transcript reader and question state

**Files:**
- Modify: `src/providers/claude.ts` (Live record → `waitingFor`; `readTranscript`)
- Create: `src/transcript.ts` (shared incremental line reader)
- Create: `test/claude-transcript.test.js`, `test/fixtures/claude.jsonl`

**Interfaces:**
- Consumes: `ChatItem`, `TranscriptChunk` (Task 1).
- Produces: `export function readLines(file: string, from: number): { lines: string[]; next: number }` in `src/transcript.ts` — reads from byte `from` to the last `\n`; if the file is shorter than `from`, restarts at 0 (caller sees `next < from` and resets). Claude provider's `readTranscript`; exported pure `export function claudeItems(lines: string[]): ChatItem[]` for tests.

- [ ] **Step 1: Write the fixture** `test/fixtures/claude.jsonl` (synthetic, ~8 lines): a `user` line with string content; an `assistant` line with `text` + `tool_use` (`name: "Read"`, `input: { file_path: "src/a.ts" }`); a `user` line with `tool_result` whose `content` is `[{type:"image",source:{type:"base64",media_type:"image/png",data:"iVBORw0KGgo="}},{type:"text",text:"Screenshot size: 1x1"}]`; a `user` message with an `image` block; one `ai-title` line and one `custom-title` line (must be skipped); an assistant `text` with a Markdown table.
- [ ] **Step 2: Write the failing tests**:
  - `items in order`: kinds = `['user','assistant','tool','image','toolResult','image','assistant']` (exact order per your fixture; assert it).
  - `tool summary`: tool item `{ name: 'Read', summary: 'src/a.ts' }` (summary = first string among `file_path`, `command`, `pattern`, `url`, `description`, else `''`, cut to 120 chars).
  - `bookkeeping skipped`: no item for `ai-title` / `custom-title` / `system` lines.
  - `partial last line`: write fixture minus the final newline of the last line to a temp copy; `readTranscript(tmp, 0)` returns items without the last one and `next` = offset of that line's start; append `\n`, call with `next` → exactly the missing item.
  - `shrunk file restarts`: `readLines(tmp, 10_000_000)` → `next` ≤ file size and lines from 0.
- [ ] **Step 3:** Run `npm test` → the new tests FAIL.
- [ ] **Step 4: Implement** `readLines` (fs.openSync / readSync from `from`, cut at last `\n`, UTF-8 safe because the cut is on a newline byte) and `claudeItems` + `readTranscript` in claude.ts. In the Live reader (line ~41) set `waitingFor: j.status === 'waiting' ? String(j.waitingFor ?? 'input') : undefined` and pass it through to `SessionEntry` wherever `busy` is passed.
- [ ] **Step 5:** `npm test` PASS; `npx tsc -p .` clean.
- [ ] **Step 6: Commit** `feat(panel): claude transcript reader, waitingFor`.

### Task 3: Codex transcript reader

**Files:**
- Modify: `src/providers/codex.ts`
- Create: `test/codex-transcript.test.js`, `test/fixtures/codex.jsonl`

**Interfaces:**
- Consumes: `readLines` (Task 2), `ChatItem`.
- Produces: `export function codexItems(lines: string[]): ChatItem[]`; Codex provider's `readTranscript`.

- [ ] **Step 1: Write the fixture** (synthetic): `session_meta`; `response_item` `message` role `user` with `input_text` `<image name=[Image #1] path="C:\\x.png">`, `input_image` `data:image/png;base64,iVBORw0KGgo=`, `input_text` `</image>`, `input_text` `fix this`; `response_item` `reasoning` (skip); `response_item` `function_call` `{name:"shell", arguments:"{\"command\":[\"git\",\"status\"]}"}`; `function_call_output` whose `output` is an array with `input_text` and an `input_image`; `custom_tool_call` `{name:"exec", input:"await tools.x()"}` + `custom_tool_call_output` (string output); `response_item` `message` role `assistant` with `output_text` holding a table; `event_msg` / `turn_context` lines (skip); a `message` role `developer` or `user` whose text starts with `<environment_context>` or `# AGENTS.md` (skip: injected context, not the user).
- [ ] **Step 2: Write the failing tests**: `items in order` (assert exact kinds), `image markers stripped` (no user text containing `<image name=` or `</image>`; user text = `fix this`), `function call summary` (`shell` → summary `git status`), `output images found`, `injected context skipped`, `string output` (custom tool output string → `toolResult` text).
- [ ] **Step 3:** `npm test` → FAIL.
- [ ] **Step 4: Implement** `codexItems` + `readTranscript` (tool `summary`: parse `arguments` JSON; `command` array joined by spaces, else first string field; custom tool: first line of `input`, 120 chars).
- [ ] **Step 5:** `npm test` PASS; also run once by hand against a **copy** of one real rollout with images (copy into the scratch dir; never read through the provider's real path) and check the item kinds look right.
- [ ] **Step 6: Commit** `feat(panel): codex transcript reader`.

### Task 4: The panel webview (read-only)

**Files:**
- Create: `src/panel/panel.ts`, `media/panel.js`, `media/panel.css`
- Create: `test/panel-model.test.js`
- Modify: `src/extension.ts` (command `workspaceAgentSessions.openPanel`, wiring only), `package.json` (command + Projects row inline / context entries)

**Interfaces:**
- Consumes: `renderMarkdown`, `escapeHtml` (Task 1); `Provider.readTranscript`, `SessionEntry` (Tasks 1–3).
- Produces (panel.ts):
  ```ts
  export interface PanelHost {
    /** Fresh entry for this session (live, busy, waitingFor), or undefined if gone. */
    session(providerId: string, id: string): SessionEntry | undefined;
    /** Our terminal currently on this session, if any (launched + terminalFor). */
    terminal(providerId: string, id: string): vscode.Terminal | undefined;
    resume(providerId: string, id: string): void;
    /** The provider's last Snapshot, for the header's 5h / wk bars. */
    snapshot(providerId: string): Snapshot | undefined;
  }
  export function openPanel(host: PanelHost, p: Provider, s: SessionEntry, ctx: vscode.ExtensionContext): void;
  /** Pure, for tests: what the webview receives. Image items become { kind:'image', ref, mime } without data. */
  export function toView(items: ChatItem[], start: number): ViewItem[];
  export const FIRST_BATCH = 200;
  ```
  Webview messages host→view: `{ type:'items', items: ViewItem[], prepend?: boolean, hasEarlier: boolean }`, `{ type:'image', ref, src }`, `{ type:'state', busy, waitingFor?, canSend, readOnlyReason? }`. view→host: `{ type:'earlier' }`, `{ type:'image', ref }`, `{ type:'link', href }`, `{ type:'terminal' }`, `{ type:'send', text }` (Task 5), `{ type:'resume' }`.
- One panel per session (`Map<string, WebviewPanel>` keyed `providerId:sessionId`); opening again reveals it. Title = session title, icon = provider's.

- [ ] **Step 1: Write the failing test** `test/panel-model.test.js` (`toView` only; panel.ts must not import `vscode` at module top-level for this, or put `toView` in `src/panel/view-model.ts`, builder's choice):
  - `initial batch is capped and image data is not inlined`: 500 items incl. images → `toView(items.slice(-FIRST_BATCH), 300)` has 200 entries, image entries have `ref` = absolute index and no `data`.
  - `assistant markdown rendered`: assistant item → `html` field containing `<table` for a table.
- [ ] **Step 2:** `npm test` → FAIL. **Step 3: Implement** panel.ts + media: watch the transcript with `fs.watch` on the file (fallback: the existing 1.5 s debounce pattern), read from the last `next`, reset everything when `next` goes backwards. Webview behaviour per the first mockup (`docs/superpowers/mockups/panel-behaviour.html`), **look per the approved one** (`docs/superpowers/mockups/panel-look.html`) and the spec's "Look" section (exact sizes, fonts, accent colours), colours through theme CSS variables (`--vscode-editor-background`, `--vscode-foreground`, …): header per the spec (agent dot, model · effort, ctx / 5h / wk bars from `host.session` + `host.snapshot`, Terminal | Panel switch where Terminal = `{type:'terminal'}`; header refreshes with the `state` message), items, tool calls as one line each (blue text, 2px left line, no box), completed edits in teal, tool results collapsed (`<details>`), tables with hover buttons Copy (TSV: cells' `innerText` joined by `\t`, rows by `\n`, via `navigator.clipboard.writeText`) and ⤢, images as thumbnails (max 320 px wide) loaded via IntersectionObserver → `{type:'image'}`, overlay (dimmed + blur, click outside / click image / Esc closes, table text selectable inside), "Show earlier" button at the top when `hasEarlier`, auto-scroll only when already at the bottom.
- [ ] **Step 4:** `npm test` PASS, `npx tsc -p .` clean. Manual (F5 Extension Development Host): open a Claude session with a Playwright screenshot and a table, and a Codex session with a pasted image: table renders, Copy pastes into Excel as cells, ⤢ and image overlay open/close by all three ways, a 20 MB+ transcript opens in about a second, new messages appear live.
- [ ] **Step 5: Commit** `feat(panel): webview with tables, images, overlay`.

### Task 5: Message box, send rules, entry points

**Files:**
- Modify: `src/panel/panel.ts`, `media/panel.js`, `media/panel.css`, `src/extension.ts` (PanelHost implementation, terminal toolbar command), `package.json` (`view/title` entry with `view == terminal && workspaceAgentSessions.agentTerminal`, command palette hiding)
- Create: `test/send.test.js`

**Interfaces:**
- Consumes: `PanelHost` (Task 4), `SessionEntry.waitingFor` (Task 2).
- Produces (pure, in `src/panel/send.ts`):
  ```ts
  /** What to type: single line as is; multi-line wrapped in bracketed paste. Always followed by Enter by the caller. */
  export function terminalText(text: string): string;
  export type SendState = { canSend: boolean; hold: boolean; reason?: string };
  /** canSend: our terminal is on this session. hold: Claude shows a question (waitingFor set). */
  export function sendState(s: SessionEntry | undefined, terminalSessionId: string | undefined): SendState;
  ```

- [ ] **Step 1: Write the failing tests** `test/send.test.js`:
  - `single line unchanged`: `terminalText('hi')` === `'hi'`.
  - `multi line bracketed`: `terminalText('a\nb')` === `'\x1b[200~a\nb\x1b[201~'`; CRLF input normalised to `\n`.
  - `canSend false after the terminal moved`: `sendState({id:'A',…}, 'B').canSend === false` with a reason mentioning the other session.
  - `no terminal → read only`: `sendState(s, undefined)` → `canSend false`, reason set.
  - `hold while waiting`: `sendState({id:'A', waitingFor:'dialog open'}, 'A')` → `{ canSend: true, hold: true }`.
- [ ] **Step 2:** `npm test` → FAIL. **Step 3: Implement** send.ts; in panel.ts on `{type:'send'}`: if `!canSend` ignore; if `hold`, keep in a per-panel queue shown in the webview as "queued" with a cancel (×) and post `state` with the bar "Waiting in terminal: <waitingFor>" + "Answer in terminal" (styled per the spec's "Waiting for the user": orange border glow with a single pulse, bar glow, `● ` prefix on `panel.title`, all removed when it ends; no pulse under `prefers-reduced-motion`); when a later refresh shows `waitingFor` cleared, flush the queue in order with `t.sendText(terminalText(x), true)`. Otherwise send at once. Webview keys: Enter and Ctrl+Enter send, Shift+Enter newline. Read-only sessions show the reason line instead of the box, plus "Resume in terminal" when `!live` and the provider has `terminal`. State updates ride on the existing `refresh` / `treeChanged` events (no new polling). Entry points: Projects session row inline icon `$(preview)` "Open Panel" (context `psession`, only when the provider has `readTranscript` → add a `panel` flag to the row's contextValue), right-click entry, and the terminal toolbar button.
- [ ] **Step 4:** `npm test` PASS, tsc clean. Manual in a real Claude terminal: send a single line and a 3-line message (arrives as one message); trigger a permission prompt (ask for something not allowed in the current mode), confirm `sessions/<pid>.json` shows `status: "waiting"` (record the `waitingFor` value seen in AGENTS.md), send from the panel → it is held, bar shows, answering in the terminal flushes it; `/clear` in the terminal → the old panel turns read-only. Codex terminal: send works.
- [ ] **Step 5: Commit** `feat(panel): message box, hold while a question is open, entry points`.

### Task 6: Docs, version, package

**Files:** `README.md` (short "Panel view" section incl. the send rules), `CHANGELOG.md` (`## 0.31.0`), `AGENTS.md` (files table: `src/panel/*`, `src/transcript.ts`, `media/`, `test/`; architecture bullet; transcript formats + `status: "waiting"`; Build section: `npm test`; drop "No automated tests" from known limits), `package.json` version `0.31.0`.

- [ ] **Step 1:** Write the docs; `npm test` and `npx tsc -p .` green.
- [ ] **Step 2:** `npm run package`; `unzip -l` the `.vsix`: contains `media/panel.js`, `media/panel.css`, `out/panel/*`; no `test/`, `docs/`, `src/`.
- [ ] **Step 3:** `code --install-extension workspace-agent-session-manager-0.31.0.vsix --force`, reload, repeat the Task 4/5 manual checks once on the installed build.
- [ ] **Step 4: Commit** `0.31.0: Panel view` (do not push; the orchestrator reviews first).
