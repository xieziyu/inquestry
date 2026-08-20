# Changelog

Only **user-visible** changes are recorded here. Internal refactors, docs and CI adjustments are not
listed — read `git log` for those. Versions follow [Semantic Versioning](https://semver.org/);
while on `0.x`, the minor position doubles as the breaking-change position.

## [0.2.0] - 2026-08-20

A newly created investigation now starts on its own, and you can see what it is doing right now.

- **A new investigation runs its first turn by itself.** It used to sit on the trunk card doing nothing — the composer button is the only entry to a session and it is disabled while the input is empty, and nothing on screen said what was being waited for. Creating a case now starts the first turn; if that turn cannot start, it says so (banner plus a crashed session), and your draft stays in the composer instead of being queued behind a busy flag nobody reads. (#1)
- **A link in the description no longer forces the fallback title.** The title probe now gets no tools at all: it reads only the text you wrote, and never reaches for what a link or a file holds — that is the investigation's job. It previously kept one tool entry open, so a model that saw a link tried to fetch, spent the probe's single turn on it, and the title silently stayed on the fallback with nothing on screen saying the probe had failed. When the description is short enough to be just a link, the title now carries whatever identifier it can recognise (issue number, traceId, service name, user id). (#9)
- **See what is happening right now.** A running step card carries a heartbeat strip (tool name, elapsed time, call and evidence counts), every running sub-agent gets a chip on its lane head, and the HUD shows the last update. Seconds are ticked by the renderer rather than by snapshots — a 90s tool call pushes nothing at all on its own. (#2)
- **Operator backfills can be declined.** The backfill card gains a "don't run" gesture: you can hand a statement back when you have no access either, or when it should not run in production, with the reason optional. The agent receives an explicit refusal — it will not treat it as "queried, no rows" and reason on from there, nor send the same statement again — and the call is recorded on the track as denied rather than done. (#4)
- **Everything pending is collected when a session breaks off.** A stream break or crash used to collect only lanes, leaving pending backfills, pending gates and in-flight tool calls where they were: a call showed as running until the next launch, and report call counts ran high with it. (#3)
- **Lane narration only says what the track cannot show.** A lane that finished with a conclusion is no longer read out again in the chat strip — that sentence is already on the card; narration is kept for the lane that made no calls at all and therefore never appears on the track. (#5)
- **Calmer report layout.** The root cause is set as ordinary body prose instead of a wall of enlarged bold text, and the paper stamp is reduced to a small tag. The layout no longer guesses which words matter. (#7, #8)
- **Fixed: the grab cursor on the stage leaked onto selectable text.** (#6)

**Upgrade notes**: no database migration in this release — the schema stays at v7, the same database 0.1.1 uses. Downgrading back to 0.1.1 opens it as usual: a declined backfill is stored as a `denied` call, which the older version already understands; it just has no "don't run" gesture in the UI.

## [0.1.1] - 2026-08-19

Fixes 0.1.0 not being able to reach Claude at all.

- **Fixed: investigations could not start in the released build.** The CLI the agent runs was packed inside the asar archive and could not be spawned (`spawn ENOTDIR`). It showed up as an empty backend and model list in the new-investigation panel, and nothing happening on "start". Only the packaged app was affected; running from source was not.
- **Claude Code no longer has to be installed.** The app ships its own CLI; all it needs is a logged-in Claude account (the first login still happens in a terminal via `claude auth login`). The About section now shows the login state and account, and the environment warning says that instead of "claude executable not found".

## [0.1.0] - 2026-08-16

First public release.

- **Full evidence retention**: the harness persists the raw input/output of every tool call the agent makes; the agent's prose only indexes and judges. Reviewing an investigation relies on the evidence itself, not on re-running.
- **Timeline as control plane**: watch the investigation live and act on nodes directly — approve / rewrite / deny / take over / stop; `ask_operator` hands credential-requiring or high-consequence operations back to you, and forces the agent to state its expectation before seeing the result.
- **Two timelines**: the investigation timeline follows the agent's order of actions; the system timeline reorders by when events actually occurred — two projections of the same evidence.
- **Conclusions can be overturned**: overturned conclusions stay in the report together with their evidence; no fabricated straight-line history.
- **The report is a projection**: sections are projected from the database and agree with the process by construction; Markdown and long-image exports.
- **Retrieval by investigation**: one investigation spans multiple sessions; everything lives in local SQLite, with large payloads stored content-addressed on disk.
- **Runs on your Claude subscription**: spawns the local `claude` CLI and inherits its login credentials; your existing skills and MCP configs load as usual.
- **In-app auto-update**: downloads in the background and installs on quit; the settings screen shows status and offers an immediate restart.
