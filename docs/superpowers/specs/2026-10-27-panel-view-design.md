# Panel view: a session rendered as a conversation, next to its terminal

Date: 2026-10-27 · Status: draft for approval · Builds on 0.30.17

## Why

The user runs 4–7 agent sessions (Claude Code, Codex) side by side in VS Code terminals. The terminal
cannot show what the agents produce best: **images are not visible at all** (Playwright screenshots, pasted
pictures) and **Markdown tables are squeezed and smeared**, worse the more columns are open. The rest
(dragging, layout, voice) matters much less. Showing images and tables properly is the goal of this step.

This is step 1 of three. Step 2 (control from a phone) and step 3 (a fast standalone app, maybe Rust) come
later and will reuse what this step builds: turning a transcript into a list of renderable items.

## What it is

Every session gets a second way to be shown: **Panel**, beside the existing **Terminal**. The panel is a
webview tab in the editor area (so it can be split, dragged and put side by side like any editor) that
renders the session's transcript as a conversation:

- user messages, assistant text (Markdown), tool calls as one-line chips (name + short argument), tool results
  collapsed by default;
- **tables** rendered as real HTML tables. Hovering shows two buttons top-right: **Copy** (TSV, pastes into
  Excel / Sheets as cells; the text itself also stays selectable) and **⤢** (enlarge);
- **images** (from tool results and from user messages) as thumbnails; clicking one enlarges it;
- **enlarged view**: a dimmed, blurred overlay over the panel with the table / image large in the middle.
  Click outside it, click the image, or press Esc to close. Text in an enlarged table is still selectable.
- a **message box** at the bottom: Enter sends the text to the session's terminal, as if typed there.

Behaviour mockup: `docs/superpowers/mockups/panel-behaviour.html` (the Terminal | Panel switch in the header,
Copy / ⤢ on hover, the overlay). The real panel uses the theme's CSS variables, so light themes work too.

### Look (approved 2026-10-27)

Approved look: `docs/superpowers/mockups/panel-look.html` ("B + A's colors"). It overrides the first mockup's styling;
the first one still defines the behaviour (Copy / ⤢ / overlay).

- **Layout and type (from "B, airy")**: reading text 15px / line-height 1.65 in a serif stack
  (`Georgia, "Iowan Old Style", serif`); body padding 14px 18px; user messages as rounded bubbles (radius 14px,
  padding 8px 14px, 14px sans-serif); tables 13px sans-serif with radius 10px, a 1px outline, cell padding
  7px 12px; images as thumbnails with radius 12px and a soft shadow; inline code 13px monospace on a slightly
  lighter background, radius 4px.
- **Colours (from "A, VS Code native")**: the theme's own background / foreground / borders via VS Code CSS
  variables (the mockup's #1e1e1e / #cccccc / #3c3c3c are the Dark+ values), so light themes follow.
- **Accents: blue, teal, orange.** Tool calls = monospace 12.5px, blue text (`#9cdcfe`, name in `#3794ff`),
  **no border box and no background**, only a 2px blue line on the left. Completed results (✓ edited / written)
  use the same shape in teal (`#2ec4b6`). Things that need the user (question in the terminal, errors) use the
  same shape in orange (`#f0883e`). In light themes, pick darker shades of the same three hues.
- **Session header** (top of every panel, one line, wraps when narrow): agent name with a coloured dot
  (Claude orange, Codex teal; other providers blue), model · effort, then **ctx** as a small bar + "18% ·
  180k / 1M", **5h** and **wk** as small bars + used %, and the Terminal | Panel switch on the right. Under it,
  the session title · repo in small dim text. Data comes from what the extension already has: `SessionEntry`
  (`ctxUsed`, `contextDetail`, `model`, `effort`) and the provider's last `Snapshot` (`fiveLeft`, `weekLeft`
  shown as used = 100 − left, `limitsStale` → drawn fainter with `~`, as the Usage view does). Missing values
  are left out, not shown as "—". Claude's 5h / weekly still need the status line ("Live Claude limits"):
  checked 2.1.311 on 2026-10-27, nothing else writes them to disk.

**Terminal mode stays exactly as it is.** Nobody who prefers the terminal loses anything; the panel is an
extra view of the same session, not a replacement.

## How it works (decided)

- **The agent keeps running in its terminal.** The panel does not start its own agent process and does not use
  any headless / JSON mode: it only **reads the transcript file** the agent already writes
  (`SessionEntry.file`) and **types into the terminal** (`Terminal.sendText`) for the message box.
  One process per session, both views always agree, and everything the terminal offers (permission prompts,
  `/model` menus, plan approvals) keeps working there.
- **Live**: the panel watches the transcript file and appends new items as they are written (debounced, read
  from the last known offset; a full re-read only when the file shrinks or is replaced, e.g. after `/clear`
  moves the terminal to another session, which `resolveLaunched` already detects).
- **Where the switch lives**: a "Panel" action on session rows in the Projects view (inline icon + right-click)
  and as a button on the terminal toolbar of our agent terminals (same mechanism as the existing `/context`,
  `/model` buttons: `view/title` with `view == terminal && workspaceAgentSessions.agentTerminal`); inside the panel, the header's "Terminal" button shows the
  session's terminal. Both views can be open at once.
- **Typing is allowed only into terminals this extension started** (`launched`), the existing rule. For any
  other session (closed, open in the agent's own panel / app, or an agent typed into a shell) the panel is
  **read-only**: the message box is replaced by a line saying why, with "Resume in terminal" when the session
  is closed and the provider can resume it.
- **Sending while the agent works: straight to the terminal** (user's decision). Enter sends at once, exactly
  like typing into the terminal; both TUIs already take input typed during a turn.
- **Except while a question is on screen.** Claude's permission prompt takes Enter as its default "Yes", so text
  typed then could approve a tool call. Claude Code records that state: its pid record
  (`sessions/<pid>.json`) has `status: "waiting"` and a `waitingFor` reason (seen in the 2.1.x binary:
  "dialog open", "input needed", "sandbox request", ...) while a dialog / permission prompt is open, else
  `busy` / `idle`. Then the panel shows a bar "The terminal is asking: <waitingFor>" with an "Answer in
  terminal" button, and a message sent meanwhile is held in the panel as "queued" (cancellable) and typed into
  the terminal once the status leaves `waiting`. Expose it as a new optional `SessionEntry.waitingFor?: string`
  filled by the Claude provider (verify the field in a real session with a permission prompt open).
  Codex records no such state, so its sends always go straight through (the user runs Codex without prompts).
- **Keys**: Enter and Ctrl+Enter both send (the user sends mid-turn with Ctrl+Enter in Claude Code and expects
  the same here). **Multi-line input** (my call): Shift+Enter adds a line. A multi-line message is sent wrapped in bracketed
  paste (`ESC[200~` … `ESC[201~`, then Enter), so the TUI takes it as one pasted block rather than one submit
  per line. Verify in a real terminal for both agents.
- **When the agent waits for something only the terminal can answer** (a permission prompt, a menu), the
  panel does not try to mirror it. It shows the session's busy / idle state and the header's Terminal button
  is always one click away.

### Provider contract

Turning a transcript into items is agent-specific, so it is a new **optional provider capability** in
`src/api.ts` (capability-driven like the others: no capability, no Panel action):

```ts
readTranscript?(file: string, from?: number): Promise<{ items: ChatItem[]; next: number }>
```

`from` / `next` = byte offset, so live updates only parse what was appended. `ChatItem` is a small,
agent-neutral union: user text, assistant text (Markdown string), tool call (name, short summary), tool result
(text, collapsed), image (`mime` + base64 data). Both built-in providers implement it:

- **Claude** (`~/.claude/projects/.../<id>.jsonl`): `user` / `assistant` lines, `message.content` blocks:
  `text`, `tool_use`, `tool_result` (whose `content` may hold `{type:"image",source:{type:"base64",media_type,data}}`
  blocks: Playwright screenshots arrive this way), and images in user messages.
- **Codex** (`~/.codex/sessions/.../rollout-*.jsonl`): `response_item` lines; `payload.type: "message"` with
  `content` items `input_text` / `output_text` / `input_image` (`image_url: "data:image/png;base64,..."`),
  plus `custom_tool_call` / `custom_tool_call_output` and `function_call` / `function_call_output`. Tool
  outputs carry images inline too (seen: 30 `function_call_output` and 5 `custom_tool_call_output` lines with
  `input_image` in the user's rollouts), so both message content and tool output arrays are scanned for them.
  Codex writes no approval / question state to disk (no such event in rollouts, 2026-10-27), hence no
  `waitingFor` for Codex.
  Skip `reasoning`, `event_msg`, `turn_context` and other bookkeeping lines.

Verify both parsers with node against **copies** of real transcripts (AGENTS.md: never the real folders).

## Constraints

- **No new runtime dependencies, no network** (AGENTS.md). That includes the Markdown renderer: write a small
  one (headings, paragraphs, bold / italic / inline code, fenced code blocks, lists, links, GitHub tables,
  blockquotes, horizontal rules). Escape all HTML first; transcript text is untrusted. Links open via
  `vscode.env.openExternal` only after a click, never auto-loaded.
- Webview with a strict CSP: no remote sources; images only as `data:` URIs; scripts by nonce.
- **Size**: transcripts reach tens of MB, mostly base64 images. Render the last ~200 items first with "Show
  earlier" above; send images to the webview lazily (thumbnail placeholder until scrolled into view) so a long
  session opens fast.
- `@types/vscode` stays at `~1.93.0` (no APIs newer than 1.93).
- Match the existing style (terse, small functions, comments only for non-obvious why). `extension.ts` is
  already 1,600 lines: put the panel in its own file (e.g. `src/panel.ts` + the webview script/CSS), and the
  Markdown renderer in its own module.

## Non-goals (this step)

- Voice input. The user's ChatGPT voice → text bridge stays.
- Starting agents without a terminal (headless), or re-implementing permission prompts / menus in the panel.
- Mobile access, any network listener, the standalone app.
- Editing / branching / deleting messages from the panel.

## Anti-goals (would make this a failure even if it works)

- The panel feeling slower or heavier than the terminal it sits next to (a long session must open in about a
  second, scrolling must stay smooth).
- Losing or changing anything for terminal-only users.
- Typing into a terminal the extension did not start, or into the wrong session.

## Left to the builder

The webview's internal structure, the exact icons, the item-grouping details (e.g. how many tool chips to show
before collapsing a run of them), debounce timing, and how "Show earlier" pages. Update README (a short
"Panel view" section), CHANGELOG (next version), and AGENTS.md (files table, architecture, transcript formats
above) as part of the work.
