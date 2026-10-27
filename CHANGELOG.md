# Changelog

## 0.31.2

- Panel: a **◐** button in the header switches the background between the editor's and the terminal's, so the panel can match the terminal beside it. The choice is shared by all panels and remembered.
- Panel: orange now also marks what is happening or pending: *working…* in the header pulses, the message box is outlined orange while you type, a queued message has an orange edge, and your own messages carry a thin orange edge.

## 0.31.1

- **Open Panel...** in the Command Palette (*Agent Sessions: Open Panel...*): pick any session, open ones first (running, or waiting for you), then the latest closed ones. The Panel button on a Projects row only shows on hover, so it was easy to miss.
- **New session with a Panel**: the new-session menu offers *<Agent> in terminal + Panel*. The Panel opens next to the terminal once the agent has the session; a Claude session has no transcript until its first message, so it starts empty (*Type your first message below*) and fills in live. The agent's own VS Code panel is now called *in its own extension panel* in that menu.
- The Panel keeps watching when a new session's project folder does not exist yet.
- Fixed: the queued-message line in the Panel showed a space wherever the message had an *s* (a mistyped whitespace pattern).
- Times in lists and details past a day read `2d 3h ago` instead of `51h 20m ago`.

## 0.31.0

- **Panel view**: open any session as a conversation in an editor tab, next to its terminal (the **preview** button on a Projects row, its right-click menu, or the toolbar of an agent terminal started from here). Markdown tables are real tables with *Copy* (as cells) and *Enlarge*; images from tool results and your messages show as thumbnails and enlarge on click; tool calls are one-line chips and results fold open smoothly.
- **Message box** in the Panel: Enter or Ctrl+Enter types the text into the session's terminal, Shift+Enter adds a line, several lines are pasted as one block. Only terminals started from here can be typed into; other sessions are read-only, with *Resume in terminal* for a closed one. A panel turns read-only when its terminal closes or moves to another session (`/clear`, `/resume`).
- While Claude's terminal shows a question (permission prompt, menu) the Panel does not type, since Enter would answer it: it shows *Waiting in terminal*, glows orange and holds your message until the question is answered.
- Header with model, effort, context, 5h and weekly bars (orange from 80%).
- Long sessions open fast: the last 200 items first, images read from the transcript only when scrolled into view (about 2 MB of memory for a 135 MB transcript instead of about 38 MB).
- Session lists are cached per file by modification time and size: refreshes no longer re-read every transcript.
- New API for other extensions: `Provider.readTranscript` (enables the Panel for a provider), `ChatItem`, `SessionEntry.waitingFor`.
- Unit tests (`npm test`).

## 0.30.17

- Projects view: right-click a repo for *Move Up* / *Move Down* / *Move to Top*; the order is remembered.
- Right-click menus: sessions get resume / close / archive / delete, repos get *New Agent Session...* on top.
- Restart terminal: right-click a session with our terminal, or *Restart All Agent Terminals* in the Projects menu. Closes the terminal and resumes the session in a fresh one.
- *Explorer Follows Active Terminal* (Projects menu, off by default): the active terminal's repo is shown in the Explorer, and Usage and Projects move under the Explorer so revealing a repo does not switch the sidebar away from them.
- Session rows: the tooltip (and the details dialog) show the model and reasoning effort of the last turn, plus the context used.
- Terminals started from Projects keep their session mapping across window reloads, Codex too; older Codex terminals are re-attached by their name, their session id in the launch arguments, or by being the only open Codex session in their folder.
- Codex limits use the newest report for each window across recent transcripts; readings older than an hour are marked as outdated.
- The new-session menu closes when you click elsewhere.
- *Debug: List Terminals and Open Sessions* command for diagnosing terminals that are not matched to their session.

## 0.30.12

- Projects view: its title says what **+** on a repo starts (*+ Claude*), and the button to change it moved from the **…** menu to the title bar.
- README: screenshots of the views, the status bar and the quick picks.

## 0.30.11

First Marketplace release.

- Status bar: context, 5-hour and weekly usage of Claude Code and OpenAI Codex, following the session in the active terminal; hover for the same bars as the Usage view.
- Usage view: the same numbers as bars, with one context row per open session.
- Projects view: every agent's sessions grouped by repo, with new (agent, model, effort, attached files), resume, close, rename, archive, unarchive and delete. Sessions outside the workspace are listed under *Other folders*.
- Rename any closed session from the Projects view (✎ on the row); open ones in a terminal through the agent's `/rename`.
- The active terminal's session is highlighted in the Projects and Usage views. Sessions already running in one of the window's terminals (also after a window reload, or Claude Code typed into a shell) open that terminal instead of offering to resume them again. A Claude terminal follows `/clear` and `/resume` to its new session.
- Sessions list with details and bulk delete.
- Agent terminal toolbar: `/context`, `/usage`, `/compact`, `/model`, mode switch and the agent's slash-command menu.
- Provider API for other extensions to add agents.
- Live Claude limits (opt-in): Claude Code's status line saves its 5h / weekly numbers on every reply, and gives the context window of new models too. Its button is yellow until you choose, then green (on) or dimmed (off), and the script can be read (Show Script) before it is installed.
- A green / yellow / red dot next to each agent in the Usage view: how fresh its 5h / weekly numbers are.
- Claude limits from /usage: no script needed. Copy Claude Code's `/usage` dialog, check what was read, save. The terminal toolbar's `/usage` button leads straight into it.
- Outdated limit readings are drawn fainter, with a `~`.
- Local only: reads the agents' own files and runs their own CLIs. No network requests, no telemetry, never the agents' logins.
