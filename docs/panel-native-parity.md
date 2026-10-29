# Panel and native CLI parity

Audit: 2026-10-29. Sources: the provider implementations, synthetic fixtures, read-only event-schema inspection of the installed Codex CLI, and the official protocol documentation below. No credentials were read and no real transcript was modified.

The panel currently mirrors an agent running in a terminal. Transcript records describe persisted work; they are not an acknowledgement protocol for terminal input or a complete copy of the terminal UI.

| Experience | Available now | Remaining limit |
| --- | --- | --- |
| Model and effort | Last recorded values in the header | A native selection made between turns may not be recorded until the next turn. |
| Conversation and repository | Title and full path, with click to copy the path; latest Codex turn cwd takes precedence | Other providers can only expose the cwd they record. |
| Mode and permissions | Recorded Codex collaboration mode, approval policy and sandbox | These are recorded settings, not controls that change permissions. Missing values stay absent. |
| Working and elapsed time | Header indicator and bottom status; Codex uses the recorded turn start | Claude elapsed time starts when busy is first observed. Internal thinking is not guessed from file writes. |
| Interrupt | Bottom **Esc to interrupt** button and keyboard shortcut | Exact live, busy session is checked again. Open menus, overlays, native dialogs, startup and an in-flight paste take precedence. |
| Tools and scripts | Expand a tool call to read its recorded arguments or script | Input previews describe requested work; completion must come from a recorded result. |
| Output and code | Highlighted code/diffs, expanded results, full arguments; long previews offer **Open full output** | Full output opens in a VS Code text editor for searching and copying. It is not executed. |
| Errors and completion | Recorded warnings, errors, interruption and completion notes | A CLI message that is never persisted cannot be recovered from a transcript. |
| Native input queue | Busy Codex uses Tab; idle uses Enter; Claude uses Enter. Matching transcript records confirm delivery, including combined prompts | `Terminal.sendText` has no acceptance receipt. Unconfirmed input may still be in the composer or native queue. There is no reliable native queue enumeration/cancel API in this transport. |
| Compaction | Manual request state, explicit recorded phase when present, completion note | Installed Codex 0.164.0-alpha.11.1 was observed recording completion without a start event. Automatic live compaction cannot be claimed from those records. |
| Questions and approvals | Recorded questions and choices are visible; Claude waiting state has a terminal action | Codex approval dialogs and their answer routing are not persisted as a usable interactive protocol. Approval buttons must not be fabricated from copied text. |
| Background terminals | Recorded tool output is visible; `/ps` and `/stop` are offered as native commands | The inspected CommandExecution records describe completed commands, not a current process registry. Their count must not be displayed as the live terminal count. These commands can open a native terminal dialog. |
| Slash suggestions | Local provider command list, filtering, selection and completion | Installed plugins and changing native menus are not discovered from transcript records. |
| Reconnect/resume | Visible **Continue here**, explicit **Connect terminal**, native confirmation step and preserved text | A new live resume may still require the CLI's own “resume anyway” decision. We never terminate an external process to take ownership. |
| Reload and startup | Saved drafts, pending text, mode, native-confirmation flag; static loading UI and retry | A message restored after reload is unconfirmed and is never automatically resubmitted. |
| Mixed development assets | Older host HTML works with newer panel scripts; missing scroll helper is loaded locally | Out/media junctions can update assets before the running Extension Host reloads. New required DOM elements need this compatibility path. |
| Navigation | Projects asks Panel/Terminal on every open; the last choice is listed first | Other entry points retain the last choice. Reload restores the existing VS Code layout without asking again. |
| Scrolling | Follow near bottom, preserve older reading position, shared result scroll and change markers | Native terminal mouse escape sequences are not interpreted as chat content or control requests. |

## Work required for a fully native interaction model

1. Add an explicit agent transport separate from the transcript reader. Keep the current terminal bridge for existing conversations and providers. Capability flags must distinguish transport-backed approval/input controls from read-only records.
2. For Codex, prototype a local app-server client using the CLI's own process and JSON-RPC transport. The documented protocol provides live item deltas, turn steering, interrupt and approval requests. This is an alternative execution connection; starting a second server is not evidence that it controls an already running terminal. Existing `--no-daemon` sessions need an explicit handover/reconnect design. See [Codex App Server](https://learn.chatgpt.com/docs/app-server).
3. For Claude, assess the CLI's programmatic streaming mode and control lifecycle independently. The official documentation describes non-interactive CLI execution and streaming output; hooks expose additional lifecycle events, including compaction and permission requests. They are not automatically installed here. See [programmatic Claude Code](https://code.claude.com/docs/en/headless) and [hook events](https://code.claude.com/docs/en/hooks).
4. Validate real permission prompts, native queue acceptance/cancellation, background process completion, compaction, reconnect after a reboot, and focus preservation before calling the transport complete. Keep authentication inside the agent CLI and retain the repository's local-only/no-new-runtime-dependencies constraints.

This audit does not enable a daemon, expose a network listener, change the user's agent settings, or relax sandbox/approval rules. YOLO mode is not needed to investigate or implement these UI changes.
