# Changelog

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
