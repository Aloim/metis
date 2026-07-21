#!/usr/bin/env node
// adherence.mjs  --  Metis condition-aware adherence checks (v0.4)
//
// Pure functions, NO I/O. Given the audited transcript aggregates, the Phanes
// context (roster, thresholds, effort baseline), and the policy, decide whether
// two CONDITIONAL Phanes tools were used when their precondition was present:
//
//   * the effort bridge (per-agent CLI effort lift, Phanes v3.2): an
//     above-baseline archetype that runs in-session rides the session baseline;
//     to deliver its higher rubric it must be CLI-spawned with --effort. Absence
//     of that lift when an above-baseline archetype ran in-session is the
//     "under-lift" miss (the live v3.1 finding). Using it downward (at or below
//     baseline) wastes the process entry tax.
//
//   * the orchestrator (slim-session plan execution, Phanes v3.2, rule 11): a
//     plan at or above the step threshold should be delegated to the
//     <slug>-orchestrator so the primary session stays slim. Self-orchestrating
//     a plan of that scale, or engaging the orchestrator for a sub-threshold
//     task, are the two mismatches.
//
// Every finding is ADVISORY and states the precondition it detected plus the
// observable evidence. When the precondition is absent (baseline already xhigh,
// no above-baseline archetype, no orchestrator in the roster, no plan-scale
// session), the check reports applicable:false and emits nothing. Tools are not
// always meant to be used; a silent check is the correct output for "there was
// nothing here that called for this tool".

import { effortRank } from './phanes-context.mjs';

const ORCH_RE = /-orchestrator$/i;

function spawnCount(agg, pred) {
  let n = 0;
  for (const [type, c] of Object.entries(agg.spawnedAgentTypes || {})) {
    if (pred(type)) n += c;
  }
  return n;
}

// -------------------------------------------------------------------------
// Effort-bridge adherence
// -------------------------------------------------------------------------
export function effortBridgeAdherence(actors, phanes) {
  const baseline = phanes.baseline || 'high';
  const aboveBaseline = phanes.aboveBaseline || [];

  if (effortRank(baseline) >= effortRank('xhigh')) {
    return { applicable: false, reason: `session baseline is ${baseline}; the effort bridge has no upward use (everything runs in-session).`, findings: [], confirmations: [] };
  }
  if (!aboveBaseline.length) {
    return { applicable: false, reason: `no roster archetype carries an effort tier above the ${baseline} baseline; the bridge is not needed for this roster.`, findings: [], confirmations: [] };
  }

  // What actually ran in-session (rode the baseline via the Task tool), and
  // every effort-bridge CLI spawn observed across all actors.
  const spawnedInSession = new Set();
  const bridgeSpawns = [];
  for (const a of actors) {
    for (const [type, c] of Object.entries(a.spawnedAgentTypes || {})) if (c > 0) spawnedInSession.add(type);
    for (const b of (a.effortBridgeSpawns || [])) bridgeSpawns.push(b);
  }

  const findings = [], confirmations = [];

  for (const arch of aboveBaseline) {
    const ranInSession = spawnedInSession.has(arch.name);
    const matchingBridge = bridgeSpawns.some(b => b.agent === arch.name && effortRank(b.level) >= effortRank(arch.effort));
    const bridgedAtAll = bridgeSpawns.some(b => b.agent === arch.name);
    if (ranInSession && !matchingBridge) {
      findings.push({
        code: 'effort-under-lift',
        severity: 'advisory',
        message: `${arch.name} (rubric effort ${arch.effort}) ran in-session at the ${baseline} baseline; no effort-bridge CLI spawn lifted it to ${arch.effort}.`,
        evidence: `Above-baseline archetype spawned via the Task tool (rides the session baseline); zero \`claude ... --agent ${arch.name} --effort ${arch.effort}\` commands observed. On the current harness an in-session Task agent cannot exceed the baseline, so its rubric effort was silently not delivered.`,
      });
    } else if (ranInSession && matchingBridge) {
      confirmations.push(`${arch.name} lifted to ${arch.effort} via the effort bridge (correct).`);
    } else if (!ranInSession && bridgedAtAll) {
      confirmations.push(`${arch.name} ran only via the effort bridge (correct; never rode the baseline in-session).`);
    }
    // Not run at all: silent (the archetype simply was not needed this window).
  }

  for (const b of bridgeSpawns) {
    if (b.level && effortRank(b.level) <= effortRank(baseline)) {
      findings.push({
        code: 'effort-downward-bridge',
        severity: 'advisory',
        message: `effort-bridge spawn${b.agent ? ' of ' + b.agent : ''} at ${b.level} is at or below the ${baseline} baseline.`,
        evidence: `A fresh CLI process pays the full entry tax (cold cache, reloaded system prompt and schemas) for no reasoning gain over the baseline. Baseline-or-lower agents should ride the session in-session; the bridge is upward-only.`,
      });
    }
  }

  return { applicable: true, baseline, aboveBaseline: aboveBaseline.map(a => `${a.name}(${a.effort})`), bridgeSpawnCount: bridgeSpawns.length, findings, confirmations };
}

// -------------------------------------------------------------------------
// Orchestrator-engagement adherence
// -------------------------------------------------------------------------
// Plan scale is a transcript proxy: the larger of the session's peak TodoWrite
// list length and its direct worker-subagent spawn count (orchestrator spawns
// excluded). When a plan is delegated, todos carry the scale while direct
// worker spawns stay low; when it is self-orchestrated, direct worker spawns
// carry it. The proxy therefore reads plan scale in both engagement modes. It
// is labelled a proxy wherever surfaced.
export function orchestratorAdherence(actors, phanes) {
  const threshold = phanes.threshold || 5;
  if (!phanes.orchestrator) {
    return { applicable: false, reason: `no orchestrator archetype in this project's roster; rule 11 engagement is not part of its repertoire.`, findings: [], confirmations: [] };
  }
  const orchName = phanes.orchestrator.name;
  const mains = actors.filter(a => a.kind !== 'agent');

  const findings = [], confirmations = [];
  let planScaleSessions = 0;

  for (const s of mains) {
    const orchestratorSpawns = spawnCount(s, t => ORCH_RE.test(t));
    const totalSpawns = spawnCount(s, () => true);
    const workerSpawns = Math.max(0, totalSpawns - orchestratorSpawns);
    const todos = s.maxTodoCount || 0;
    const planScale = Math.max(todos, workerSpawns);
    const engaged = orchestratorSpawns > 0;
    const evid = `observable scale: peak todos ${todos}, direct worker spawns ${workerSpawns} (proxy); threshold ${threshold}`;

    if (planScale >= threshold) planScaleSessions++;

    if (engaged && planScale >= threshold) {
      confirmations.push(`session ${s.id.slice(0, 8)}: orchestrator engaged for a plan-scale run (${evid}).`);
    } else if (engaged && planScale < threshold) {
      findings.push({
        code: 'orchestrator-over-engaged',
        severity: 'advisory',
        session: s.id,
        message: `session ${s.id.slice(0, 8)} engaged ${orchName} for a run whose observable scale is below the threshold.`,
        evidence: `${evid}. If this was an explicitly narrowed invocation ("only step 1") this is correct; otherwise a sub-threshold task paid the subagent entry tax that engagement is meant to amortise.`,
      });
    } else if (!engaged && planScale >= threshold) {
      findings.push({
        code: 'orchestrator-under-engaged',
        severity: 'advisory',
        session: s.id,
        message: `session ${s.id.slice(0, 8)} self-orchestrated a plan-scale run without engaging ${orchName}.`,
        evidence: `${evid}. Rule 11 suggests delegating a plan of this scale to ${orchName} so the primary session stays slim (roughly one spawn prompt plus receipt per batch) and re-read discipline survives compaction.`,
      });
    }
    // Sub-threshold and not engaged: silent (correct: no plan warranted it).
  }

  return {
    applicable: true,
    threshold,
    orchestrator: orchName,
    planScaleSessions,
    phanesPlanEvidence: phanes.planScale || { summaryCount: 0, maxSteps: 0 },
    findings,
    confirmations,
  };
}

// One entry point the audit engine calls.
export function computeAdherence(actors, phanes) {
  return {
    effortBridge: effortBridgeAdherence(actors, phanes),
    orchestrator: orchestratorAdherence(actors, phanes),
  };
}
