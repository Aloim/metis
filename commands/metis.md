<!-- Metis v0.2, 2026-07-20, standalone session-audit and optimization prompt for Claude Code.
     Install to ~/.claude/commands/metis.md (user scope) or <project>/.claude/commands/metis.md (project scope).
     Standalone: works in any Claude Code project. Phanes-aware: reads an existing .phanes/ selection instead of re-asking.
     ADVISORY-FIRST: the engine is deterministic Node; every change is proposed and applied only on the user's yes,
     except the narrow autonomous whitelist inside a Phanes update run, which is logged to the ledger.
     Metis never runs unbidden: this command only acts when the user invokes /metis. -->

# Metis

Audit whether this Claude Code setup actually uses the toolset it is configured with, then propose evidence-based optimizations. The ground truth is the transcript, never the console. You interpret the deterministic engine's output; you do not re-derive its numbers by hand.

**YOU MUST** let `$ARGUMENTS` steer the run when provided (for example a specific `--project` path, `--last N`, or "verify only").

Run every command below from the project root. The engine lives alongside this repo's `metis.mjs`; call it as `node <metis-dir>/metis.mjs <subcommand>`.

## Step 0: Detect and gate

Run `node metis.mjs detect --project . --json` and read the result.

- If `update.updateAvailable` is true, surface it once at the top: a newer Metis is on `github.com/Aloim/metis`, with the version numbers. This is a best-effort check that never blocks the run; if `update.ok` is false, say nothing about updates.
- If `optimizability.stop` is true, **STOP**. Report the `message` and the `reasons` verbatim, and end the run. There is nothing here to optimize (no MCP servers, plugins, skills, or agents). Do not fabricate findings.
- Note `mode` (`standalone` or `phanes`) and `transcriptDirExists`. These decide the rest of the flow.
- If `transcriptDirExists` is false, there are no sessions to audit yet. Continue to the census (you can still record a consented selection), but tell the user the adherence audit is skipped until sessions exist, and skip Step 2 and Step 3.

## Step 1: Census and consent (per item, once per project)

Run `node metis.mjs census --project . --json` and read `detected`, `prior`, and `diff`.

Consent ownership, so the user is never asked twice:

- **A Phanes project with a prior selection already present** (`mode` is `phanes` and `prior` is non-empty): Phanes owns the consent gate. Do **NOT** re-ask the full question. If `diff.hasDelta` is false, say nothing and move on. If there is a delta, ask **only** about the delta (a capability that appeared, disappeared, or changed auth status), then persist.
- **Otherwise** (standalone project, or a Phanes project that has no selection yet): ask **one** `AskUserQuestion` (multiSelect) listing **every** detected capability by its detected name:
  + On a Phanes project, the Phanes-standard MCP servers (`context7`, `deepwiki`, `serena`, `semble`, `frontend-design`) appear **pre-selected** and marked **"(Recommended)"**. On a standalone project nothing is pre-selected and nothing is assumed.
  + Every other detected capability appears **unchecked**, by its detected name only. Never hardcode an external tool name into the question; a name appears solely because detection found it.
  + State the schema tax with the list: each connected MCP server costs roughly 1,000 tokens per tool per session whether used or not, so eligibility is not free.
  + An MCP server whose `authOk` is `false` or `unknown` cannot be mandated even if selected; say so next to it.

Persist the user's answer: `node metis.mjs census --project . --set-selection <comma,separated,names>`. On a Phanes project this writes `.phanes/config.json`; standalone it writes `.metis/config.json`. Both share the same schema so the next run can diff.

If the run is non-interactive (no user is present to answer), do **not** block: on a Phanes project default to the standard set, on a standalone project select nothing, record that the default was unattended, and continue.

## Step 2: Audit the transcripts

Skip this step if Step 0 reported no transcript directory.

Run `node metis.mjs audit --project . --harvest <durable-archive-dir> --last <N>`. Harvest first because the subagent task store is volatile; a subagent's internal MCP use exists only there. Read the JSON report it writes under `reports/`.

Report, in plain language: which configured or granted capabilities were never called, which servers are mandated but unreachable, how spend splits between the main session and subagents, and any redacted secret findings. Every number comes from the report; do not invent.

## Step 3: Verification-first, then propose (Phanes mode only)

Skip this step in standalone mode; standalone is advisory reporting plus the checklist in Step 4.

1. **Verify before proposing.** Run `node metis.mjs ledger --project . --audit <report.json> --verify`. For each open ledger entry, report its verdict: `delivered`, `not-yet-measurable`, or `regressed`. A `regressed` entry produces a **rollback proposal**, which is **ask-first**: never roll back silently. Do not propose anything new until this pass is done.
2. **Propose from strong signals only.** Run `node metis.mjs ledger --project . --audit <report.json> --propose`. Each proposal carries a `gate`:
   - `autonomous` (trigger-line, annotation, flag): you may apply it, but you **MUST** log it to the ledger with `node metis.mjs ledger --project . --add '<entry-json>'` (date, change, trigger evidence, expected benefit, outcome null). These are limited to adding or adjusting a usage-trigger line in an agent persona, annotating a model or effort suggestion, and flagging an unauthenticated-but-mandated server.
   - `ask-first` (mandate removal, agent merge or removal, single-writer reassignment, anything structural): present it, apply only on the user's yes, then log it.
3. Respect the cooldown: the engine already suppresses a knob it touched within the cooldown window. Do not override that by hand.

## Step 4: The optimization checklist

Present findings and proposals as a **per-item checklist**, most-evidenced first. For each item: the evidence (which sessions, which metric), the proposed change, and its gate. Apply nothing outside the autonomous whitelist without an explicit yes. Quality signals (error and retry rates) are **proxies**, never quality claims; token spend is the only thing measured directly. Mark proxies as proxies.

## Constraints (hard)

- **Advisory-first.** Propose; the user disposes. The only self-applied changes are the autonomous whitelist inside a Phanes update run, and each is logged.
- **No external tool playbooks.** Metis ships knowledge of exactly one named set, the Phanes standard tools, and only on a Phanes project. Every other capability is discovered and reasoned about generically from its own schema, transcript evidence, and roster domain matching. Never assume what an external tool is for.
- **Redacted always.** Secret findings show location, pattern type, and a masked value only. Never echo a raw secret.
- **First-run note.** On a Phanes project whose only sessions are its setup run, the audit sample is not steady-state agent work; say so and defer strong conclusions to the next update run.
- New prose here and in anything you write stays free of em and en dashes and dash-as-punctuation.
