#!/usr/bin/env node
// ledger.mjs  --  Metis optimization ledger + verification-first pass (v0.2)
//
// The ledger is the memory of Metis' bounded autonomy inside Phanes update
// runs. Every change it makes or proposes gets an entry; every run scores the
// open entries against the new sessions BEFORE proposing anything new. This is
// the "no stacking new optimizations on unverified ones" rule made mechanical.
//
// The engine here is deterministic and advisory: it produces verdicts and
// proposals, each tagged with a gate ("autonomous" or "ask-first"). It never
// applies a change and never asks a question. Applying autonomous-whitelist
// edits and asking about structural ones is the /metis command's job.
//
// Ledger file (Phanes mode): <project>/.phanes/audit-ledger.json
//
// Entry schema:
//   { id, date, change, kind, gate, autonomous, status,
//     trigger:{sessions[], metric, value}, expectedBenefit,
//     target:{agent, capability},
//     outcome:{measuredAt, verdict, evidence},
//     cooldownSessions, lastActedSession }

import fs from 'node:fs';
import path from 'node:path';

export const LEDGER_VERSION = '0.2';
export const DEFAULT_MIN_SESSIONS = 3;   // strong-signal floor: "0 uses across >= 3 sessions"
export const DEFAULT_COOLDOWN = 3;       // never touch the same knob twice within N sessions

// Changes Metis may make on its own vs. changes that always ask first.
// Mirrors plan section 5: trigger lines and annotations are autonomous;
// anything structural (merge/remove agents, remove mandates, single-writer)
// asks first, even in integrated mode.
const AUTONOMOUS_KINDS = new Set(['trigger-line', 'annotation', 'flag']);

export function ledgerPathFor(projectPath) {
  return path.join(path.resolve(projectPath), '.phanes', 'audit-ledger.json');
}

export function loadLedger(fp) {
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (j && Array.isArray(j.entries)) return { version: j.version || LEDGER_VERSION, entries: j.entries };
  } catch { /* fall through to empty */ }
  return { version: LEDGER_VERSION, entries: [] };
}

export function saveLedger(fp, ledger) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ version: LEDGER_VERSION, entries: ledger.entries }, null, 2) + '\n', 'utf8');
  return fp;
}

function nextId(ledger) {
  let max = 0;
  for (const e of ledger.entries) {
    const m = /^L(\d+)$/.exec(e.id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'L' + String(max + 1).padStart(3, '0');
}

// Append an entry, filling defaults. `outcome.verdict` starts null (unmeasured).
export function addEntry(ledger, entry, opts = {}) {
  const gate = entry.gate || (AUTONOMOUS_KINDS.has(entry.kind) ? 'autonomous' : 'ask-first');
  const e = {
    id: nextId(ledger),
    date: entry.date || opts.date || new Date().toISOString().slice(0, 10),
    change: entry.change || '',
    kind: entry.kind || 'annotation',
    gate,
    autonomous: gate === 'autonomous',
    status: entry.status || (gate === 'autonomous' ? 'applied' : 'proposed'),
    trigger: entry.trigger || { sessions: [], metric: '', value: null },
    expectedBenefit: entry.expectedBenefit || '',
    target: entry.target || { agent: null, capability: null },
    outcome: entry.outcome || { measuredAt: null, verdict: null, evidence: null },
    cooldownSessions: entry.cooldownSessions != null ? entry.cooldownSessions : (opts.cooldown ?? DEFAULT_COOLDOWN),
    lastActedSession: entry.lastActedSession || opts.lastActedSession || null,
  };
  ledger.entries.push(e);
  return e;
}

// ---------------------------------------------------------------------------
// Reading usage out of an audit report (the JSON that session-audit.mjs writes)
// ---------------------------------------------------------------------------
// Returns { serverLower -> { calls, sessions:Set<sessionId> } } across main
// sessions AND subagents (a subagent's calls count for its parent session).
export function serverUsage(auditJson) {
  const usage = {};
  const bump = (server, sessionId, calls) => {
    const k = String(server).toLowerCase();
    (usage[k] ||= { calls: 0, sessions: new Set() });
    usage[k].calls += calls;
    if (sessionId) usage[k].sessions.add(sessionId);
  };
  for (const s of auditJson.sessions || []) {
    for (const [srv, tools] of Object.entries(s.mcpByServer || {})) {
      bump(srv, s.id, Object.values(tools).reduce((a, b) => a + b, 0));
    }
  }
  for (const a of auditJson.agents || []) {
    for (const [srv, tools] of Object.entries(a.mcpByServer || {})) {
      bump(srv, a.parentSession || a.id, Object.values(tools).reduce((a2, b) => a2 + b, 0));
    }
  }
  return usage;
}

// Count of distinct main sessions in the audit window (the sample size that
// decides whether a signal is "strong" and whether a change is measurable yet).
export function windowSize(auditJson) {
  return (auditJson.sessions || []).length;
}

// Aggregate error/retry proxy across the window (a QUALITY PROXY, never a
// quality claim: token spend is measured, quality only proxied).
function errorProxy(auditJson) {
  let errors = 0, results = 0;
  for (const a of [...(auditJson.sessions || []), ...(auditJson.agents || [])]) {
    errors += a.toolResultErrors || 0;
    results += a.toolResults || 0;
  }
  return { errors, results, rate: results ? errors / results : 0 };
}

// ---------------------------------------------------------------------------
// Verification-first: score every open entry against the new audit
// ---------------------------------------------------------------------------
// An entry whose intent is "make capability C get used" is:
//   delivered            if C now shows usage in the window,
//   regressed            if C is still unused AND the window is large enough to
//                        have shown it (and, for flags, the condition persists),
//   not-yet-measurable   if the window is too small to judge yet.
// Entries without a capability target (pure annotations) are scored only for
// measurability + the error proxy, and default to not-yet-measurable.
export function verify(ledger, auditJson, opts = {}) {
  const minSessions = opts.minSessions ?? DEFAULT_MIN_SESSIONS;
  const usage = serverUsage(auditJson);
  const n = windowSize(auditJson);
  const proxy = errorProxy(auditJson);
  const results = [];
  for (const e of ledger.entries) {
    if (e.status === 'rolled-back' || e.status === 'superseded') continue;
    if (e.outcome && e.outcome.verdict === 'delivered') continue; // settled
    const cap = e.target && e.target.capability;
    let verdict, evidence, rollback = false;
    if (cap) {
      const u = usage[String(cap).toLowerCase()];
      const calls = u ? u.calls : 0;
      if (calls > 0) {
        verdict = 'delivered';
        evidence = `${cap} used ${calls} time(s) across ${u.sessions.size} session(s) since the change`;
      } else if (n >= minSessions) {
        verdict = 'regressed';
        evidence = `${cap} still 0 uses across ${n} session(s) after the change; the change did not move the metric`;
        rollback = true;
      } else {
        verdict = 'not-yet-measurable';
        evidence = `only ${n} session(s) in window (need >= ${minSessions})`;
      }
    } else {
      verdict = 'not-yet-measurable';
      evidence = n >= minSessions
        ? `no capability target to measure; error proxy = ${proxy.errors}/${proxy.results}`
        : `only ${n} session(s) in window (need >= ${minSessions})`;
    }
    results.push({ id: e.id, kind: e.kind, gate: e.gate, verdict, evidence, rollbackProposed: rollback, change: e.change });
  }
  return { window: n, errorProxy: proxy, scored: results,
    regressed: results.filter(r => r.verdict === 'regressed'),
    delivered: results.filter(r => r.verdict === 'delivered') };
}

// ---------------------------------------------------------------------------
// Candidate proposals: strong signals only, cooldown respected
// ---------------------------------------------------------------------------
// Given the audit + the derived policy + the current ledger, propose new
// changes. Only strong signals pass (reachable + 0 uses across >= minSessions).
// Cooldown: skip any target that a ledger entry acted on within the last
// cooldownSessions of the window. Each proposal is gated autonomous vs ask-first.
export function candidateProposals(auditJson, policy, ledger, opts = {}) {
  const minSessions = opts.minSessions ?? DEFAULT_MIN_SESSIONS;
  const cooldown = opts.cooldown ?? DEFAULT_COOLDOWN;
  const usage = serverUsage(auditJson);
  const n = windowSize(auditJson);
  const proposals = [];
  if (n < minSessions) return { window: n, proposals, note: `window too small (${n} < ${minSessions}) for strong signals` };

  // Targets recently acted on (any non-rolled-back entry within cooldown).
  const recentlyActed = new Set();
  for (const e of ledger.entries) {
    if (e.status === 'rolled-back') continue;
    if (e.target && e.target.capability) recentlyActed.add(String(e.target.capability).toLowerCase());
  }

  const granted = new Set((policy.grantedServers || []).map(s => s.toLowerCase()));
  const configured = new Set((policy.configuredMcpServers || []).map(s => s.toLowerCase()));

  // 1) Granted/configured + reachable + 0 uses across the window -> strengthen
  //    the usage trigger (autonomous). The ask-first alternative (remove the
  //    mandate) is surfaced but never auto-applied.
  for (const srv of new Set([...granted, ...configured])) {
    const calls = usage[srv] ? usage[srv].calls : 0;
    if (calls > 0) continue;
    if (recentlyActed.has(srv)) continue; // cooldown
    const isGranted = granted.has(srv);
    proposals.push({
      kind: 'trigger-line', gate: 'autonomous',
      target: { agent: null, capability: srv },
      change: `Strengthen the usage-trigger line for "${srv}" (granted/configured but 0 uses across ${n} sessions).`,
      trigger: { sessions: [], metric: `reachable + 0 uses across ${n} sessions`, value: 0 },
      expectedBenefit: 'convert an unused, consented capability into actual use, or expose that the mandate is wrong',
      alternative: isGranted
        ? { kind: 'mandate-removal', gate: 'ask-first', change: `If still unused next run, remove the "${srv}" mandate (ask first).` }
        : null,
    });
  }

  // 2) Selected/mandated but unreachable (authOk false) -> flag it (autonomous
  //    per the whitelist: "flagging an unauthenticated-but-mandated server").
  for (const s of (policy._selection || [])) {
    if (s.type === 'mcp' && s.selected && s.authOk === false && !recentlyActed.has(s.name.toLowerCase())) {
      proposals.push({
        kind: 'flag', gate: 'autonomous',
        target: { agent: null, capability: s.name },
        change: `Flag: "${s.name}" is selected/mandated but unreachable (authOk=false). Authenticate or record a deliberate degradation.`,
        trigger: { sessions: [], metric: 'selected + authOk=false', value: null },
        expectedBenefit: 'close the mandate-vs-reachability contradiction at its root',
        alternative: null,
      });
    }
  }

  return { window: n, cooldown, proposals };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function readJsonSafe(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } }

async function runCli(argv) {
  let project = process.cwd(), auditPath = null, doVerify = false, doPropose = false, json = false, help = false, addJson = null;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--project') project = argv[++i];
    else if (t === '--audit') auditPath = argv[++i];
    else if (t === '--verify') doVerify = true;
    else if (t === '--propose') doPropose = true;
    else if (t === '--add') addJson = argv[++i];
    else if (t === '--json') json = true;
    else if (t === '-h' || t === '--help') help = true;
  }
  if (help) {
    console.log(`Metis optimization ledger (v0.2)
Usage:
  node ledger.mjs --project <root> --audit <report.json> --verify [--json]
  node ledger.mjs --project <root> --audit <report.json> --propose [--json]
  node ledger.mjs --project <root> --add '<entry-json>'

  --verify   Score open ledger entries against the audit (verification-first).
  --propose  List strong-signal candidate proposals (cooldown respected).
  --add      Append an entry (JSON) to the ledger and save.`);
    return 0;
  }
  const fp = ledgerPathFor(project);
  const ledger = loadLedger(fp);

  if (addJson) {
    let entry; try { entry = JSON.parse(addJson); } catch (e) { console.error('[error] --add expects JSON:', e.message); return 1; }
    const added = addEntry(ledger, entry);
    saveLedger(fp, ledger);
    console.log(json ? JSON.stringify(added, null, 2) : `[ledger] added ${added.id} (${added.gate}) -> ${fp}`);
    return 0;
  }

  const audit = auditPath ? readJsonSafe(auditPath) : null;
  if ((doVerify || doPropose) && !audit) { console.error('[error] --verify/--propose need a readable --audit <report.json>'); return 1; }

  const out = { ledgerPath: fp, entries: ledger.entries.length };
  if (doVerify) out.verify = verify(ledger, audit);
  if (doPropose) {
    // Best effort: derive policy for proposal signals if available.
    let policy = {};
    try { const { derivePolicy } = await importPolicy(); policy = derivePolicy(project); } catch { /* optional */ }
    out.propose = candidateProposals(audit, policy, ledger);
  }
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

// Lazy import so the ledger has no hard dependency on policy.mjs for its core.
async function importPolicy() { return import('./policy.mjs'); }

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  runCli(process.argv.slice(2)).then(code => process.exit(code)).catch(e => { console.error('[fatal]', e); process.exit(1); });
}
