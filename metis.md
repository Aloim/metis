<!-- Metis v0.3.0, 2026-07-20, self-bootstrapping session-audit companion for Claude Code.
     ONE FILE to install: copy this metis.md to ~/.claude/commands/metis.md (global) or
     <project>/.claude/commands/metis.md (per project), then run /metis. On the first run it asks
     the install scope, fetches its own engine into a folder, and keeps a per-project run counter.
     First run = install + optimization. Every later run = update check + optimization.
     ADVISORY-FIRST: the engine is deterministic Node; changes are applied only on the user's yes,
     except a narrow autonomous whitelist inside a Phanes update run, which is logged.
     Metis never runs unbidden: this command acts only when the user invokes /metis. -->

# Metis

Audit whether this Claude Code setup actually uses the toolset it is configured with, then propose evidence-based optimizations. The ground truth is the transcript, never the console. Like Phanes, Metis is one file you install: this command bootstraps its own engine on the first run.

**YOU MUST** let `$ARGUMENTS` steer the run when provided (for example a specific `--project`, `reinstall`, `update`, or "verify only").

Constants for this version:

- Repo: `Aloim/metis`. Raw base: `https://raw.githubusercontent.com/Aloim/metis/main`.
- Engine files (fetched into the engine directory): `metis.mjs`, `census.mjs`, `policy.mjs`, `ledger.mjs`, `session-audit.mjs`, `version.mjs`, `policy.json`, each from `<raw-base>/src/<file>`.
- This command's version stamp is on line 1 (`Metis vX.Y.Z`).

## Step 0: Self-refresh (this command)

Fetch `<raw-base>/metis.md` and read its line-1 version stamp. If it is newer than this file's stamp, overwrite the installed command file you were invoked from (`~/.claude/commands/metis.md` for a global install, `<project>/.claude/commands/metis.md` for a per-project install), tell the user Metis refreshed itself and to run `/metis` again, and **stop**. This mirrors the Phanes pre-flight and guarantees no run executes a stale command. The fetch is best effort: on a network failure, note it and continue with the current file.

## Step 1: Resolve the install (scope, engine, run counter)

Detect the platform first (PowerShell on Windows, bash on POSIX) and run the matching commands.

1. **Find an existing engine.** If `<project>/metis/metis.mjs` exists, the scope is **project** and the engine directory is `<project>/metis`. Else if `~/.claude/metis/metis.mjs` exists (`$env:USERPROFILE\.claude\metis` on Windows), the scope is **global** and the engine directory is that folder. Else there is no install yet: go to step 2.
2. **First install (no engine found): ask the scope.** Ask **one** `AskUserQuestion` (single select):
   - **All my projects (global, recommended):** engine installed once at `~/.claude/metis/`; each project keeps its own audit state under `<project>/.metis/`. Pick this when the command lives at `~/.claude/commands/metis.md`.
   - **Just this project:** engine and state both under `<project>/metis/`. Pick this when the command lives at `<project>/.claude/commands/metis.md`.
   Non-interactive run: default to **global**, record that it was unattended, and continue.
3. **Fetch the engine** into the engine directory (create it first). Fetch each engine file from `<raw-base>/src/<file>`:
   - POSIX: `for f in metis.mjs census.mjs policy.mjs ledger.mjs session-audit.mjs version.mjs policy.json; do curl -fsSL "<raw-base>/src/$f" -o "<engineDir>/$f"; done`
   - PowerShell: `foreach ($f in 'metis.mjs','census.mjs','policy.mjs','ledger.mjs','session-audit.mjs','version.mjs','policy.json') { Invoke-WebRequest "<raw-base>/src/$f" -OutFile "<engineDir>\$f" }`
   If the fetch fails, stop and tell the user to check connectivity; do not fabricate an engine.

**State directory and artifact rules:**
- **Global scope:** per-project state lives at `<project>/.metis/`. The global engine is shared; every project separates its own state, reports, and standalone manifest there.
- **Project scope:** state lives at `<project>/metis/` alongside the engine; no cross-project separation is needed because the install is already local to the project.
- **Phanes mode (either scope):** the capability manifest is always `<project>/.phanes/config.json` and the ledger is always `<project>/.phanes/audit-ledger.json`, per the Phanes contract. Only Metis's own run state and standalone artifacts use the state directory above.

Read `<stateDir>/state.json` if present: `{ version, installScope, engineDir, runCount, lastRun }`.

## Step 2: First run versus later run

- **First run for this project** (`state.json` absent, or `runCount` is 0): this is **install + optimization**. Ensure the engine is present (fetch in Step 1 if it was missing), then run the optimization pass (Step 4). Afterwards write `state.json` with `runCount` 1.
- **Later run** (`runCount` >= 1): this is **update check + optimization**. Do Step 3, then Step 4, then increment `runCount` and update `lastRun`.

## Step 3: Update check (later runs)

Run `node <engineDir>/metis.mjs version --check`. If it reports a newer release, re-fetch the engine files (Step 1.3) so the engine matches the current command, and say so. Best effort; never block the run on it.

## Step 4: The optimization pass

Invoke the engine as `node <engineDir>/metis.mjs <command>`. Always pass `--project <project>` so the policy and transcript directory are derived correctly, and pass `--out <stateDir>/reports` to the audit so reports never leak into the engine folder or another project.

1. **Detect and gate.** `node <engineDir>/metis.mjs detect --project <project> --json`.
   - If `update.updateAvailable` is true, surface it once (best effort; if `update.ok` is false, say nothing about updates).
   - If `optimizability.stop` is true, **STOP**: report the message and reasons verbatim and end. There is nothing to optimize (no MCP servers, plugins, skills, or agents). Do not fabricate findings.
   - If `transcriptDirExists` is false, there are no sessions to audit yet: you may still record a consented selection, but tell the user the audit is skipped until sessions exist, and skip the audit and ledger steps.

2. **Census and consent (per item, once per project).** `node <engineDir>/metis.mjs census --project <project> --json`; read `detected`, `prior`, `diff`.
   - **A Phanes project with a prior selection** (`mode` is `phanes` and `prior` is non-empty): Phanes owns the consent gate. Do **NOT** re-ask. If `diff.hasDelta` is false, say nothing; if there is a delta, ask **only** about the delta.
   - **Otherwise** (standalone, or a Phanes project with no selection yet): ask **one** `AskUserQuestion` (multiSelect) listing **every** detected capability by its detected name. On a Phanes project the standard set (`context7`, `deepwiki`, `serena`, `semble`, `frontend-design`) is pre-selected and marked "(Recommended)"; on a standalone project nothing is pre-selected. Never hardcode an external tool name; a name appears only because detection found it. State the schema tax (roughly 1,000 tokens per MCP tool per session). A server with `authOk` false or unknown cannot be mandated even if selected.
   - Persist: `node <engineDir>/metis.mjs census --project <project> --set-selection <comma,names>`.
   - Non-interactive: on a Phanes project default to the standard set, standalone select nothing, record the default, and continue.

3. **Audit.** Skip if there is no transcript directory. `node <engineDir>/metis.mjs audit --project <project> --harvest <stateDir>/archive --out <stateDir>/reports --last <N>`. Harvest first, because the subagent task store is volatile. Read the JSON report and report in plain language: capabilities configured or granted but never called, servers mandated but unreachable, the split of spend between main session and subagents, and any redacted secret findings.

4. **Verify then propose (Phanes mode only).** First `node <engineDir>/metis.mjs ledger --project <project> --audit <report.json> --verify`: report each open entry's verdict (delivered, not-yet-measurable, regressed); a regression is an **ask-first** rollback proposal. Only then `--propose`: apply `autonomous`-gated items (trigger line, annotation, flag) and log each with `ledger ... --add '<entry-json>'`; present `ask-first` items (mandate removal, agent merge or removal, single-writer change) and apply only on the user's yes. The engine already respects the cooldown.

5. **The checklist.** Present findings and proposals as a per-item checklist, most-evidenced first, each with its evidence, its proposed change, and its gate. Apply nothing outside the autonomous whitelist without an explicit yes. Quality signals (error and retry rates) are proxies and are marked as proxies; token spend is the only thing measured directly.

## Step 5: Record the run

Write `<stateDir>/state.json`: `{ "version": <this version>, "installScope": <global|project>, "engineDir": <abs path>, "runCount": <incremented>, "lastRun": <date> }`. Create the state directory if needed.

## Constraints (hard)

- **Advisory-first.** Propose; the user disposes. The only self-applied changes are the autonomous whitelist inside a Phanes update run, and each is logged.
- **No external tool playbooks.** Metis ships knowledge of exactly one named set, the Phanes standard tools, and only on a Phanes project. Every other capability is discovered and reasoned about generically.
- **Redacted always.** Secret findings show location, pattern type, and a masked value only.
- **First-run note.** On a Phanes project whose only sessions are its setup run, the audit sample is not steady-state work; say so and defer strong conclusions to the next update run.
- New prose here and in anything you write stays free of em and en dashes and dash-as-punctuation.
