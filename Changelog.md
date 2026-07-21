# Changelog

All notable changes to **Metis**. The authoritative version marker is `version` in `package.json`, mirrored by the stamp at the top of each module. Metis also self-checks this repository on invocation and tells you when a newer release has shipped.

---

## v0.4 (2026-07-21)

Condition-aware adherence. The audit no longer only asks "was this tool ever called"; for two Phanes v3.2 tools it asks "was the tool's precondition present, and if so, was it used". A tool absent when nothing called for it is correct, not a miss.

### Added
- **Effort-bridge check (`adherence.mjs`).** Detects the Phanes v3.2 per-agent effort bridge as an executed `claude ... --agent <name> --effort <level>` Bash command (scanning only command strings, so prose that merely mentions the bridge never matches). Flags `effort-under-lift` when an above-baseline archetype ran in-session at the baseline with no lifting spawn (the live v3.1 miss), and `effort-downward-bridge` when the bridge was spent at or below baseline. Silent when the baseline is already `xhigh` or the roster carries no above-baseline archetype.
- **Orchestrator-engagement check (`adherence.mjs`).** Flags `orchestrator-under-engaged` when a plan at or above `orchestratorStepThreshold` was self-orchestrated instead of delegated to the `<slug>-orchestrator`, and `orchestrator-over-engaged` when the orchestrator ran a sub-threshold task. Plan scale is a transcript proxy (peak TodoWrite length vs direct worker spawns); Phanes session-summaries corroborate. Silent when the roster has no orchestrator.
- **Phanes-context reader (`phanes-context.mjs`).** Deterministic, best-effort reader of the artifacts that say what SHOULD have run: `orchestratorStepThreshold` and effort baseline from `.phanes/config.json`, the agent roster and each member's `effort:` tier from `.claude/agents/*.md`, and best-effort plan scale from `documentation/session-summaries/`. All I/O is isolated here; the adherence logic is pure and unit-tested. Reading these costs no LLM tokens; only aggregates are surfaced.
- **Durable subagent transcripts.** The audit now ingests `<session>/subagents/agent-*.jsonl` (the current Claude Code layout) alongside top-level inline agents and the volatile Temp task store, so an orchestrator's own batch behaviour and any in-subagent tool use are visible rather than lost.
- **Report section 3a and JSON `conditionalAdherence`.** The findings render in both outputs, each with its precondition and evidence, all advisory. New per-actor fields `maxTodoCount` and `effortBridgeSpawns` are preserved in the JSON.
- **`/metisupgrade` command (`MetisUpgrade.md`).** A dedicated upgrade command that completely replaces the installed command and engine with the latest published versions while preserving every byte of per-project audit state (run counter, reports, archive, ledger, capability manifest). It stages the new engine to a temp directory and verifies it is complete before removing the legacy files and swapping, so a mid-download failure never leaves a broken install. It self-refreshes, never downgrades, and needs `--force` to reinstall the same version. `/metis` installs it alongside itself.

### Changed
- **`/metis` version handling is now an explicit upgrade offer.** Step 0 no longer silently overwrites the command file on a newer release: it asks the user whether to upgrade, and on yes invokes `/metisupgrade` for the complete replacement. Step 3's engine version check no longer silently re-fetches individual files (which could leave command and engine mismatched); it points to `/metisupgrade` instead.
- Policy now carries `effortBridgePatterns` and an assumed `effortBaseline` (`high`, per Phanes v3.2 launch guidance); both derivation branches and `policy.json` include them.
- The one-file installer fetches the two new engine files (`phanes-context.mjs`, `adherence.mjs`) and installs the sibling `/metisupgrade` command.
- Version stamps bumped to `0.4.0` (`package.json`, `version.mjs`, the command stamp).

---

## v0.3 (2026-07-20)

Install model reworked to match Phanes: one file, self-bootstrapping, with a run counter.

### Added
- **One-file install, like Phanes.** `metis.md` is now the single distributed file. Copy it to `~/.claude/commands/metis.md` (all projects) or `<project>/.claude/commands/metis.md` (one project) and run `/metis`; the command self-refreshes from the repository and, on the first run, fetches its own engine.
- **Install-scope choice.** The first run asks, once, whether to install for all projects (engine at `~/.claude/metis/`, per-project state under `<project>/.metis/`) or just this project (engine and state under `<project>/metis/`). Non-interactive runs default to global and record it. A Phanes project keeps its capability manifest and ledger under `<project>/.phanes/` regardless of scope.
- **Per-project run counter.** The first run is install plus optimization; every later run is an update check plus optimization. The counter and install state persist in `state.json` in the state directory.

### Changed
- **Repository layout.** The command moved to the repository root as `metis.md` (the file users copy, parallel to `phanes.md`); the engine moved into `src/`, so the root stays clean and the engine is a self-contained fetchable set.
- Version stamps bumped to `0.3.0` (`package.json`, `version.mjs`, the command stamp).

---

## v0.2 (2026-07-20)

First public release. It takes the internal audit prototype and adds the capability census and consent contract, genericized policy derivation, the optimization ledger, the `/metis` command, a single dispatcher, and a self-update check.

### Added
- **`/metis` command (`commands/metis.md`).** The standalone entry point. It runs the engine, asks the consent question when appropriate, and presents a per-item optimization checklist. Metis never runs unbidden: this command only acts when you invoke `/metis`.
- **Capability census and consent, per item (`census.mjs`).** Detects MCP servers, plugins, skills, slash commands, and foreign agents; probes MCP reachability (authenticated, unreachable, or unknown); proposes a per-item selection; diffs against the prior manifest so a re-run stays silent unless something changed. On a Phanes project the standard set is pre-selected and recommended; on a standalone project nothing is assumed and nothing is pre-selected. The selection persists to `.phanes/config.json` (Phanes) or `.metis/config.json` (standalone), sharing one schema so runs are diffable.
- **Nothing-to-optimize guard rail.** Before any audit or proposal, Metis stops and says so when a setup has no MCP servers, plugins, skills, or agents to reason about, instead of emitting an official looking but empty report.
- **Genericized policy derivation (`policy.mjs`).** The policy the audit checks against is read from `.phanes/config.json` on a Phanes project and inferred from `.mcp.json`, settings, and `.claude/agents/` otherwise. Exactly one named set, the Phanes standard tools, is ever known to the code, and only on a Phanes project; every other capability is discovered and reasoned about generically.
- **Optimization ledger with verification-first scoring (`ledger.mjs`).** In Phanes-integrated mode, every change or proposal is recorded, and each run first scores the open entries against the new sessions (delivered, not-yet-measurable, regressed) before proposing anything new. A regression produces a rollback proposal. Proposals are gated: an autonomous whitelist (usage-trigger lines, annotations, unreachable-server flags) may be applied and logged; anything structural (merging or removing agents, removing mandates, single-writer reassignments) always asks first. Strong signals only, with a cooldown so the same knob is never touched twice in a window.
- **Single dispatcher (`metis.mjs`).** One entry point, `detect | census | audit | ledger | version`, that also derives the encoded transcript directory from a project path. This is the CLI a Phanes census can recognize as the companion.
- **Self-update check (`version.mjs`).** On invocation, in both standalone and Phanes-integrated use, Metis checks this repository for a newer release and surfaces a notice. Best effort: a short timeout, every network error swallowed, never blocking a run.
- **`--project` policy derivation in the audit engine.** `session-audit.mjs` accepts `--project` and derives its policy generically when no explicit `--policy` is given; an explicit policy always wins.
- **Test suite (`test.mjs`).** `node --test` coverage for the deterministic logic, no dependencies.

### Changed
- The audit engine (formerly the standalone `session-audit` prototype, v0 and v0.1) is now the Metis v0.2 engine. Report headers were rewritten free of em and en dashes, and the tool no longer names any example project.

### Notes
- No runtime dependencies. Pure Node (18 or newer), streaming, Windows-safe paths.
- Reports contain aggregates only; raw transcript content is never emitted, and secret findings are always redacted.

---

### Earlier (internal prototypes, not released)
- **v0.1** added ingestion of the volatile Temp task store, where subagent transcripts (and their internal MCP use, invisible to the parent session) live, plus an idempotent `--harvest` to preserve them before eviction.
- **v0** was the first audit engine: per-actor tool and MCP inventory, adherence flags, token economics, and a redacted secret scan, validated against a real Phanes-orchestrated project.
