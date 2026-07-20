#!/usr/bin/env node
// census.mjs  --  Metis capability census (v0.2)
//
// Deterministic, no-deps capability detection for a Claude Code setup. It
// enumerates the MCP servers, plugins, skills, slash commands, and foreign
// agents present on the machine, probes each MCP server's reachability
// (best effort), and proposes a per item selection. It never asks the user a
// question; the consent question is a Claude side concern (the /metis command).
//
// The Phanes standard set (context7, deepwiki, serena, semble, frontend-design)
// is recognized as "standard" ONLY when a .phanes/ directory is present in the
// project. On a standalone run no capability name is assumed: everything is
// discovered, and every detected item is listed unchecked by its detected name.
//
// Subcommands (via metis.mjs, or run directly):
//   node census.mjs --project <repoRoot> [--json]
//   node census.mjs --project <repoRoot> --set-selection name1,name2,...
//
// The manifest that persists the selection is:
//   Phanes mode     -> <project>/.phanes/config.json  (capabilities block)
//   standalone mode -> <project>/.metis/config.json   (capabilities block)
// Both use the same capabilities schema so an update run can diff them.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const PHANES_STANDARD = ['context7', 'deepwiki', 'serena', 'semble', 'frontend-design'];

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------
function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}
function listDirSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
function homeClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

// Encode a project path to its Claude Code transcript directory name.
// C:\Projects\Phanes -> C--Projects-Phanes  (":" and path separators -> "-").
export function encodeProjectDir(projectPath) {
  return projectPath.replace(/:/g, '-').replace(/[\\/]/g, '-');
}

// The main-session transcript directory for a project, if it exists.
export function transcriptDirFor(projectPath, home = homeClaudeDir()) {
  return path.join(home, 'projects', encodeProjectDir(path.resolve(projectPath)));
}

// A project is Phanes integrated when it carries a .phanes/ directory.
export function detectMode(projectPath) {
  return fs.existsSync(path.join(projectPath, '.phanes')) ? 'phanes' : 'standalone';
}

// Where the selection manifest lives for a given mode.
export function manifestPathFor(projectPath, mode = detectMode(projectPath)) {
  return mode === 'phanes'
    ? path.join(projectPath, '.phanes', 'config.json')
    : path.join(projectPath, '.metis', 'config.json');
}

// ---------------------------------------------------------------------------
// Reachability / auth signals
// ---------------------------------------------------------------------------
// Claude Code caches "this MCP server needs authentication" as a file whose
// keys look like "plugin:context7:context7" or "<server>". A server named in
// that cache is treated as authOk:false. Absence is not proof of health, so a
// server missing from every positive signal stays "unknown".
function loadAuthCache(home) {
  const cache = readJsonSafe(path.join(home, 'mcp-needs-auth-cache.json')) || {};
  const needsAuth = new Set();
  for (const key of Object.keys(cache)) {
    for (const seg of String(key).split(':')) if (seg) needsAuth.add(seg.toLowerCase());
  }
  return needsAuth;
}

// Best effort `claude mcp list`. Never blocks the run: short timeout, all
// errors swallowed. Returns a lowercased map name -> true|false (connected) for
// any server the output clearly reports on; unknown servers are simply absent.
function probeMcpList() {
  const status = {};
  let out = '';
  try {
    out = execFileSync('claude', ['mcp', 'list'], {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch (e) {
    if (e && typeof e.stdout === 'string' && e.stdout) out = e.stdout; else return status;
  }
  for (const rawLine of out.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Typical shapes: "context7: https://... - ✓ Connected" or
    // "serena: ... - ✗ Failed to connect". Parse leading "name:" then verdict.
    const m = line.match(/^([A-Za-z0-9._-]+)\s*:/);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (/(connected|✓|reachable|ok\b)/i.test(line)) status[name] = true;
    else if (/(failed|✗|error|needs? auth|not connected|unauthenticat)/i.test(line)) status[name] = false;
  }
  return status;
}

// Decide authOk for one MCP server from every available signal, most
// trustworthy first: transcript evidence of a successful call, then the live
// list, then the needs-auth cache, else unknown.
function resolveAuthOk(name, sig) {
  const n = name.toLowerCase();
  if (sig.usedServers && sig.usedServers.has(n)) return true;          // it actually ran
  if (Object.prototype.hasOwnProperty.call(sig.mcpList, n)) return sig.mcpList[n];
  if (sig.needsAuth.has(n)) return false;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------
// Collect MCP servers from project .mcp.json, home .mcp.json, and the live
// list. scope records where the server was declared.
function detectMcpServers(projectPath, home, sig) {
  const found = new Map(); // name -> { scopes:Set }
  const add = (name, scope) => {
    const n = name;
    if (!found.has(n)) found.set(n, { scopes: new Set() });
    found.get(n).scopes.add(scope);
  };
  const projMcp = readJsonSafe(path.join(projectPath, '.mcp.json'));
  if (projMcp && projMcp.mcpServers) for (const n of Object.keys(projMcp.mcpServers)) add(n, 'project');
  const homeMcp = readJsonSafe(path.join(home, '.mcp.json'));
  if (homeMcp && homeMcp.mcpServers) for (const n of Object.keys(homeMcp.mcpServers)) add(n, 'user');
  for (const n of Object.keys(sig.mcpList)) if (!found.has(n)) add(n, 'live');

  const out = [];
  for (const [name, meta] of found) {
    out.push({
      name, type: 'mcp',
      scope: [...meta.scopes].join('+'),
      authOk: resolveAuthOk(name, sig),
      source: 'detected',
    });
  }
  return out;
}

// Enabled plugins from settings.json (keys are "name@marketplace").
function detectPlugins(projectPath, home) {
  const seen = new Map();
  const fromSettings = (fp, scope) => {
    const s = readJsonSafe(fp);
    if (!s || !s.enabledPlugins) return;
    for (const key of Object.keys(s.enabledPlugins)) {
      if (!s.enabledPlugins[key]) continue;
      const name = String(key).split('@')[0];
      if (!seen.has(name)) seen.set(name, scope);
    }
  };
  fromSettings(path.join(home, 'settings.json'), 'user');
  fromSettings(path.join(projectPath, '.claude', 'settings.json'), 'project');
  return [...seen].map(([name, scope]) => ({ name, type: 'plugin', scope, authOk: true, source: 'detected' }));
}

// Filesystem skills: one directory per skill under <root>/.claude/skills or
// ~/.claude/skills. Plugin bundled skills are intentionally not expanded here;
// the census lists the plugin, not each of its inner skills, to keep the
// consent list to a human scale.
function detectSkills(projectPath, home) {
  const out = [];
  const scan = (dir, scope) => {
    for (const d of listDirSafe(dir)) {
      if (!d.isDirectory()) continue;
      out.push({ name: d.name, type: 'skill', scope, authOk: true, source: 'detected' });
    }
  };
  scan(path.join(home, 'skills'), 'user');
  scan(path.join(projectPath, '.claude', 'skills'), 'project');
  return dedupeByName(out);
}

// Slash commands: <root>/.claude/commands/*.md and ~/.claude/commands/*.md.
function detectCommands(projectPath, home) {
  const out = [];
  const scan = (dir, scope) => {
    for (const d of listDirSafe(dir)) {
      if (!d.isFile() || !d.name.endsWith('.md')) continue;
      out.push({ name: '/' + d.name.replace(/\.md$/, ''), type: 'command', scope, authOk: true, source: 'detected' });
    }
  };
  scan(path.join(home, 'commands'), 'user');
  scan(path.join(projectPath, '.claude', 'commands'), 'project');
  return dedupeByName(out);
}

// Foreign agents: <root>/.claude/agents/*.md. Listed for awareness only; Metis
// never rosters or rewrites them. A Phanes generated agent is still an agent
// here; ownership is a Phanes side concern, not a census one.
function detectAgents(projectPath) {
  const out = [];
  for (const d of listDirSafe(path.join(projectPath, '.claude', 'agents'))) {
    if (!d.isFile() || !d.name.endsWith('.md')) continue;
    out.push({ name: d.name.replace(/\.md$/, ''), type: 'agent', scope: 'project', authOk: true, source: 'detected' });
  }
  return out;
}

function dedupeByName(items) {
  const seen = new Map();
  for (const it of items) {
    const k = it.type + '|' + it.name;
    if (!seen.has(k)) seen.set(k, it);
    else seen.get(k).scope = [...new Set((seen.get(k).scope + '+' + it.scope).split('+'))].join('+');
  }
  return [...seen.values()];
}

// Full census: every detected capability, with authOk resolved.
// `usedServers` (optional Set of lowercased server names actually called) folds
// transcript evidence into the auth decision.
export function census(projectPath, opts = {}) {
  const home = opts.home || homeClaudeDir();
  const mode = opts.mode || detectMode(projectPath);
  const sig = {
    needsAuth: loadAuthCache(home),
    mcpList: opts.mcpList || (opts.probe === false ? {} : probeMcpList()),
    usedServers: opts.usedServers || null,
  };
  const detected = [
    ...detectMcpServers(projectPath, home, sig),
    ...detectPlugins(projectPath, home),
    ...detectSkills(projectPath, home),
    ...detectCommands(projectPath, home),
    ...detectAgents(projectPath),
  ];
  const proposed = proposeSelection(detected, mode);
  return {
    mode,
    detected: proposed,
    optimizability: assessOptimizability(proposed, { transcriptDirExists: fs.existsSync(transcriptDirFor(projectPath, home)) }),
    signals: { needsAuth: [...sig.needsAuth] },
  };
}

// Guard rail: decide, before any audit or proposal work, whether there is
// anything here to optimize at all. A setup with no MCP servers, no plugins,
// and no skills has nothing to build policy around; a setup with no agents has
// nothing to grant capabilities TO. Either way Metis should stop and say so
// rather than emit an official looking but empty report.
export function assessOptimizability(detected, opts = {}) {
  const count = (t) => detected.filter(d => d.type === t).length;
  const tools = count('mcp') + count('plugin') + count('skill');
  const agents = count('agent');
  const reasons = [];
  if (tools === 0) reasons.push('no MCP servers, plugins, or skills detected: nothing to build policy around');
  if (agents === 0) reasons.push('no agents detected: nothing to grant capabilities to or consolidate');
  if (opts.transcriptDirExists === false) reasons.push('no transcript directory for this project yet: nothing to audit');
  // Optimizable only when there is at least one capability to reason about.
  // (Agentless setups still yield tool-adherence findings, so agents alone do
  // not gate; but a total absence of tools AND agents is a hard stop.)
  const optimizable = tools > 0 || agents > 0;
  return {
    optimizable,
    counts: { mcp: count('mcp'), plugin: count('plugin'), skill: count('skill'), command: count('command'), agent: agents },
    reasons,
    stop: !optimizable,
    message: optimizable
      ? null
      : 'Nothing to optimize: no MCP servers, plugins, skills, or agents were detected for this setup.',
  };
}

// Apply source ("standard" vs "detected") and the proposed `selected` default.
// In Phanes mode the standard set is recognized and pre-selected; everything
// else is unchecked. In standalone mode nothing is standard and nothing is
// pre-selected.
export function proposeSelection(detected, mode) {
  return detected.map(it => {
    const isStandard = mode === 'phanes' && it.type === 'mcp' && PHANES_STANDARD.includes(it.name);
    return {
      name: it.name,
      type: it.type,
      scope: it.scope,
      authOk: it.authOk,
      source: isStandard ? 'standard' : 'detected',
      selected: isStandard,
    };
  });
}

// ---------------------------------------------------------------------------
// Manifest read / diff / write
// ---------------------------------------------------------------------------
export function readSelection(projectPath, mode = detectMode(projectPath)) {
  const cfg = readJsonSafe(manifestPathFor(projectPath, mode));
  if (cfg && cfg.capabilities && Array.isArray(cfg.capabilities.selection)) return cfg.capabilities.selection;
  return null;
}

// Diff a fresh proposal against a prior persisted selection. Drives the update
// run behavior: no delta means ask nothing; a delta is asked about narrowly.
export function diffSelection(fresh, prior) {
  const priorByKey = new Map((prior || []).map(p => [p.type + '|' + p.name, p]));
  const freshByKey = new Map(fresh.map(f => [f.type + '|' + f.name, f]));
  const added = [], removed = [], authChanged = [], unchanged = [];
  for (const [k, f] of freshByKey) {
    const p = priorByKey.get(k);
    if (!p) added.push(f);
    else if (String(p.authOk) !== String(f.authOk)) authChanged.push({ ...f, priorAuthOk: p.authOk });
    else unchanged.push(f);
  }
  for (const [k, p] of priorByKey) if (!freshByKey.has(k)) removed.push(p);
  return { added, removed, authChanged, unchanged, hasDelta: added.length + removed.length + authChanged.length > 0 };
}

// Persist a selection to the mode appropriate manifest, preserving the rest of
// the capabilities block (granted[], failures[]) and any other config keys.
export function writeSelection(projectPath, selectedNames, detected, opts = {}) {
  const mode = opts.mode || detectMode(projectPath);
  const fp = manifestPathFor(projectPath, mode);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const cfg = readJsonSafe(fp) || {};
  const prevCaps = cfg.capabilities || {};
  const selectedSet = new Set(selectedNames);
  const selection = detected.map(it => ({
    name: it.name, type: it.type, scope: it.scope, authOk: it.authOk,
    source: it.source || 'detected',
    // Honor the explicit selection; if a name was not offered a choice, keep
    // its proposed default.
    selected: selectedSet.size ? selectedSet.has(it.name) : !!it.selected,
  }));
  cfg.capabilities = {
    inventoryDate: opts.date || new Date().toISOString().slice(0, 10),
    selection,
    granted: Array.isArray(prevCaps.granted) ? prevCaps.granted : [],
    failures: Array.isArray(prevCaps.failures) ? prevCaps.failures : [],
  };
  fs.writeFileSync(fp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { path: fp, mode, selection };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { project: process.cwd(), json: false, setSelection: null, noProbe: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--project') a.project = argv[++i];
    else if (t === '--json') a.json = true;
    else if (t === '--set-selection') a.setSelection = argv[++i];
    else if (t === '--no-probe') a.noProbe = true;
    else if (t === '-h' || t === '--help') a.help = true;
  }
  return a;
}

function runCli(argv) {
  const a = parseArgs(argv);
  if (a.help) {
    console.log(`Metis census (v0.2)
Usage:
  node census.mjs --project <repoRoot> [--json] [--no-probe]
  node census.mjs --project <repoRoot> --set-selection name1,name2,...

  --project        Repository root to census (default: cwd).
  --json           Emit the full census as JSON (for the /metis command).
  --no-probe       Skip the live \`claude mcp list\` reachability probe.
  --set-selection  Persist a comma separated list of selected capability names.`);
    return 0;
  }
  const project = path.resolve(a.project);
  const mode = detectMode(project);
  const result = census(project, { mode, probe: !a.noProbe });

  if (a.setSelection !== null) {
    const names = a.setSelection.split(',').map(s => s.trim()).filter(Boolean);
    const w = writeSelection(project, names, result.detected, { mode });
    if (a.json) console.log(JSON.stringify({ ok: true, ...w }, null, 2));
    else console.log(`[census] wrote ${w.selection.filter(s => s.selected).length} selected of ${w.selection.length} capabilities to ${w.path}`);
    return 0;
  }

  const prior = readSelection(project, mode);
  const diff = prior ? diffSelection(result.detected, prior) : null;
  const payload = { project, mode, transcriptDir: transcriptDirFor(project), ...result, prior: prior || null, diff };

  if (a.json) { console.log(JSON.stringify(payload, null, 2)); return 0; }

  // Human summary.
  console.log(`Metis census -- ${project}`);
  console.log(`Mode: ${mode}${mode === 'phanes' ? ' (Phanes standard set recognized)' : ' (fully discovered, nothing assumed)'}`);
  console.log(`Transcript dir: ${payload.transcriptDir}${fs.existsSync(payload.transcriptDir) ? '' : ' (not found)'}`);
  console.log('');

  // Guard rail: stop early when there is nothing to optimize.
  const opt = result.optimizability;
  if (opt.stop) {
    console.log('STOP: ' + opt.message);
    for (const r of opt.reasons) console.log('  - ' + r);
    return 0;
  }
  if (opt.reasons.length) {
    console.log('Notes before optimizing:');
    for (const r of opt.reasons) console.log('  - ' + r);
    console.log('');
  }
  const byType = {};
  for (const c of result.detected) (byType[c.type] ||= []).push(c);
  for (const type of ['mcp', 'plugin', 'skill', 'command', 'agent']) {
    const items = byType[type] || [];
    if (!items.length) continue;
    console.log(`${type} (${items.length}):`);
    for (const c of items) {
      const mark = c.selected ? '[x]' : '[ ]';
      const auth = c.type === 'mcp' ? `  authOk=${c.authOk}` : '';
      const std = c.source === 'standard' ? '  (Recommended)' : '';
      console.log(`  ${mark} ${c.name}${auth}${std}  <${c.scope}>`);
    }
    console.log('');
  }
  if (diff) {
    if (!diff.hasDelta) console.log('Update diff: no delta since last selection. Nothing to ask.');
    else console.log(`Update diff: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.authChanged.length} auth changed.`);
  } else {
    console.log('No prior manifest: this is a setup (first) run.');
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) process.exit(runCli(process.argv.slice(2)));
