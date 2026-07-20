#!/usr/bin/env node
// metis.mjs  --  Metis dispatcher / single entry CLI (v0.2)
//
// One command surface over the deterministic engine pieces. This is also the
// "Metis CLI on PATH" that a Phanes capability census can recognize as the
// companion (alongside the /metis slash command).
//
//   node metis.mjs detect  --project <root>            mode + companion + optimizability
//   node metis.mjs census  --project <root> [--json] [--set-selection a,b]
//   node metis.mjs audit   --project <root> [session-audit flags]   (derives --dir)
//   node metis.mjs ledger  --project <root> [ledger flags]
//
// detect uses the engine library directly; census/audit/ledger delegate to
// their own scripts so each stays independently runnable and testable. audit
// fills in --dir from the project's encoded transcript directory when omitted.

import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { census, detectMode, transcriptDirFor } from './census.mjs';
import { checkForUpdate, localVersion, METIS_REPO } from './version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function getFlag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}
function hasFlag(argv, name) { return argv.includes(name); }

// A /metis command file installed on this machine is the companion signal
// (mirror of what Phanes' census looks for). Checked at user and project scope.
function metisCommandPresent(projectPath) {
  const home = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'commands', 'metis.md');
  const proj = path.join(projectPath, '.claude', 'commands', 'metis.md');
  return fs.existsSync(home) || fs.existsSync(proj);
}

function delegate(script, argv) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...argv], { stdio: 'inherit' });
  return r.status == null ? 1 : r.status;
}

async function detect(argv) {
  const project = path.resolve(getFlag(argv, '--project') || process.cwd());
  const mode = detectMode(project);
  const tdir = transcriptDirFor(project);
  const result = census(project, { mode, probe: false });
  // Self-update check (best effort, both modes). --no-update-check skips it.
  const update = hasFlag(argv, '--no-update-check') ? { ok: false, reason: 'skipped', current: localVersion() } : await checkForUpdate();
  const payload = {
    project,
    mode,
    version: localVersion(),
    update,
    companion: { metisCommand: metisCommandPresent(project) },
    transcriptDir: tdir,
    transcriptDirExists: fs.existsSync(tdir),
    optimizability: result.optimizability,
    // First-run guidance for a Phanes project: the audit needs steady-state
    // sessions, which do not exist until agents have run. See README sequencing.
    guidance: mode === 'phanes'
      ? 'Phanes-integrated: read .phanes/config.json for the consented selection; do NOT re-ask consent. Run the audit only on update runs (after agents have produced sessions).'
      : 'Standalone: run census + consent, then audit. Nothing runs unbidden.',
  };
  if (hasFlag(argv, '--json')) { console.log(JSON.stringify(payload, null, 2)); return 0; }
  console.log(`Metis detect -- ${project}`);
  console.log(`  version:           ${payload.version}${update.ok && update.updateAvailable ? '  (update available: ' + update.latest + ')' : update.ok ? '  (up to date)' : ''}`);
  console.log(`  mode:              ${mode}`);
  console.log(`  /metis command:    ${payload.companion.metisCommand ? 'present' : 'absent'}`);
  console.log(`  transcript dir:    ${tdir}${payload.transcriptDirExists ? '' : ' (not found)'}`);
  console.log(`  optimizable:       ${result.optimizability.optimizable}${result.optimizability.stop ? '  STOP: ' + result.optimizability.message : ''}`);
  console.log(`  counts:            ${JSON.stringify(result.optimizability.counts)}`);
  console.log(`  guidance:          ${payload.guidance}`);
  return 0;
}

// audit: derive --dir from --project when the caller did not pass one.
function audit(argv) {
  const project = getFlag(argv, '--project');
  let passthrough = [...argv];
  if (project && !hasFlag(argv, '--dir')) {
    const tdir = transcriptDirFor(path.resolve(project));
    if (!fs.existsSync(tdir)) {
      console.error(`[metis] no transcript dir for ${project} (looked at ${tdir}). Nothing to audit yet.`);
      return 2;
    }
    passthrough = ['--dir', tdir, ...passthrough];
  }
  return delegate('session-audit.mjs', passthrough);
}

function help() {
  console.log(`Metis v0.2 -- companion session auditor for Claude Code setups

Usage:
  node metis.mjs detect  --project <root> [--json]
  node metis.mjs census  --project <root> [--json] [--set-selection a,b,...]
  node metis.mjs audit   --project <root> [--last N] [--harvest <dir>] [--no-tasks]
  node metis.mjs ledger  --project <root> --audit <report.json> [--verify|--propose]
  node metis.mjs version [--check]

detect  reports mode (phanes|standalone), companion presence, the self-update
        check, and whether there is anything to optimize (early stop when not).
census  detects capabilities, proposes a per-item selection, diffs vs the prior
        manifest, and (with --set-selection) persists the consented selection.
audit   runs the deterministic transcript audit; --dir is derived from --project.
ledger  verification-first scoring and strong-signal proposals (Phanes mode).

The consent QUESTION and the optimization checklist are driven by the /metis
command (Claude side); this CLI only does the deterministic work.`);
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'detect':  return await detect(rest);
    case 'census':  return delegate('census.mjs', rest);
    case 'audit':   return audit(rest);
    case 'ledger':  return delegate('ledger.mjs', rest);
    case 'version': return delegate('version.mjs', rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':    return help();
    default:
      console.error(`[metis] unknown command: ${cmd}`);
      help();
      return 1;
  }
}

main().then(code => process.exit(code)).catch(e => { console.error('[fatal]', e); process.exit(1); });
