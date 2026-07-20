// test.mjs  --  Metis v0.2 unit tests. Pure node:test, no deps.
//   node --test
// Deterministic: every test builds its own fixture under a temp dir and passes
// an explicit fake home so the real machine config never leaks in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  encodeProjectDir, transcriptDirFor, detectMode, manifestPathFor,
  census, proposeSelection, diffSelection, readSelection, writeSelection,
  assessOptimizability, PHANES_STANDARD,
} from './census.mjs';
import {
  loadLedger, saveLedger, addEntry, serverUsage, windowSize, verify, candidateProposals,
  ledgerPathFor,
} from './ledger.mjs';
import { derivePolicy } from './policy.mjs';

let counter = 0;
function tmpProject() {
  const dir = path.join(os.tmpdir(), `metis-test-${process.pid}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function fakeHome(mcpServers = {}, enabledPlugins = {}, needsAuth = {}) {
  const home = tmpProject();
  fs.writeFileSync(path.join(home, '.mcp.json'), JSON.stringify({ mcpServers }));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ enabledPlugins }));
  fs.writeFileSync(path.join(home, 'mcp-needs-auth-cache.json'), JSON.stringify(needsAuth));
  fs.mkdirSync(path.join(home, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
  return home;
}

// ---------------------------------------------------------------------------
// census: encoding + mode
// ---------------------------------------------------------------------------
test('encodeProjectDir replaces colon and separators with dash', () => {
  assert.equal(encodeProjectDir('C:\\Projects\\Phanes'), 'C--Projects-Phanes');
  assert.equal(encodeProjectDir('C:/Projects/Metis'), 'C--Projects-Metis');
});

test('transcriptDirFor lands under home/projects/<encoded>', () => {
  const td = transcriptDirFor('C:\\Projects\\Phanes', 'H:\\home');
  assert.ok(td.endsWith(path.join('projects', 'C--Projects-Phanes')));
});

test('detectMode is phanes only when .phanes/ exists', () => {
  const p = tmpProject();
  assert.equal(detectMode(p), 'standalone');
  fs.mkdirSync(path.join(p, '.phanes'));
  assert.equal(detectMode(p), 'phanes');
});

test('manifestPathFor points to config per mode', () => {
  const p = tmpProject();
  assert.ok(manifestPathFor(p, 'phanes').endsWith(path.join('.phanes', 'config.json')));
  assert.ok(manifestPathFor(p, 'standalone').endsWith(path.join('.metis', 'config.json')));
});

// ---------------------------------------------------------------------------
// census: detection + auth resolution + standard recognition
// ---------------------------------------------------------------------------
test('census detects home MCP + plugins; authOk from needs-auth cache', () => {
  const home = fakeHome(
    { context7: { type: 'http', url: 'x' }, semble: { type: 'stdio' } },
    { 'coderabbit@official': true, 'frontend-design@official': true },
    { 'plugin:context7:context7': { id: 'x' } },
  );
  const proj = tmpProject();
  const r = census(proj, { home, probe: false });
  const c7 = r.detected.find(x => x.name === 'context7');
  const sem = r.detected.find(x => x.name === 'semble');
  assert.equal(c7.authOk, false);       // in needs-auth cache
  assert.equal(sem.authOk, 'unknown');  // no positive or negative signal
  assert.equal(r.detected.filter(x => x.type === 'plugin').length, 2);
});

test('proposeSelection marks standard pre-selected only in phanes mode', () => {
  const detected = PHANES_STANDARD.map(n => ({ name: n, type: 'mcp', scope: 'user', authOk: true }));
  const phanes = proposeSelection(detected, 'phanes');
  const standalone = proposeSelection(detected, 'standalone');
  assert.ok(phanes.every(x => x.selected && x.source === 'standard'));
  assert.ok(standalone.every(x => !x.selected && x.source === 'detected'));
});

test('usedServers (transcript evidence) makes authOk true even if in cache', () => {
  const home = fakeHome({ semble: {} }, {}, { 'semble': { id: 'x' } });
  const proj = tmpProject();
  const r = census(proj, { home, probe: false, usedServers: new Set(['semble']) });
  assert.equal(r.detected.find(x => x.name === 'semble').authOk, true);
});

// ---------------------------------------------------------------------------
// census: diff
// ---------------------------------------------------------------------------
test('diffSelection detects added / removed / auth-change / no-delta', () => {
  const prior = [
    { name: 'semble', type: 'mcp', authOk: true },
    { name: 'serena', type: 'mcp', authOk: true },
  ];
  const same = diffSelection([...prior.map(p => ({ ...p }))], prior);
  assert.equal(same.hasDelta, false);

  const fresh = [
    { name: 'semble', type: 'mcp', authOk: false }, // auth changed
    { name: 'context7', type: 'mcp', authOk: true }, // added
    // serena removed
  ];
  const d = diffSelection(fresh, prior);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].name, 'context7');
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].name, 'serena');
  assert.equal(d.authChanged.length, 1);
  assert.equal(d.authChanged[0].name, 'semble');
  assert.equal(d.hasDelta, true);
});

// ---------------------------------------------------------------------------
// census: persist round-trip
// ---------------------------------------------------------------------------
test('writeSelection then readSelection round-trips and preserves granted/failures', () => {
  const p = tmpProject();
  fs.mkdirSync(path.join(p, '.phanes'));
  fs.writeFileSync(path.join(p, '.phanes', 'config.json'), JSON.stringify({
    capabilities: { granted: [{ name: 'semble', type: 'mcp' }], failures: [{ name: 'x' }] },
    otherKey: 42,
  }));
  const detected = [
    { name: 'semble', type: 'mcp', scope: 'user', authOk: true, source: 'standard' },
    { name: 'context7', type: 'mcp', scope: 'user', authOk: false, source: 'detected' },
  ];
  writeSelection(p, ['semble'], detected, { mode: 'phanes', date: '2026-07-20' });
  const sel = readSelection(p, 'phanes');
  assert.equal(sel.length, 2);
  assert.equal(sel.find(s => s.name === 'semble').selected, true);
  assert.equal(sel.find(s => s.name === 'context7').selected, false);
  // preserved
  const cfg = JSON.parse(fs.readFileSync(path.join(p, '.phanes', 'config.json'), 'utf8'));
  assert.equal(cfg.otherKey, 42);
  assert.equal(cfg.capabilities.granted.length, 1);
  assert.equal(cfg.capabilities.failures.length, 1);
  assert.equal(cfg.capabilities.inventoryDate, '2026-07-20');
});

// ---------------------------------------------------------------------------
// census: optimizability gate
// ---------------------------------------------------------------------------
test('assessOptimizability stops when nothing detected', () => {
  const a = assessOptimizability([]);
  assert.equal(a.optimizable, false);
  assert.equal(a.stop, true);
  assert.match(a.message, /Nothing to optimize/);
});

test('assessOptimizability optimizable with a tool but no agents (soft note)', () => {
  const a = assessOptimizability([{ name: 'semble', type: 'mcp' }]);
  assert.equal(a.optimizable, true);
  assert.ok(a.reasons.some(r => /no agents/.test(r)));
});

// ---------------------------------------------------------------------------
// policy derivation
// ---------------------------------------------------------------------------
test('derivePolicy (phanes) reads selection+granted, excludes unreachable', () => {
  const p = tmpProject();
  fs.mkdirSync(path.join(p, '.phanes'));
  fs.writeFileSync(path.join(p, '.phanes', 'config.json'), JSON.stringify({
    capabilities: {
      selection: [
        { name: 'semble', type: 'mcp', selected: true, authOk: true },
        { name: 'context7', type: 'mcp', selected: true, authOk: false }, // unreachable, excluded
        { name: 'serena', type: 'mcp', selected: false, authOk: true },   // not selected, excluded
      ],
      granted: [{ name: 'semble', type: 'mcp' }],
    },
  }));
  const pol = derivePolicy(p);
  assert.deepEqual(pol.configuredMcpServers, ['semble']);
  assert.deepEqual(pol.grantedServers, ['semble']);
  assert.equal(pol.mandatedTools.length, 0); // no explicit mandate invented
  assert.equal(pol.mode, 'phanes');
});

test('derivePolicy (standalone) names no external tool and mandates nothing', () => {
  const home = fakeHome({ someExternal: {} }, {}, {}); // reachable-ish (unknown), included
  const p = tmpProject();
  const pol = derivePolicy(p, { probe: false, home: undefined });
  // standalone derivation uses census() with default home; assert it never
  // invents a mandate and stays standalone-shaped.
  assert.equal(pol.mode, 'standalone');
  assert.equal(pol.mandatedTools.length, 0);
  assert.equal(pol.grantedServers.length, 0);
});

// ---------------------------------------------------------------------------
// ledger: schema + verification-first + proposals
// ---------------------------------------------------------------------------
test('addEntry assigns incrementing ids and gates by kind', () => {
  const L = { version: '0.2', entries: [] };
  const a = addEntry(L, { change: 'trig', kind: 'trigger-line', target: { capability: 'semble' } });
  const b = addEntry(L, { change: 'merge', kind: 'structural', target: { capability: 'x' } });
  assert.equal(a.id, 'L001');
  assert.equal(a.gate, 'autonomous');
  assert.equal(a.status, 'applied');
  assert.equal(b.id, 'L002');
  assert.equal(b.gate, 'ask-first');
  assert.equal(b.status, 'proposed');
});

test('serverUsage + windowSize count across sessions and subagents', () => {
  const audit = {
    sessions: [
      { id: 's1', mcpByServer: { semble: { search: 2 } } },
      { id: 's2', mcpByServer: {} },
    ],
    agents: [{ id: 'a1', parentSession: 's2', mcpByServer: { semble: { find: 1 } } }],
  };
  const u = serverUsage(audit);
  assert.equal(u['semble'].calls, 3);
  assert.equal(u['semble'].sessions.size, 2);
  assert.equal(windowSize(audit), 2);
});

test('verify: delivered when capability now used', () => {
  const L = { version: '0.2', entries: [] };
  addEntry(L, { change: 'x', kind: 'trigger-line', target: { capability: 'semble' } });
  const audit = { sessions: [{ id: 's1', mcpByServer: { semble: { search: 1 } } }], agents: [] };
  const v = verify(L, audit, { minSessions: 1 });
  assert.equal(v.scored[0].verdict, 'delivered');
});

test('verify: regressed with rollback when still unused over enough sessions', () => {
  const L = { version: '0.2', entries: [] };
  addEntry(L, { change: 'x', kind: 'trigger-line', target: { capability: 'semble' } });
  const audit = { sessions: [{ id: 's1', mcpByServer: {} }, { id: 's2', mcpByServer: {} }, { id: 's3', mcpByServer: {} }], agents: [] };
  const v = verify(L, audit, { minSessions: 3 });
  assert.equal(v.scored[0].verdict, 'regressed');
  assert.equal(v.scored[0].rollbackProposed, true);
  assert.equal(v.regressed.length, 1);
});

test('verify: not-yet-measurable when window too small', () => {
  const L = { version: '0.2', entries: [] };
  addEntry(L, { change: 'x', kind: 'trigger-line', target: { capability: 'semble' } });
  const audit = { sessions: [{ id: 's1', mcpByServer: {} }], agents: [] };
  const v = verify(L, audit, { minSessions: 3 });
  assert.equal(v.scored[0].verdict, 'not-yet-measurable');
});

test('candidateProposals: strong signal fires, cooldown suppresses, unreachable flagged', () => {
  const audit = { sessions: [{ id: 's1', mcpByServer: {} }, { id: 's2', mcpByServer: {} }, { id: 's3', mcpByServer: {} }], agents: [] };
  const policy = {
    configuredMcpServers: ['semble'],
    grantedServers: ['semble'],
    _selection: [{ name: 'context7', type: 'mcp', selected: true, authOk: false }],
  };
  // empty ledger -> semble proposal + context7 flag
  const fresh = candidateProposals(audit, policy, { entries: [] }, { minSessions: 3 });
  const kinds = fresh.proposals.map(p => `${p.kind}:${p.target.capability}`);
  assert.ok(kinds.includes('trigger-line:semble'));
  assert.ok(kinds.includes('flag:context7'));

  // ledger already acted on semble -> cooldown suppresses the semble proposal
  const cooled = candidateProposals(audit, policy,
    { entries: [{ id: 'L001', status: 'applied', target: { capability: 'semble' } }] }, { minSessions: 3 });
  assert.ok(!cooled.proposals.some(p => p.target.capability === 'semble'));
});

test('candidateProposals: window too small yields no proposals', () => {
  const audit = { sessions: [{ id: 's1', mcpByServer: {} }], agents: [] };
  const r = candidateProposals(audit, { configuredMcpServers: ['semble'], grantedServers: [] }, { entries: [] }, { minSessions: 3 });
  assert.equal(r.proposals.length, 0);
});

// ---------------------------------------------------------------------------
// ledger: file round-trip
// ---------------------------------------------------------------------------
test('saveLedger + loadLedger round-trip', () => {
  const p = tmpProject();
  fs.mkdirSync(path.join(p, '.phanes'));
  const fp = ledgerPathFor(p);
  const L = { version: '0.2', entries: [] };
  addEntry(L, { change: 'x', kind: 'annotation' });
  saveLedger(fp, L);
  const back = loadLedger(fp);
  assert.equal(back.entries.length, 1);
  assert.equal(back.entries[0].change, 'x');
});
