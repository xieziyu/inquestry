<p align="center">
  <img src="build/icon.png" width="96" alt="Inquestry" />
</p>

<h1 align="center">Inquestry</h1>

<p align="center">Investigate with an agent</p>

<p align="center">
  <a href="https://github.com/xieziyu/inquestry/releases/latest"><img src="https://img.shields.io/github/v/release/xieziyu/inquestry?color=brightgreen&label=release" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-black.svg" alt="Platform" />
  <img src="https://img.shields.io/badge/agent-Claude%20Code-d97757.svg" alt="Claude Code" />
</p>

<p align="center">
  <a href="https://xieziyu.github.io/inquestry/">Website</a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> · English
</p>

Inquestry is a macOS desktop app for investigating problems together with an agent. The raw input and output of every tool call it makes is kept in full.

When you troubleshoot with an agent, the loss happens at the reporting step: it reads 500 lines of logs and writes one sentence, "replication lag caused the stale read". Those 500 lines are gone, and checking the conclusion means re-running the whole thing. Inquestry splits the responsibility: the harness persists the raw input/output of every tool call, and the agent's prose only serves as index and judgment.

## The investigation workspace

The investigation runs live. Every step the agent takes lands on the timeline, and each node carries actions: approve, rewrite, deny, take over, stop. You can interrupt and redirect at any point. Permissions split by consequence: local read-only queries the agent runs itself; anything needing your credentials or carrying consequences a human must own (production databases, sensitive data, writes) goes through `ask_operator` and back to you. The agent has to write down what it expects before it sees the result, which blocks after-the-fact rationalization.

![Workspace: the timeline canvas with actions waiting on you](docs/assets/screen-workspace.jpg)

## The report

The report is not a summary written by the agent. It is projected from the database: system timeline, root cause, investigation path, impact and open questions each have a fixed data source, and the only thing the agent actually writes is the fix suggestion. Conclusions overturned along the way stay in the report with their evidence; the wrong turns are the most valuable part of an investigation. Export as Markdown or a long image.

![Report: root cause, causal chain and system timeline](docs/assets/screen-report.jpg)

One investigation can span multiple sessions, and everything lives in a local SQLite database. The app ships the `claude` CLI and spawns it on your existing Claude subscription, so no API key is needed, and your skills and MCP configs work as usual.

## Install

### Prerequisites

- macOS, Apple Silicon
- A logged-in [Claude](https://claude.com/claude-code) account. The CLI ships with the app, but the first login happens in a terminal via `claude auth login`

> ⚠️ The workspace directory you pick when creating an investigation is the trust boundary, equivalent to running `claude` there: hooks and `.mcp.json` in that directory execute on load. Only pick repositories you trust.

### Download

Grab the `.dmg` from the [latest release](https://github.com/xieziyu/inquestry/releases/latest) and drag it into Applications. Later versions arrive via in-app auto-update.

The `.zip` on the same page is for the auto-updater; manual installs don't need it.

See the [CHANGELOG](CHANGELOG.en.md) for what changed in each version.

### Run from source

Requires Node.js 22+:

```bash
npm ci
npm run dev
```

To build a local package for yourself: `npm run package` (ad-hoc signed, runs on this machine only). Official builds are signed and notarized by CI when a `v<version>` tag is pushed — see [docs/design/release.md](docs/design/release.md).

## License

[GPL-3.0-or-later](LICENSE)
