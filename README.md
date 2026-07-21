# Metis

**Metis** is a session-audit companion for [Claude Code](https://claude.com/claude-code). It reads Claude Code's own run transcripts and reports whether your agent setup actually used the tools and workflows it was told to, then proposes evidence-based optimizations. Named for the Titaness of wise counsel, it advises; you decide.

It is not a telemetry pipeline or a dashboard. Think of it as a counsel you re-run. Each time you invoke `/metis`, it takes a fresh census of what you have installed, audits the transcripts that have accumulated since last time, and, on a Phanes-managed project, scores its own past suggestions before offering any new ones. The ground truth is always the transcript, never the console, which hides subagent internals and collapses tool-call detail to a single line.

**No dependencies, pure Node.** Everything deterministic is plain Node (18 or newer), streaming, with Windows-safe paths and no npm install. The only model-token cost is the short final report; the parsing and diffing are free.

**Standalone and Phanes-aware.** Metis works on its own in any Claude Code project, with no [Phanes](https://github.com/Aloim/phanes) install at all. When it detects a `.phanes/` directory it switches into an integrated mode with an optimization ledger and bounded autonomy, and Phanes in turn detects the `/metis` command and calls Metis during its update runs. Neither tool depends on the other; each degrades gracefully to solo operation.

**Which mode are you in?**

| Your situation | What Metis does |
| --- | --- |
| Any Claude Code project, no Phanes | **Standalone.** Nothing is assumed. It builds the capability list purely from detection, audits your transcripts, and proposes optimizations as a per-item checklist. Every change is applied only on your yes. |
| A Phanes-managed project (`.phanes/` present) | **Phanes-integrated.** The Phanes standard tools are recognized, an optimization ledger records every change, and each run verifies its past suggestions before proposing new ones. A narrow autonomous whitelist may act and log; anything structural still asks first. |

**Contents**

- [What it does](#what-it-does)
- [How to use](#how-to-use)
- [Core principles](#core-principles)
- [How to install](#how-to-install)
- [Consent and sequencing](#consent-and-sequencing)
- [Relationship to Phanes](#relationship-to-phanes)
- [Version](#version) · [License](#license) · [Contributing](#contributing)

---

## What it does

Metis installs like Phanes: you copy one file, `metis.md`, as your `/metis` command, and it bootstraps its own engine on the first run. It keeps a per-project run counter, so the **first run installs the engine and runs an optimization pass**, and **every later run does an update check and another optimization pass**. The engine itself is deterministic Node; you interpret its output.

Every optimization pass walks the same path:

**1. Detect and gate.** Metis works out whether the project is standalone or Phanes-managed, whether a transcript directory exists, and whether there is anything to optimize at all. A setup with no MCP servers, no plugins, no skills, and no agents has nothing to build policy around, so Metis stops and says so rather than emitting an empty report. It also self-checks this repository for a newer release; when one has shipped it asks whether to upgrade, and on yes runs `/metisupgrade`, which completely replaces the command and engine with the latest while preserving your audit state.

**2. Census and consent.** It enumerates every installed capability, the MCP servers, plugins, skills, slash commands, and foreign agents, and probes each MCP server to see whether it is actually reachable and authenticated rather than merely configured. It then proposes a per-item selection. On a Phanes project the standard set (`context7`, `deepwiki`, `serena`, `semble`, `frontend-design`) is pre-selected and marked recommended; on a standalone project nothing is assumed and every item is listed unchecked by its detected name. Your selection persists, so the next run stays silent unless the set actually changes, and then it asks only about what changed. A server that is switched off or signed out can never be mandated, even if selected.

**3. Audit the transcripts.** It streams the main-session JSONL, the durable subagent transcripts under `<session>/subagents/` (the current Claude Code layout), and the volatile subagent task store (harvesting it first, because the harness discards it). It aggregates, per session and per agent: tool use by name (MCP split into server and tool), models, tokens, spawns, and errors. Then it diffs actual usage against the policy: a tool that was mandated but never called, a server that was configured but never used, an agent that was never spawned. It runs a redacted secret scan over commands and tool results, and summarizes where the tokens went. A subagent's internal MCP use is invisible in the parent session; recovering it from the subagent transcripts is the whole point.

Beyond that binary check, Metis runs two **condition-aware** checks whose absence is only a finding when the precondition was present, so a tool that was correctly not needed stays silent. On a Phanes v3.2 project it reads the roster and thresholds to ask whether the **effort bridge** delivered an above-baseline archetype's rubric (or was spent downward for no gain), and whether the **orchestrator** was engaged for a plan at or above its step threshold (or over-engaged on a small task). What ran is read from the transcript; what should have run is read from the Phanes artifacts, at no model-token cost. Every such finding is advisory and carries its precondition and evidence.

**4. Verify, then propose (Phanes mode).** Before proposing anything new, Metis scores its open ledger entries against the new sessions: delivered, not-yet-measurable, or regressed. A regression produces a rollback proposal. Only then does it propose new changes, and only from strong signals, with a cooldown so it never oscillates on the same knob. Each proposal is gated. Trigger lines, annotations, and flags may be applied and logged; merging or removing agents, removing mandates, and single-writer reassignments always ask first.

**5. The checklist.** Findings and proposals are presented as a per-item checklist, most-evidenced first, each with its evidence, its proposed change, and its gate. Nothing outside the autonomous whitelist is applied without your yes. Quality signals such as error and retry rates are proxies and are marked as proxies; token spend is the only thing measured directly.

## How to use

Most users only ever type `/metis`. That command is the front end: on the first run it asks the install scope and fetches its own engine, and on every run it asks the consent question through the harness, runs the audit, and presents the checklist. It never runs unbidden.

For direct or scripted use, call the engine dispatcher at `<engineDir>/metis.mjs`, where `<engineDir>` is the folder the first run created (`~/.claude/metis/` for a global install, `<project>/metis/` for a per-project one).

| Command | What it does |
| --- | --- |
| `metis.mjs detect --project .` | Mode, companion presence, the update check, and whether there is anything to optimize (an early stop when not). |
| `metis.mjs census --project .` | Detect capabilities, propose a per-item selection, diff against the prior manifest. `--set-selection a,b` persists the consented selection. |
| `metis.mjs audit --project . --harvest <dir> --out <dir> --last N` | Run the transcript audit. `--dir` is derived from `--project`; `--harvest` preserves the volatile task store first. |
| `metis.mjs ledger --project . --audit <report.json> --verify` | Verification-first scoring of the ledger (Phanes mode). `--propose` lists strong-signal proposals. |
| `metis.mjs version --check` | Print the version and check the repository for a newer release. |

Each piece also runs on its own from the source tree (`node src/census.mjs`, `node src/session-audit.mjs`, `node src/ledger.mjs`, `node src/policy.mjs`, `node src/phanes-context.mjs`, `node src/version.mjs`), and `node --test` runs the suite.

### Policy derivation

Metis never hardcodes an external tool name. It ships knowledge of exactly one named set, the Phanes standard tools, and recognizes it only on a Phanes project. Every other capability is discovered and reasoned about generically from three evidence sources: its own tool names and descriptions, transcript evidence of actual use, and domain matching against the agent roster. On a Phanes project the policy is the consented, reachable selection; standalone, every reachable detected server is treated as configured, and a never-called one is an advisory finding rather than a hard mandate.

### Where the transcripts live

Claude Code stores main transcripts under `~/.claude/projects/<encoded-project-path>/` and volatile subagent transcripts under the Temp task store. The path is encoded by replacing `:` and the path separators with `-`, so `C:\Projects\YourProject` becomes `C--Projects-YourProject`. Metis derives this from `--project` for you. Reports contain aggregates only; raw transcript content is never emitted, and secret findings are always redacted.

## Core principles

- **The transcript is ground truth.** Not the console, which hides subagent internals and collapses tool-call detail. Metis reads the JSONL the harness actually wrote.
- **Advisory-first.** Metis proposes; you dispose. The only self-applied changes are a narrow autonomous whitelist inside a Phanes update run, and each one is logged to the ledger.
- **One named set, everything else discovered.** The code knows exactly one profile, the Phanes standard tools, and only on a Phanes project. No external tool ever gets a hardcoded playbook; usage rules are derived generically.
- **Verify before proposing.** In Phanes mode, every run scores its past suggestions against the new sessions before offering new ones. No stacking new optimizations on unverified ones.
- **Strong signals only, with a cooldown.** Metis acts on a capability that is reachable but unused across several sessions, and it never touches the same knob twice inside a window, so it cannot oscillate.
- **Consent once per project.** The user picks, per item, which capabilities Metis may build policy around. The choice persists and is only revisited when the environment actually changes.
- **Redacted always, aggregates only.** Secret findings show location, pattern type, and a masked value; reports never contain raw transcript content.
- **Quality is proxied, never claimed.** Token spend is measured. Output quality is only approximated, through error and retry rates, and those are labeled as proxies.

---

## How to install

Metis is one file, exactly like Phanes. You install the `metis.md` command, run `/metis` once, and it fetches its own engine on the first run. It needs [Claude Code](https://claude.com/claude-code) and Node 18 or newer; there is nothing to clone and no dependencies to install.

### Install the command

For **all projects** (global), put it in your user commands folder:

**Linux / macOS:**

```bash
mkdir -p ~/.claude/commands
curl -L https://raw.githubusercontent.com/Aloim/metis/main/metis.md \
  -o ~/.claude/commands/metis.md
```

**Windows (PowerShell):**

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\commands" | Out-Null
Invoke-WebRequest `
  -Uri https://raw.githubusercontent.com/Aloim/metis/main/metis.md `
  -OutFile "$env:USERPROFILE\.claude\commands\metis.md"
```

For a **single project**, put it in that project's commands folder instead (`.claude/commands/metis.md` under the project root).

### Run it

Open a project in Claude Code and type:

```
/metis
```

The first run asks whether to install for all projects or just this one, fetches the engine into its folder, installs the sibling `/metisupgrade` command alongside, audits, and presents the checklist. Every later run does a version check and audits again; when a newer version is published it offers to upgrade in place with `/metisupgrade` (a complete command-and-engine replacement that preserves your audit state). Anything after the command is treated as a directive, for example `/metis reinstall` or `/metis verify only`.

### What the first run creates

- The **engine**: `~/.claude/metis/` for a global install, or `<project>/metis/` for a per-project one.
- The **per-project state**: `<project>/.metis/` for a global install (so projects stay separated), or alongside the engine for a per-project install. It holds the run counter, the standalone manifest, and the reports.
- On a **Phanes project**, the capability manifest and the optimization ledger live in `<project>/.phanes/`, per the Phanes contract, whichever install scope you chose.

The command calls the engine as `node <metis-dir>/metis.mjs`; point it at wherever you cloned the repository. Installing the command is also what lets a Phanes-managed project detect Metis and call it during update runs.

---

## Consent and sequencing

Consent is asked once per project, and never twice:

- During a **Phanes run**, Phanes owns the consent gate (its own pre-flight). When a Phanes update run invokes Metis it calls the CLI directly and reads the selection Phanes already wrote; Metis does not re-ask, and it owns only the ledger.
- The **`/metis` slash command** is always user-initiated. On a standalone project, or a Phanes project with no selection yet, it asks the full per-item question. On a Phanes project that already has a selection it reads that and asks only about a delta.

**First run.** Metis does not audit during a Phanes first setup run: there are no steady-state sessions yet, and the ledger is empty. Phanes records that the companion is present and defers the audit to the first update run, when real sessions exist. On any project whose only sessions are a setup run, Metis says the sample is not steady-state work and defers strong conclusions.

---

## Relationship to Phanes

Metis is a [Phanes](https://github.com/Aloim/phanes) companion tool, in the same family as [Charon](https://github.com/Aloim/charon). Like every companion, it is a full standalone tool that needs no Phanes install, and it also snaps into the structures Phanes builds the moment it lands in a Phanes-managed project. Phanes detects the `/metis` command during its capability census; on an update run it has Metis harvest the transcripts, verify its past suggestions against the new sessions, and file an adherence report the run then acts on. Absent Phanes, Metis is simply a standalone auditor.

---

## Version

Current: **v0.3** (2026-07-20). Metis now installs like Phanes: one `metis.md` command that self-bootstraps its engine on the first run, with an install-scope choice (all projects or just this one) and a per-project run counter, so the first run installs and optimizes and every later run does an update check and optimizes again. It builds on v0.2, which was the first public release of the audit engine plus the capability census and consent contract, genericized policy derivation, and the optimization ledger with verification-first scoring. The full history is in [`Changelog.md`](Changelog.md). Metis also checks this repository on invocation and tells you when a newer release has shipped.

---

## License

Metis is released under the **Creative Commons Attribution-NonCommercial 4.0 International** license (see [`LICENSE`](LICENSE)).

You are free to use, share, and adapt Metis for any **non-commercial** purpose with attribution. Commercial use is not granted by this license. For commercial licensing terms, contact the author directly.

---

## Contributing

Issues and pull requests are welcome. Because Metis is an advisory tool whose value is trust, a substantive change should explain which failure mode it closes and carry a `node --test` case that proves it.
