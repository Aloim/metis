# Changelog

All notable changes to **Metis**. The authoritative version marker is `version` in `package.json`, mirrored by the stamp at the top of each module. Metis also self-checks this repository on invocation and tells you when a newer release has shipped.

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
