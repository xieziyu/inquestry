# Changelog

Only **user-visible** changes are recorded here. Internal refactors, docs and CI adjustments are not
listed — read `git log` for those. Versions follow [Semantic Versioning](https://semver.org/);
while on `0.x`, the minor position doubles as the breaking-change position.

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
