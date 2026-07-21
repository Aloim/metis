#!/usr/bin/env node
// phanes-context.mjs  --  Metis Phanes-artifact reader (v0.4)
//
// Deterministic, best-effort reader of the Phanes workflow artifacts that tell
// Metis what SHOULD have run, so the audit can reason about CONDITIONAL tool
// use, not just binary "was it ever called". It reads three things:
//
//   1. the orchestrator step threshold (.phanes/config.json), gate for rule 11
//   2. the agent roster (.claude/agents/*.md) and each member's effort tier,
//      plus which member (if any) is the <slug>-orchestrator
//   3. best-effort plan scale from Phanes session-summaries (corroboration only)
//
// All filesystem I/O lives here; adherence.mjs consumes the plain object this
// returns and performs no I/O. Every field degrades gracefully: a missing
// artifact yields a null / empty / zero value, never a throw. Reading these
// artifacts costs no LLM tokens; only the resulting aggregates are surfaced.

import fs from 'node:fs';
import path from 'node:path';

export const EFFORT_LEVELS = ['medium', 'high', 'xhigh'];
export function effortRank(level) {
  const i = EFFORT_LEVELS.indexOf(String(level || '').toLowerCase());
  return i < 0 ? 0 : i + 1; // unknown -> 0, medium 1, high 2, xhigh 3
}

function readJsonSafe(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } }
function listDirSafe(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } }

// Parse a leading frontmatter block (--- ... ---) for simple `key: value`
// scalars. Not a full YAML parser: Phanes agent files use flat scalar keys,
// which is all Metis reads (name, effort).
export function parseFrontmatter(text) {
  const m = String(text).match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (mm) out[mm[1].trim()] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function normEffort(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  return EFFORT_LEVELS.includes(s) ? s : null;
}

// Look for orchestratorStepThreshold at the config root or under a few
// plausible sub-keys, tolerant of where Phanes seeds it.
function readThreshold(cfg, fallback) {
  const candidates = [
    cfg && cfg.orchestratorStepThreshold,
    cfg && cfg.policy && cfg.policy.orchestratorStepThreshold,
    cfg && cfg.workflow && cfg.workflow.orchestratorStepThreshold,
    cfg && cfg.orchestrator && cfg.orchestrator.stepThreshold,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function readBaseline(cfg, fallback) {
  const candidates = [
    cfg && cfg.effortBaseline,
    cfg && cfg.policy && cfg.policy.effortBaseline,
    cfg && cfg.workflow && cfg.workflow.effortBaseline,
  ];
  for (const c of candidates) { const b = normEffort(c); if (b) return b; }
  return fallback;
}

// The agent roster from <project>/.claude/agents/*.md. Each entry:
//   { name, effort (normalized|null), isOrchestrator }
export function readRoster(project) {
  const dir = path.join(project, '.claude', 'agents');
  const roster = [];
  for (const d of listDirSafe(dir)) {
    if (!d.isFile() || !d.name.endsWith('.md')) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, d.name), 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(text);
    const name = (fm.name || d.name.replace(/\.md$/, '')).trim();
    roster.push({
      name,
      effort: normEffort(fm.effort),
      isOrchestrator: /-orchestrator$/i.test(name),
    });
  }
  return roster;
}

// Best-effort plan scale from Phanes session-summaries. Corroboration only:
// returns { summaryCount, maxSteps } where maxSteps is the largest step count
// recovered from any single summary (a `steps_completed` JSON array if present,
// else the count of step subsections). Never load-bearing; zeros on absence.
export function readPlanScale(project) {
  const dir = path.join(project, 'documentation', 'session-summaries');
  const files = listDirSafe(dir)
    .filter(d => d.isFile() && /^SS.*\.md$/i.test(d.name))
    .map(d => d.name)
    .sort()
    .slice(-50); // bound the scan to the 50 most recent by lexical (SS<NNNNN>) order
  let summaryCount = 0, maxSteps = 0;
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    if (text.length > 200000) text = text.slice(0, 200000);
    summaryCount++;
    let steps = 0;
    const arr = text.match(/"steps_completed"\s*:\s*\[([^\]]*)\]/);
    if (arr) {
      const items = arr[1].split(',').map(s => s.trim()).filter(Boolean);
      steps = items.length;
    } else {
      const subs = text.match(/^#{2,4}\s+.*\bstep\b/gim);
      steps = subs ? subs.length : 0;
    }
    if (steps > maxSteps) maxSteps = steps;
  }
  return { summaryCount, maxSteps };
}

// Assemble the full context object consumed by adherence.mjs.
export function buildPhanesContext(project, opts = {}) {
  const root = path.resolve(project);
  const isPhanes = fs.existsSync(path.join(root, '.phanes'));
  const cfg = readJsonSafe(path.join(root, '.phanes', 'config.json')) || {};
  const threshold = readThreshold(cfg, Number.isFinite(opts.defaultThreshold) ? opts.defaultThreshold : 5);
  const baseline = readBaseline(cfg, normEffort(opts.defaultBaseline) || 'high');
  const roster = readRoster(root);
  const orchestrator = roster.find(r => r.isOrchestrator) || null;
  const aboveBaseline = roster.filter(r => r.effort && effortRank(r.effort) > effortRank(baseline));
  const planScale = readPlanScale(root);
  return {
    mode: isPhanes ? 'phanes' : 'standalone',
    threshold,
    baseline,
    roster,
    orchestrator,
    aboveBaseline,
    planScale,
  };
}

// ---------------------------------------------------------------------------
// CLI (inspection aid; the audit engine imports the functions above)
// ---------------------------------------------------------------------------
function runCli(argv) {
  let project = process.cwd(), json = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--project') project = argv[++i];
    else if (t === '--json') json = true;
    else if (t === '-h' || t === '--help') {
      console.log('Metis phanes-context (v0.4)\nUsage: node phanes-context.mjs --project <root> [--json]');
      return 0;
    }
  }
  const ctx = buildPhanesContext(project);
  if (json) { console.log(JSON.stringify(ctx, null, 2)); return 0; }
  console.log(`Phanes context -- ${path.resolve(project)}  [${ctx.mode}]`);
  console.log(`  orchestrator threshold: ${ctx.threshold}`);
  console.log(`  effort baseline:        ${ctx.baseline}`);
  console.log(`  roster members:         ${ctx.roster.length}`);
  console.log(`  orchestrator agent:     ${ctx.orchestrator ? ctx.orchestrator.name : '(none in roster)'}`);
  console.log(`  above-baseline agents:  ${ctx.aboveBaseline.map(a => `${a.name}(${a.effort})`).join(', ') || '(none)'}`);
  console.log(`  session-summaries:      ${ctx.planScale.summaryCount} (largest ${ctx.planScale.maxSteps} steps)`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) process.exit(runCli(process.argv.slice(2)));
