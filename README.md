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

Every run walks the same path. Each step is a deterministic Node command; you interpret its output.

**1. Detect and gate.** Metis works out whether the project is standalone or Phanes-managed, whether a transcript directory exists, and whether there is anything to optimize at all. A setup with no MCP servers, no plugins, no skills, and no agents has nothing to build policy around, so Metis stops and says so rather than emitting an empty report. It also self-checks this repository for a newer release and surfaces the notice when one has shipped.

**2. Census and consent.** It enumerates every installed capability, the MCP servers, plugins, skills, slash commands, and foreign agents, and probes each MCP server to see whether it is actually reachable and authenticated rather than merely configured. It then proposes a per-item selection. On a Phanes project the standard set (`context7`, `deepwiki`, `serena`, `semble`, `frontend-design`) is pre-selected and marked recommended; on a standalone project nothing is assumed and every item is listed unchecked by its detected name. Your selection persists, so the next run stays silent unless the set actually changes, and then it asks only about what changed. A server that is switched off or signed out can never be mandated, even if selected.

**3. Audit the transcripts.** It streams the main-session JSONL and the volatile subagent task transcripts (harvesting them first, because the harness discards them). It aggregates, per session and per agent: tool use by name (MCP split into server and tool), models, tokens, spawns, and errors. Then it diffs actual usage against the policy: a tool that was mandated but never called, a server that was configured but never used, an agent that was never spawned. It runs a redacted secret scan over commands and tool results, and summarizes where the tokens went. A subagent's internal MCP use is invisible in the parent session; recovering it from the task store is the whole point.

**4. Verify, then propose (Phanes mode).** Before proposing anything new, Metis scores its open ledger entries against the new sessions: delivered, not-yet-measurable, or regressed. A regression produces a rollback proposal. Only then does it propose new changes, and only from strong signals, with a cooldown so it never oscillates on the same knob. Each proposal is gated. Trigger lines, annotations, and flags may be applied and logged; merging or removing agents, removing mandates, and single-writer reassignments always ask first.

**5. The checklist.** Findings and proposals are presented as a per-item checklist, most-evidenced first, each with its evidence, its proposed change, and its gate. Nothing outside the autonomous whitelist is applied without your yes. Quality signals such as error and retry rates are proxies and are marked as proxies; token spend is the only thing measured directly.

## How to use

Metis has one entry point, the `metis.mjs` dispatcher. Run any command from your project root.

| Command | What it does |
| --- | --- |
| `node metis.mjs detect --project .` | Mode, companion presence, the update check, and whether there is anything to optimize (an early stop when not). |
| `node metis.mjs census --project .` | Detect capabilities, propose a per-item selection, diff against the prior manifest. `--set-selection a,b` persists the consented selection. |
| `node metis.mjs audit --project . --harvest <dir> --last N` | Run the transcript audit. `--dir` is derived from `--project`; `--harvest` preserves the volatile task store first. |
| `node metis.mjs ledger --project . --audit <report.json> --verify` | Verification-first scoring of the ledger (Phanes mode). `--propose` lists strong-signal proposals. |
| `node metis.mjs version --check` | Print the version and check the repository for a newer release. |

The `/metis` slash command is the interactive front end: it runs these, asks the consent question through the harness, and presents the checklist. It never runs unbidden.

Each piece also runs on its own (`node census.mjs`, `node session-audit.mjs`, `node ledger.mjs`, `node policy.mjs`, `node version.mjs`), and `node --test` runs the suite.

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

Metis is a small Node tool plus one slash command. It needs [Claude Code](https://claude.com/claude-code) and Node 18 or newer; it has no other dependencies.

### 1. Clone the repository

```bash
git clone https://github.com/Aloim/metis
```

### 2. Run it

From any project you want to audit:

```bash
node /path/to/metis/metis.mjs detect --project .
```

That reports what Metis sees and whether there is anything to optimize. From there, `census`, `audit`, and (on a Phanes project) `ledger` do the rest.

### 3. Optional: install the `/metis` slash command

Copy the command source so Claude Code exposes `/metis`:

**Linux / macOS:**

```bash
mkdir -p ~/.claude/commands
cp /path/to/metis/commands/metis.md ~/.claude/commands/metis.md
```

**Windows (PowerShell):**

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\commands" | Out-Null
Copy-Item /path/to/metis/commands/metis.md "$env:USERPROFILE\.claude\commands\metis.md"
```

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

Current: **v0.2** (2026-07-20). First public release: the audit engine plus the capability census and consent contract, genericized policy derivation, the optimization ledger with verification-first scoring, the `/metis` command, the single dispatcher, and a self-update check against this repository. The full history is in [`Changelog.md`](Changelog.md). Metis also checks this repository on invocation and tells you when a newer release has shipped.

---

## License

Metis is released under the **Creative Commons Attribution-NonCommercial 4.0 International** license (see [`LICENSE`](LICENSE)).

You are free to use, share, and adapt Metis for any **non-commercial** purpose with attribution. Commercial use is not granted by this license. For commercial licensing terms, contact the author directly.

---

## Contributing

Issues and pull requests are welcome. Because Metis is an advisory tool whose value is trust, a substantive change should explain which failure mode it closes and carry a `node --test` case that proves it.
