#!/usr/bin/env node
// session-audit.mjs  ::  Metis audit engine (v0.2; formerly the standalone
// session-audit prototype v0/v0.1). Part of the Metis companion.
//
// Audits Claude Code JSONL session transcripts to check whether an
// orchestration framework actually used its mandated toolset. Ground truth
// is the transcript, not the console. Pure Node, no npm deps, streams
// line-by-line with readline, Windows-safe paths.
//
// Usage:
//   node session-audit.mjs --dir <transcriptDir> [--last N] [--policy policy.json] [--out reports/]
//
// Reports contain AGGREGATES ONLY -- never raw transcript content.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { derivePolicy } from './policy.mjs';
import { buildPhanesContext } from './phanes-context.mjs';
import { computeAdherence } from './adherence.mjs';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { dir: null, last: 0, policy: null, out: null, tasksDir: null, harvest: null, noTasks: false, project: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dir') a.dir = argv[++i];
    else if (t === '--last') a.last = parseInt(argv[++i], 10) || 0;
    else if (t === '--policy') a.policy = argv[++i];
    else if (t === '--project') a.project = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--tasks-dir') a.tasksDir = argv[++i];
    else if (t === '--harvest') a.harvest = argv[++i];
    else if (t === '--no-tasks') a.noTasks = true;
    else if (t === '-h' || t === '--help') a.help = true;
  }
  return a;
}

const HELP = `Metis audit engine (v0.2)
Usage: node session-audit.mjs --dir <transcriptDir> [--last N] [--policy policy.json]
                              [--out reports/] [--tasks-dir <path>] [--no-tasks] [--harvest <destDir>]

  --dir        Directory containing <session-id>.jsonl main transcripts (required)
  --last       Audit only the N most recently modified main session files (0 = all)
  --policy     Path to policy.json (explicit policy always wins over derivation)
  --project    Repo root; when given and no --policy, the policy is derived from
               .phanes/config.json (Phanes mode) or inferred from detection (standalone)
  --out        Output directory for reports (default: <scriptDir>/reports)
  --tasks-dir  Temp task store root for subagent transcripts. Default: derived from --dir as
               %LOCALAPPDATA%\\Temp\\claude\\<encoded-project>. Subagent transcripts live at
               <tasks-dir>\\<session-uuid>\\tasks\\<taskId>.output
  --no-tasks   Skip the Temp task store entirely (main-session audit only, = v0 behaviour)
  --harvest    Copy task .output files into a durable archive <destDir>/<project>/<session>/ before
               auditing (idempotent; skips already-harvested files). Off by default -- Temp is volatile.
`;

// ---------------------------------------------------------------------------
// Secret-scan patterns  (report location + type ONLY; value is masked)
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  { type: 'postgres-uri',   re: /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi },
  { type: 'neon-pw',        re: /\bnpg_[A-Za-z0-9]{8,}/g },
  { type: 'stripe-live',    re: /\bsk_live_[A-Za-z0-9]{8,}/g },
  { type: 'stripe-test',    re: /\bsk_test_[A-Za-z0-9]{8,}/g },
  { type: 'github-pat',     re: /\bghp_[A-Za-z0-9]{20,}/g },
  { type: 'bearer-token',   re: /\bBearer\s+[A-Za-z0-9._\-]{12,}/g },
  { type: 'api-key-assign', re: /\bapi[_-]?key\s*[=:]\s*['"]?[A-Za-z0-9._\-]{8,}/gi },
];

function maskSecret(s) {
  // Keep first 4 chars of the whole matched token, mask the rest. Never emit raw secret.
  const str = String(s);
  if (str.length <= 4) return str[0] + '***';
  return str.slice(0, 4) + '*'.repeat(Math.min(str.length - 4, 12));
}

// ---------------------------------------------------------------------------
// Policy defaults (PhanesLight)
// ---------------------------------------------------------------------------
const DEFAULT_POLICY = {
  name: 'PhanesLight defaults',
  // Tools/servers the framework mandates be available and used.
  mandatedTools: [
    'mcp__semble__search',
    'mcp__semble__find_related',
  ],
  // MCP servers known to be configured/available; flagged if never called.
  configuredMcpServers: [
    'semble', 'serena', 'context7', 'deepwiki',
  ],
  // Regexes (as strings) matched against Bash command strings to detect
  // phanes CLI invocations. Counted as a synthetic tool "phanes-cli".
  phanesCliPatterns: [
    'phanes\\.cmd',
    '\\.phanes[\\\\/]scripts[\\\\/]cli\\.js',
    '\\bphanes\\s+(session-audit|update-run|init|status)\\b',
  ],
  // Effort-bridge (Phanes v3.2) CLI spawns, matched against Bash command
  // strings. detectEffortBridge additionally requires a per-agent/background
  // flag so an unrelated claude invocation cannot match.
  effortBridgePatterns: [
    '\\bclaude\\b[\\s\\S]*?--effort\\b',
  ],
  // Assumed session effort baseline when the Phanes config does not state one
  // (Phanes v3.2 launches high by default). Used by the effort-bridge check.
  effortBaseline: 'high',
};

function loadPolicy(policyPath, scriptDir) {
  const candidate = policyPath || path.join(scriptDir, 'policy.json');
  try {
    if (fs.existsSync(candidate)) {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      return { ...DEFAULT_POLICY, ...raw, _source: candidate };
    }
  } catch (e) {
    console.error(`[warn] failed to read policy ${candidate}: ${e.message}; using built-in defaults`);
  }
  return { ...DEFAULT_POLICY, _source: '(built-in defaults)' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function splitMcpName(name) {
  // mcp__<server>__<tool> ; server itself may contain single underscores,
  // segments are separated by double underscore. Everything after the 2nd
  // "__" is the tool (tools can also contain "__" in theory).
  const parts = name.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') return { server: '(unknown)', tool: name };
  return { server: parts[1], tool: parts.slice(2).join('__') };
}

function toText(content) {
  // tool_result / block content can be a string or an array of {type,text}.
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => {
      if (typeof c === 'string') return c;
      if (c && typeof c.text === 'string') return c.text;
      return '';
    }).join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function newAggregate(kind, id) {
  return {
    kind,                 // 'session' | 'agent'
    id,
    isSidechain: kind === 'agent',
    toolCounts: {},       // toolName -> count (MCP kept as full mcp__server__tool)
    mcpByServer: {},      // server -> { tool -> count }
    phanesCliCount: 0,
    models: {},           // model -> messageCount
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    messages: { user: 0, assistant: 0, total: 0 },
    firstTs: null,
    lastTs: null,
    spawnedAgents: 0,     // Task tool_use count
    spawnedAgentTypes: {},// subagent_type -> count
    toolResults: 0,
    toolResultErrors: 0,
    agentType: null,      // for agent aggregates, if discoverable
    parentSession: null,  // for agent aggregates
    maxTodoCount: 0,      // peak TodoWrite list length (plan-scale proxy)
    effortBridgeSpawns: [],// effort-bridge CLI spawns: { agent, level }
  };
}

function bumpTs(agg, ts) {
  if (!ts) return;
  if (!agg.firstTs || ts < agg.firstTs) agg.firstTs = ts;
  if (!agg.lastTs || ts > agg.lastTs) agg.lastTs = ts;
}

// ---------------------------------------------------------------------------
// Core: process one JSONL file. `route` decides which aggregate a record
// belongs to (main session vs a sidechain agent).
// ---------------------------------------------------------------------------
async function processFile(filePath, ctx, opts = {}) {
  const { policy, phanesRes, secretHits, uuidToAgent } = ctx;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { ctx.parseErrors++; continue; }

    // Resolve which aggregate this record belongs to.
    // Task-transcript files: route ALL records to one agent aggregate keyed by
    // the file's agentId (authoritative), even if a line omits agentId.
    const isSide = opts.forceAgentKey ? true : (o.isSidechain === true);
    let agg;
    if (isSide) {
      const agentKey = opts.forceAgentKey || o.agentId || (o.sessionId || ctx.currentSession) + ':sidechain';
      if (!ctx.agents[agentKey]) {
        ctx.agents[agentKey] = newAggregate('agent', agentKey);
        ctx.agents[agentKey].parentSession = o.sessionId || opts.parentSession || ctx.currentSession;
      }
      agg = ctx.agents[agentKey];
      if (!agg.parentSession) agg.parentSession = o.sessionId || opts.parentSession || ctx.currentSession;
    } else {
      const sid = o.sessionId || ctx.currentSession;
      if (!ctx.sessions[sid]) ctx.sessions[sid] = newAggregate('session', sid);
      agg = ctx.sessions[sid];
    }

    bumpTs(agg, o.timestamp);

    const type = o.type;
    if (type === 'user') { agg.messages.user++; agg.messages.total++; }
    else if (type === 'assistant') { agg.messages.assistant++; agg.messages.total++; }

    const m = o.message;
    if (!m) continue;

    // Model + usage (assistant messages)
    if (m.model) agg.models[m.model] = (agg.models[m.model] || 0) + 1;
    if (m.usage) {
      const u = m.usage;
      agg.usage.input       += u.input_tokens || 0;
      agg.usage.output      += u.output_tokens || 0;
      agg.usage.cacheRead   += u.cache_read_input_tokens || 0;
      agg.usage.cacheCreate += u.cache_creation_input_tokens || 0;
    }

    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || !b.type) continue;

      if (b.type === 'tool_use') {
        const name = b.name || '(unnamed)';
        agg.toolCounts[name] = (agg.toolCounts[name] || 0) + 1;

        // Subagent spawn: modern Claude Code uses the "Agent" tool; older
        // builds use "Task". Both carry input.subagent_type. TaskUpdate /
        // TaskStop manage running background agents and are NOT spawns.
        if (name === 'Agent' || name === 'Task') {
          agg.spawnedAgents++;
          const st = (b.input && b.input.subagent_type) || '(default)';
          agg.spawnedAgentTypes[st] = (agg.spawnedAgentTypes[st] || 0) + 1;
          // Record the intended agent type for correlation if a sidechain
          // later references this via parentUuid.
          if (b.id) uuidToAgent[b.id] = st;
        }

        if (name.startsWith('mcp__')) {
          const { server, tool } = splitMcpName(name);
          if (!agg.mcpByServer[server]) agg.mcpByServer[server] = {};
          agg.mcpByServer[server][tool] = (agg.mcpByServer[server][tool] || 0) + 1;
        }

        // TodoWrite: peak list length is a plan-scale proxy for the
        // orchestrator-engagement check.
        if (name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) {
          if (b.input.todos.length > agg.maxTodoCount) agg.maxTodoCount = b.input.todos.length;
        }

        if (name === 'Bash' && b.input && typeof b.input.command === 'string') {
          const cmd = b.input.command;
          for (const re of phanesRes) {
            re.lastIndex = 0;
            if (re.test(cmd)) { agg.phanesCliCount++; break; }
          }
          detectEffortBridge(cmd, agg, ctx.effortBridgeRes);
          scanSecrets(cmd, filePath, 'bash-command', secretHits);
        }
      }

      if (b.type === 'tool_result') {
        agg.toolResults++;
        const txt = toText(b.content);
        const errored = b.is_error === true || /<tool_use_error>/.test(txt);
        if (errored) agg.toolResultErrors++;
        scanSecrets(txt, filePath, 'tool-result', secretHits);
      }
    }
  }
}

// Detect an effort-bridge CLI spawn in an EXECUTED Bash command (Phanes v3.2):
// `claude ... --agent <name> --effort <level> ...` run in a background /
// non-interactive mode to lift one agent above the session baseline. Scanning
// only Bash tool_use command strings means prose that merely MENTIONS the
// bridge never matches; a match is an actual invocation. Records { agent, level }.
function detectEffortBridge(cmd, agg, effortBridgeRes) {
  if (!/\bclaude\b/.test(cmd) || !/--effort\b/.test(cmd)) return;
  // A real bridge spawn pairs --effort with a per-agent / background flag;
  // guard against matching an unrelated claude invocation.
  if (!/--(?:agent|bg|background)\b/.test(cmd)) return;
  if (effortBridgeRes && effortBridgeRes.length && !effortBridgeRes.some(re => { re.lastIndex = 0; return re.test(cmd); })) return;
  const am = cmd.match(/--agent[=\s]+["']?([A-Za-z0-9._-]+)/);
  const em = cmd.match(/--effort[=\s]+["']?([A-Za-z]+)/);
  agg.effortBridgeSpawns.push({
    agent: am ? am[1] : null,
    level: em ? em[1].toLowerCase() : null,
  });
}

// Secret scan over a text blob; records deduped, redacted hits.
function scanSecrets(text, filePath, where, secretHits) {
  if (!text) return;
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    let match;
    while ((match = p.re.exec(text)) !== null) {
      const token = match[0];
      const key = p.type + '|' + maskSecret(token);
      if (!secretHits.map.has(key)) {
        secretHits.map.set(key, {
          type: p.type,
          masked: maskSecret(token),
          file: path.basename(filePath),
          where,
          count: 0,
        });
      }
      secretHits.map.get(key).count++;
      if (match.index === p.re.lastIndex) p.re.lastIndex++; // avoid zero-width loop
    }
  }
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------
function fmtNum(n) { return (n || 0).toLocaleString('en-US'); }

function adherenceFlags(ctx) {
  const { policy } = ctx;
  // Gather every tool name and mcp server actually observed across all aggregates.
  const usedTools = new Set();
  const usedServers = new Set();
  for (const agg of [...Object.values(ctx.sessions), ...Object.values(ctx.agents)]) {
    for (const t of Object.keys(agg.toolCounts)) usedTools.add(t);
    for (const s of Object.keys(agg.mcpByServer)) usedServers.add(s);
  }
  const mandatedNeverUsed = (policy.mandatedTools || []).filter(t => !usedTools.has(t));
  const configuredNeverCalled = (policy.configuredMcpServers || []).filter(s => !usedServers.has(s));
  return { usedTools, usedServers, mandatedNeverUsed, configuredNeverCalled };
}

function tokenEconomics(ctx) {
  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0;
  const perAgentRole = {};
  for (const agg of [...Object.values(ctx.sessions), ...Object.values(ctx.agents)]) {
    input += agg.usage.input; output += agg.usage.output;
    cacheRead += agg.usage.cacheRead; cacheCreate += agg.usage.cacheCreate;
    const role = agg.kind === 'agent' ? (agg.agentType || 'subagent') : 'main-session';
    if (!perAgentRole[role]) perAgentRole[role] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    perAgentRole[role].input += agg.usage.input;
    perAgentRole[role].output += agg.usage.output;
    perAgentRole[role].cacheRead += agg.usage.cacheRead;
    perAgentRole[role].cacheCreate += agg.usage.cacheCreate;
  }
  return { input, output, cacheRead, cacheCreate, perAgentRole };
}

function topTools(agg, n = 8) {
  return Object.entries(agg.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}×${v}`)
    .join(', ') || '(none)';
}

// Render the condition-aware adherence section. Each block states its
// precondition, stays silent (applicable:false) when nothing called for the
// tool, and marks every finding advisory. Ground truth for what ran is the
// transcript; what SHOULD have run comes from the Phanes context.
function renderAdherence(ctx, L) {
  L.push(`## 3a. Conditional Tool Adherence (effort bridge, orchestrator)`);
  L.push('');
  const ad = ctx.adherence;
  if (!ad) {
    L.push(`_Not evaluated: no \`--project\` was given, so the Phanes context (roster, thresholds, effort baseline) could not be read. Re-run with \`--project <root>\` to enable these checks._`);
    L.push('');
    return;
  }
  const c = ad.context || {};
  L.push(`Context: mode \`${c.mode || '?'}\`, effort baseline \`${c.baseline || '?'}\`, orchestrator threshold ${c.threshold ?? '?'}, orchestrator archetype ${c.orchestrator ? '`' + c.orchestrator + '`' : '(none in roster)'}. Findings are advisory: a tool absent when its precondition was also absent is correct, not a miss.`);
  L.push('');

  const block = (title, res) => {
    L.push(`### ${title}`);
    if (!res || res.applicable === false) {
      L.push(`- Not applicable: ${res ? res.reason : 'no data'}`);
      L.push('');
      return;
    }
    if (res.findings && res.findings.length) {
      for (const f of res.findings) {
        L.push(`- **[${f.severity}] ${f.code}** ${f.message}`);
        if (f.evidence) L.push(`  - Evidence: ${f.evidence}`);
      }
    } else {
      L.push(`- No mismatch: every precondition that fired was matched by correct use.`);
    }
    if (res.confirmations && res.confirmations.length) {
      for (const cf of res.confirmations) L.push(`  - Confirmed: ${cf}`);
    }
    L.push('');
  };

  block('Effort bridge', ad.effortBridge);
  block('Orchestrator engagement', ad.orchestrator);
  if (ad.orchestrator && ad.orchestrator.applicable && ad.orchestrator.phanesPlanEvidence) {
    const pe = ad.orchestrator.phanesPlanEvidence;
    L.push(`_Phanes plan corroboration: ${pe.summaryCount} session-summary file(s), largest recovered batch ${pe.maxSteps} step(s). Plan scale in the per-session check is a transcript proxy (peak todos vs direct worker spawns)._`);
    L.push('');
  }
}

function renderMarkdown(ctx) {
  const { policy } = ctx;
  const flags = adherenceFlags(ctx);
  const econ = tokenEconomics(ctx);
  const sessions = Object.values(ctx.sessions).sort((a, b) => (a.firstTs || '').localeCompare(b.firstTs || ''));
  const agents = Object.values(ctx.agents);

  const L = [];
  L.push(`# Session Audit Report`);
  L.push('');
  L.push(`- Generated: ${new Date().toISOString()}`);
  L.push(`- Transcript dir: \`${ctx.dir}\``);
  L.push(`- Policy: ${policy.name}, source \`${policy._source}\``);
  L.push(`- Main JSONL files audited: ${ctx.filesAudited} (main sessions: ${sessions.length})`);
  if (ctx.tasksDir) {
    const tc = ctx.taskCounts || {};
    L.push(`- Task store: \`${ctx.tasksDir}\``);
    L.push(`- Subagent transcripts ingested: ${agents.length} (from ${tc.transcripts || 0} non-empty transcript file(s); ${tc.rawOutputs || 0} raw bg-output(s) secret-scanned; ${tc.empties || 0} empty/evicted file(s) skipped across ${tc.sessions || 0} session dir(s))`);
  } else {
    L.push(`- Task store: not ingested (subagent transcripts absent from this report)`);
  }
  if (ctx.harvestStats) {
    const h = ctx.harvestStats;
    L.push(`- Harvest: ${h.copied} file(s) copied (${(h.bytes / 1048576).toFixed(1)} MB), ${h.skipped} already-archived skipped, across ${h.sessions} session(s) → \`${ctx.harvestDest}\``);
  }
  if (ctx.parseErrors) L.push(`- Unparseable lines skipped: ${ctx.parseErrors}`);
  L.push('');

  // --- Session overview ---
  L.push(`## 1. Session Overview`);
  L.push('');
  L.push(`| Session | Msgs (u/a) | Tools | Subagent spawns | MCP servers | Models | Errors | Window |`);
  L.push(`|---|---|---|---|---|---|---|---|`);
  for (const s of sessions) {
    const nTools = Object.values(s.toolCounts).reduce((a, b) => a + b, 0);
    const servers = Object.keys(s.mcpByServer).join(',') || '-';
    const models = Object.keys(s.models).join(',') || '-';
    const win = `${(s.firstTs || '').slice(0, 16)} → ${(s.lastTs || '').slice(11, 16)}`;
    L.push(`| ${s.id.slice(0, 8)} | ${s.messages.user}/${s.messages.assistant} | ${nTools} | ${s.spawnedAgents} | ${servers} | ${models} | ${s.toolResultErrors} | ${win} |`);
  }
  L.push('');

  // --- Main-session per-actor table ---
  L.push(`## 2. Main Sessions: Per-Actor Breakdown`);
  L.push('');
  L.push(`| Session | Top tools used | MCP servers×calls | phanes-cli | in/out tok | cacheR/W tok | Models |`);
  L.push(`|---|---|---|---|---|---|---|`);
  for (const a of sessions) {
    const mcp = Object.entries(a.mcpByServer)
      .map(([srv, tools]) => `${srv}(${Object.values(tools).reduce((x, y) => x + y, 0)})`)
      .join(', ') || '-';
    const models = Object.keys(a.models).join(',') || '-';
    L.push(`| ${a.id.slice(0, 8)} | ${topTools(a, 6)} | ${mcp} | ${a.phanesCliCount} | ${fmtNum(a.usage.input)}/${fmtNum(a.usage.output)} | ${fmtNum(a.usage.cacheRead)}/${fmtNum(a.usage.cacheCreate)} | ${models} |`);
  }
  L.push('');

  // --- Subagent behaviour by type (condensed) ---
  const byType = {}; // subagentType -> aggregate rollup
  for (const a of agents) {
    const t = a.agentType || '(unlabeled)';
    if (!byType[t]) byType[t] = { type: t, n: 0, toolCounts: {}, mcpByServer: {}, models: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, errors: 0 };
    const g = byType[t];
    g.n++;
    for (const [k, v] of Object.entries(a.toolCounts)) g.toolCounts[k] = (g.toolCounts[k] || 0) + v;
    for (const [srv, tools] of Object.entries(a.mcpByServer)) {
      g.mcpByServer[srv] = g.mcpByServer[srv] || {};
      for (const [t2, c] of Object.entries(tools)) g.mcpByServer[srv][t2] = (g.mcpByServer[srv][t2] || 0) + c;
    }
    for (const [mk, mv] of Object.entries(a.models)) g.models[mk] = (g.models[mk] || 0) + mv;
    g.usage.input += a.usage.input; g.usage.output += a.usage.output;
    g.usage.cacheRead += a.usage.cacheRead; g.usage.cacheCreate += a.usage.cacheCreate;
    g.errors += a.toolResultErrors;
  }
  const byTypeRows = Object.values(byType).sort((a, b) => b.n - a.n);

  L.push(`## 2a. Subagent Behaviour by Type (from Temp task store)`);
  L.push('');
  if (!agents.length) {
    L.push(`_No subagent transcripts ingested._`);
  } else {
    L.push(`Rolled up across ${agents.length} subagent transcript(s). Tokens are per-role sums.`);
    L.push('');
    L.push(`| Subagent type | # | Top tools | MCP servers×calls | Models | in/out tok | cacheR/W tok | tool errors |`);
    L.push(`|---|---|---|---|---|---|---|---|`);
    for (const g of byTypeRows) {
      const tools = Object.entries(g.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(', ') || '(none)';
      const mcp = Object.entries(g.mcpByServer).map(([srv, ts]) => `${srv}×${Object.values(ts).reduce((x, y) => x + y, 0)}`).join(', ') || '-';
      const models = Object.keys(g.models).join(',') || '-';
      L.push(`| ${g.type} | ${g.n} | ${tools} | ${mcp} | ${models} | ${fmtNum(g.usage.input)}/${fmtNum(g.usage.output)} | ${fmtNum(g.usage.cacheRead)}/${fmtNum(g.usage.cacheCreate)} | ${g.errors} |`);
    }
  }
  L.push('');

  // --- MCP detail per actor (surface hidden subagent MCP usage) ---
  const allActors = [...sessions, ...agents];
  L.push(`### 2b. MCP tool calls by actor (server, tool, count): the hidden-usage surface`);
  L.push('');
  let anyMcp = false;
  for (const a of allActors) {
    const servers = Object.keys(a.mcpByServer);
    if (!servers.length) continue;
    anyMcp = true;
    const role = a.kind === 'agent' ? (a.agentType || 'subagent') : 'main';
    L.push(`- **${a.id.slice(0, 8)}** (${role}${a.parentSession ? ', parent ' + a.parentSession.slice(0, 8) : ''}):`);
    for (const srv of servers) {
      const tools = Object.entries(a.mcpByServer[srv]).map(([t, c]) => `${t}×${c}`).join(', ');
      L.push(`  - \`${srv}\`: ${tools}`);
    }
  }
  if (!anyMcp) L.push(`_No MCP tool calls recorded in any audited actor._`);
  L.push('');

  // --- Adherence flags ---
  L.push(`## 3. Adherence Flags`);
  L.push('');
  L.push(`**Mandated tools never used** (policy → not seen in any transcript):`);
  if (flags.mandatedNeverUsed.length) {
    for (const t of flags.mandatedNeverUsed) L.push(`- \`${t}\``);
  } else L.push(`- (none, all mandated tools were used)`);
  L.push('');
  L.push(`**Configured MCP servers never called** (declared available, zero calls):`);
  if (flags.configuredNeverCalled.length) {
    for (const s of flags.configuredNeverCalled) L.push(`- \`${s}\``);
  } else L.push(`- (none, every configured server was called at least once)`);
  L.push('');
  L.push(`**MCP servers actually observed:** ${[...flags.usedServers].join(', ') || '(none)'}`);
  L.push('');

  // Headline: did ANY actor call the mandated/expected research servers?
  // Matches server names case-insensitively (e.g. claude_ai_Context7 -> context7).
  const targets = (policy.configuredMcpServers && policy.configuredMcpServers.length)
    ? policy.configuredMcpServers : ['semble', 'serena', 'context7', 'deepwiki'];
  const targetTally = {};
  for (const t of targets) targetTally[t] = { main: 0, sub: 0, byWho: {} };
  for (const a of allActors) {
    const isSub = a.kind === 'agent';
    for (const [srv, tools] of Object.entries(a.mcpByServer)) {
      const calls = Object.values(tools).reduce((x, y) => x + y, 0);
      for (const t of targets) {
        if (new RegExp(t, 'i').test(srv)) {
          if (isSub) targetTally[t].sub += calls; else targetTally[t].main += calls;
          const who = isSub ? (a.agentType || 'subagent') : 'main-session';
          targetTally[t].byWho[who] = (targetTally[t].byWho[who] || 0) + calls;
        }
      }
    }
  }
  L.push(`**Key question: did any actor (main OR subagent) call the expected research servers?**`);
  L.push('');
  L.push(`| Server | Main calls | Subagent calls | Total | Who |`);
  L.push(`|---|---|---|---|---|`);
  for (const t of targets) {
    const v = targetTally[t];
    const total = v.main + v.sub;
    const who = Object.entries(v.byWho).map(([w, c]) => `${w}×${c}`).join(', ') || '-';
    L.push(`| \`${t}\` | ${v.main} | ${v.sub} | ${total} | ${who} |`);
  }
  L.push('');

  const totalTask = allActors.reduce((n, a) => n + a.spawnedAgents, 0);
  L.push(`**Subagent orchestration:** ${totalTask} subagent spawn(s) (Agent/Task tool) across all actors; ${agents.length} sidechain agent transcript(s) found on disk.`);
  // Aggregate spawned agent types across actors.
  const spawnRoles = {};
  for (const a of allActors) for (const [st, c] of Object.entries(a.spawnedAgentTypes)) spawnRoles[st] = (spawnRoles[st] || 0) + c;
  const spawnList = Object.entries(spawnRoles).sort((a, b) => b[1] - a[1]);
  if (spawnList.length) {
    L.push('');
    L.push(`Spawned subagent types (from Agent/Task \`subagent_type\`):`);
    for (const [st, c] of spawnList) L.push(`- \`${st}\` ×${c}`);
  }
  if (agents.length > 0) {
    L.push('');
    L.push(`- Note: subagent transcripts were recovered from the volatile Temp task store. Subagent tool use (incl. MCP) is INVISIBLE at the main-session level -- MCP calls made inside a subagent appear only in that subagent's own transcript, never in the parent session. The task store is ephemeral; use \`--harvest\` to preserve it.`);
  } else if (totalTask > 0 && agents.length === 0) {
    L.push('');
    L.push(`- Note: ${totalTask} subagent(s) were spawned but 0 transcripts were ingested. If the Temp task store was evicted, run with \`--tasks-dir\`/\`--harvest\` sooner; subagent INTERNAL tool use is otherwise unauditable.`);
  }
  if (totalTask === 0 && agents.length === 0) {
    L.push('');
    L.push(`- Note: no subagents were spawned. If the framework mandates delegation, this is a non-adherence signal.`);
  }
  L.push('');

  // --- Conditional adherence (effort bridge, orchestrator) ---
  renderAdherence(ctx, L);

  // --- Secret findings (redacted) ---
  L.push(`## 4. Secret Scan (redacted)`);
  L.push('');
  const hits = [...ctx.secretHits.map.values()].sort((a, b) => b.count - a.count);
  if (!hits.length) {
    L.push(`No secrets matched the scan patterns in Bash commands or tool results.`);
  } else {
    L.push(`Location + pattern type only. Values masked (first 4 chars kept). Raw secrets are never emitted.`);
    L.push('');
    L.push(`| Pattern type | Masked | Where | File | Occurrences |`);
    L.push(`|---|---|---|---|---|`);
    for (const h of hits) L.push(`| ${h.type} | \`${h.masked}\` | ${h.where} | ${h.file} | ${h.count} |`);
  }
  L.push('');

  // --- Token economics ---
  L.push(`## 5. Token Economics Summary`);
  L.push('');
  const totalTok = econ.input + econ.output + econ.cacheRead + econ.cacheCreate;
  L.push(`| Metric | Tokens |`);
  L.push(`|---|---|`);
  L.push(`| Input (uncached) | ${fmtNum(econ.input)} |`);
  L.push(`| Output | ${fmtNum(econ.output)} |`);
  L.push(`| Cache read | ${fmtNum(econ.cacheRead)} |`);
  L.push(`| Cache create | ${fmtNum(econ.cacheCreate)} |`);
  L.push(`| **Total accounted** | **${fmtNum(totalTok)}** |`);
  L.push('');
  L.push(`**By actor role:**`);
  L.push('');
  L.push(`| Role | Input | Output | Cache read | Cache create |`);
  L.push(`|---|---|---|---|---|`);
  for (const [role, t] of Object.entries(econ.perAgentRole)) {
    L.push(`| ${role} | ${fmtNum(t.input)} | ${fmtNum(t.output)} | ${fmtNum(t.cacheRead)} | ${fmtNum(t.cacheCreate)} |`);
  }
  L.push('');
  L.push(`_Report contains aggregates only; no raw transcript content is included._`);
  L.push('');
  return L.join('\n');
}

function buildJson(ctx) {
  const flags = adherenceFlags(ctx);
  const econ = tokenEconomics(ctx);
  const serialActor = (a) => ({
    id: a.id, kind: a.kind, role: a.kind === 'agent' ? (a.agentType || 'subagent') : 'main',
    isSidechain: a.isSidechain, parentSession: a.parentSession,
    messages: a.messages, models: a.models, usage: a.usage,
    toolCounts: a.toolCounts, mcpByServer: a.mcpByServer,
    phanesCliCount: a.phanesCliCount, spawnedAgents: a.spawnedAgents,
    spawnedAgentTypes: a.spawnedAgentTypes,
    maxTodoCount: a.maxTodoCount, effortBridgeSpawns: a.effortBridgeSpawns,
    toolResults: a.toolResults, toolResultErrors: a.toolResultErrors,
    firstTs: a.firstTs, lastTs: a.lastTs,
  });
  return {
    generatedAt: new Date().toISOString(),
    dir: ctx.dir,
    policy: { name: ctx.policy.name, source: ctx.policy._source, mandatedTools: ctx.policy.mandatedTools, configuredMcpServers: ctx.policy.configuredMcpServers },
    filesAudited: ctx.filesAudited,
    parseErrors: ctx.parseErrors,
    tasksDir: ctx.tasksDir || null,
    taskCounts: ctx.taskCounts || null,
    harvest: ctx.harvestStats ? { ...ctx.harvestStats, dest: ctx.harvestDest } : null,
    sessions: Object.values(ctx.sessions).map(serialActor),
    agents: Object.values(ctx.agents).map(serialActor),
    adherence: {
      mandatedNeverUsed: flags.mandatedNeverUsed,
      configuredNeverCalled: flags.configuredNeverCalled,
      mcpServersObserved: [...flags.usedServers],
    },
    conditionalAdherence: ctx.adherence || null,
    tokenEconomics: econ,
    secretFindings: [...ctx.secretHits.map.values()], // already redacted
  };
}

// ---------------------------------------------------------------------------
// v0.1 -- Temp task store (subagent transcripts) ingestion
// ---------------------------------------------------------------------------

// Derive the Temp task store root for a given transcript --dir. Claude Code
// stores volatile subagent transcripts at
//   %LOCALAPPDATA%\Temp\claude\<encoded-project>\<session-uuid>\tasks\<taskId>.output
// where <encoded-project> is the SAME encoded name as the projects dir.
function deriveTasksDir(dir) {
  const encodedProject = path.basename(dir);
  const localAppData = process.env.LOCALAPPDATA
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : null);
  const candidates = [];
  if (localAppData) candidates.push(path.join(localAppData, 'Temp', 'claude', encodedProject));
  if (process.env.TEMP) candidates.push(path.join(process.env.TEMP, 'claude', encodedProject));
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return candidates[0] || null;
}

// A task id that is a long hex string is a subagent JSONL transcript; short
// base36-ish ids (e.g. "bjyvo7g3h") are raw background-command output captures.
function looksLikeTranscriptId(id) { return /^[a-f0-9]{16,}$/i.test(id); }

// Sniff whether a .output file is a JSONL transcript (vs raw bg-command text).
// The first JSONL record (a user prompt) can exceed any fixed read size, so we
// do NOT try to parse a whole line -- we check that the file begins with a JSON
// object carrying a known transcript key. Raw outputs begin with plain text.
function sniffIsTranscript(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    const head = buf.slice(0, n).toString('utf8').replace(/^﻿/, '').trimStart();
    if (head[0] !== '{') return false;
    return /"(parentUuid|isSidechain|sessionId|agentId|promptId)"\s*:/.test(head);
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Build a global agentId -> {subagentType, parentSession} map by scanning every
// main-session JSONL for Agent/Task tool_use + their tool_result (which carries
// "agentId: <id>"). This lets us label task transcripts by their role even when
// the parent session is outside the --last window.
async function buildAgentTypeMap(dir) {
  const map = {};
  const mains = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
  for (const f of mains) {
    const pending = {}; // toolu id -> subagent_type
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, f)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const m = o.message; if (!m || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) {
          pending[b.id] = (b.input && b.input.subagent_type) || '(default)';
        }
        if (b.type === 'tool_result' && pending[b.tool_use_id]) {
          const txt = toText(b.content);
          const mm = txt.match(/agentId:\s*([A-Za-z0-9]{8,})/);
          if (mm) map[mm[1]] = { subagentType: pending[b.tool_use_id], parentSession: f.replace(/\.jsonl$/, '') };
        }
      }
    }
  }
  return map;
}

// Secret-scan a raw (non-JSONL) task output file as a plain-text blob.
function scanRawTaskFile(filePath, ctx) {
  let text = '';
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return; }
  scanSecrets(text, filePath, 'task-raw-output', ctx.secretHits);
}

// Idempotent harvest: copy every <session>/tasks/*.output into
//   <destDir>/<encoded-project>/<session-uuid>/<taskId>.output
// Skips files already present with identical size. Flag-gated; volatile Temp is
// the reason this exists.
function harvestTasks(tasksDir, destDir) {
  const encodedProject = path.basename(tasksDir);
  const stats = { copied: 0, skipped: 0, bytes: 0, sessions: 0, empties: 0 };
  let sessionDirs = [];
  try { sessionDirs = fs.readdirSync(tasksDir).filter(d => fs.statSync(path.join(tasksDir, d)).isDirectory()); }
  catch { return stats; }
  for (const sd of sessionDirs) {
    const td = path.join(tasksDir, sd, 'tasks');
    if (!fs.existsSync(td)) continue;
    const outs = fs.readdirSync(td).filter(f => f.endsWith('.output'));
    if (!outs.length) continue;
    stats.sessions++;
    const destSession = path.join(destDir, encodedProject, sd);
    fs.mkdirSync(destSession, { recursive: true });
    for (const f of outs) {
      const src = path.join(td, f);
      const dst = path.join(destSession, f);
      const srcSize = fs.statSync(src).size;
      if (srcSize === 0) { stats.empties++; }
      if (fs.existsSync(dst) && fs.statSync(dst).size === srcSize) { stats.skipped++; continue; }
      fs.copyFileSync(src, dst);
      stats.copied++; stats.bytes += srcSize;
    }
  }
  return stats;
}

// Ingest all subagent transcripts (and secret-scan raw outputs) from the task
// store. Returns counts. Agent aggregates are labelled from agentTypeMap.
async function ingestTaskStore(tasksDir, ctx, agentTypeMap) {
  const counts = { transcripts: 0, rawOutputs: 0, empties: 0, sessions: 0, bytes: 0 };
  let sessionDirs = [];
  try { sessionDirs = fs.readdirSync(tasksDir).filter(d => fs.statSync(path.join(tasksDir, d)).isDirectory()); }
  catch { return counts; }
  for (const sd of sessionDirs) {
    const td = path.join(tasksDir, sd, 'tasks');
    if (!fs.existsSync(td)) continue;
    const outs = fs.readdirSync(td).filter(f => f.endsWith('.output'));
    if (!outs.length) continue;
    counts.sessions++;
    for (const f of outs) {
      const fp = path.join(td, f);
      const size = fs.statSync(fp).size;
      if (size === 0) { counts.empties++; continue; }
      counts.bytes += size;
      const id = f.replace(/\.output$/, '');
      // Content sniff is authoritative -- task ids vary in length (~10-17 chars)
      // so id shape alone is an unreliable gate.
      if (sniffIsTranscript(fp)) {
        counts.transcripts++;
        await processFile(fp, ctx, { forceAgentKey: id, parentSession: sd, isTaskFile: true });
        const agg = ctx.agents[id];
        if (agg) {
          const info = agentTypeMap[id];
          if (info) { agg.agentType = info.subagentType; if (!agg.parentSession) agg.parentSession = info.parentSession; }
          else if (!agg.agentType) agg.agentType = '(unlabeled)';
          if (!agg.parentSession) agg.parentSession = sd;
          agg.fromTaskStore = true;
        }
      } else {
        counts.rawOutputs++;
        scanRawTaskFile(fp, ctx); // still hunt secrets in raw bg output
      }
    }
  }
  return counts;
}

// Ingest durable subagent transcripts from the current Claude Code layout:
//   <dir>/<session-uuid>/subagents/agent-<id>.jsonl
// Each file is a sidechain transcript keyed by the agent id in its filename.
// Labelled from agentTypeMap where possible. Idempotent per run; skips empty
// files and the sibling .meta.json descriptors.
async function ingestSubagentDirs(dir, ctx, agentTypeMap) {
  const counts = { transcripts: 0, empties: 0, sessions: 0 };
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return counts; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const subDir = path.join(dir, e.name, 'subagents');
    if (!fs.existsSync(subDir)) continue;
    let files = [];
    try { files = fs.readdirSync(subDir).filter(f => f.startsWith('agent-') && f.endsWith('.jsonl')); } catch { continue; }
    if (!files.length) continue;
    counts.sessions++;
    for (const f of files) {
      const fp = path.join(subDir, f);
      let size = 0; try { size = fs.statSync(fp).size; } catch { continue; }
      if (size === 0) { counts.empties++; continue; }
      const id = f.replace(/\.jsonl$/, '').replace(/^agent-/, '');
      // Skip if this agent id was already ingested (e.g. an inline agent-*.jsonl
      // at the top level, or the Temp store) to avoid double counting.
      if (ctx.agents[id]) continue;
      counts.transcripts++;
      await processFile(fp, ctx, { forceAgentKey: id, parentSession: e.name, isTaskFile: true });
      const agg = ctx.agents[id];
      if (agg) {
        const info = agentTypeMap[id];
        if (info) { agg.agentType = info.subagentType; if (!agg.parentSession) agg.parentSession = info.parentSession; }
        else if (!agg.agentType) agg.agentType = '(unlabeled)';
        if (!agg.parentSession) agg.parentSession = e.name;
        agg.fromSubagentDir = true;
      }
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); process.exit(0); }
  if (!args.dir) { console.log(HELP); process.exit(1); }

  const dir = path.resolve(args.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`[error] --dir not found or not a directory: ${dir}`);
    process.exit(1);
  }
  const outDir = path.resolve(args.out || path.join(scriptDir, 'reports'));
  fs.mkdirSync(outDir, { recursive: true });

  // Policy resolution: an explicit --policy always wins. Otherwise, if a
  // --project root is given, derive the policy generically (Phanes config or
  // inferred from detection). Absent both, fall back to ./policy.json or the
  // built-in defaults (v0.1 behaviour).
  const policy = (!args.policy && args.project)
    ? derivePolicy(args.project)
    : loadPolicy(args.policy, scriptDir);
  const phanesRes = (policy.phanesCliPatterns || []).map(p => new RegExp(p, 'g'));
  const effortBridgeRes = (policy.effortBridgePatterns || []).map(p => new RegExp(p, 'i'));

  // Identify main session files vs sidechain agent files.
  const all = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  const agentFiles = all.filter(f => f.startsWith('agent-'));
  let mainFiles = all.filter(f => !f.startsWith('agent-'));

  // Sort main sessions by mtime desc, apply --last.
  mainFiles = mainFiles
    .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(x => x.f);
  const selectedMain = args.last > 0 ? mainFiles.slice(0, args.last) : mainFiles;

  // Correlate: only include agent-*.jsonl sidechains whose id relates to a
  // selected session is not derivable from filename alone, so include all
  // agent files (they self-tag with sessionId/agentId).
  const filesToProcess = [
    ...selectedMain.map(f => path.join(dir, f)),
    ...agentFiles.map(f => path.join(dir, f)),
  ];

  const ctx = {
    dir, policy, phanesRes, effortBridgeRes,
    sessions: {}, agents: {},
    secretHits: { map: new Map() },
    uuidToAgent: {},
    parseErrors: 0,
    filesAudited: 0,
    currentSession: null,
    tasksDir: null,
    taskCounts: null,
    subagentDirCounts: null,
    harvestStats: null,
    adherence: null,
  };

  for (const fp of filesToProcess) {
    ctx.currentSession = path.basename(fp).replace(/\.jsonl$/, '').replace(/^agent-/, '');
    await processFile(fp, ctx);
    ctx.filesAudited++;
  }

  // Correlate task/subagent transcripts to their subagent_type via all main
  // sessions. Built once and reused by both durable and Temp ingestion.
  const agentTypeMap = await buildAgentTypeMap(dir);

  // --- v0.4: durable subagent transcripts (current Claude Code layout) ---
  // Modern builds write subagent transcripts to
  // <dir>/<session-uuid>/subagents/agent-<id>.jsonl (durable, alongside the
  // volatile Temp store). Always ingested: this is where an orchestrator's own
  // batch behaviour and any in-subagent tool use are visible.
  ctx.subagentDirCounts = await ingestSubagentDirs(dir, ctx, agentTypeMap);
  if (ctx.subagentDirCounts.transcripts) {
    console.log(`[subagents] ingested ${ctx.subagentDirCounts.transcripts} durable subagent transcript(s) across ${ctx.subagentDirCounts.sessions} session dir(s)`);
  }

  // --- v0.1: Temp task store (subagent transcripts) ---
  if (!args.noTasks) {
    const tasksDir = args.tasksDir ? path.resolve(args.tasksDir) : deriveTasksDir(dir);
    if (tasksDir && fs.existsSync(tasksDir)) {
      ctx.tasksDir = tasksDir;

      // Optional durable harvest BEFORE auditing (Temp is volatile).
      if (args.harvest) {
        const destDir = path.resolve(args.harvest);
        ctx.harvestStats = harvestTasks(tasksDir, destDir);
        ctx.harvestDest = destDir;
        console.log(`[harvest] ${ctx.harvestStats.copied} copied, ${ctx.harvestStats.skipped} skipped (already archived), ${(ctx.harvestStats.bytes / 1048576).toFixed(1)} MB, ${ctx.harvestStats.sessions} session(s) -> ${path.join(destDir, path.basename(tasksDir))}`);
      }

      ctx.taskCounts = await ingestTaskStore(tasksDir, ctx, agentTypeMap);
      console.log(`[tasks] ingested ${ctx.taskCounts.transcripts} subagent transcript(s), scanned ${ctx.taskCounts.rawOutputs} raw output(s), skipped ${ctx.taskCounts.empties} empty file(s) across ${ctx.taskCounts.sessions} session dir(s)`);
    } else {
      console.error(`[tasks] task store not found (looked at ${tasksDir}); run with --tasks-dir or --no-tasks`);
    }
  }

  // Best-effort: annotate any remaining agent aggregates from the parent's
  // Task/Agent tool_use ids (in-file linkage), if present.
  for (const agg of Object.values(ctx.agents)) {
    if (!agg.agentType && ctx.uuidToAgent[agg.id]) agg.agentType = ctx.uuidToAgent[agg.id];
  }

  // --- v0.4: condition-aware adherence (effort bridge, orchestrator) ---
  // Reasons about whether two CONDITIONAL Phanes tools were used when their
  // precondition was present. Best effort: any failure leaves adherence null
  // and the rest of the report intact.
  try {
    const project = args.project ? path.resolve(args.project) : null;
    if (project) {
      const phanes = buildPhanesContext(project);
      const actors = [...Object.values(ctx.sessions), ...Object.values(ctx.agents)];
      ctx.adherence = { ...computeAdherence(actors, phanes), context: { mode: phanes.mode, threshold: phanes.threshold, baseline: phanes.baseline, orchestrator: phanes.orchestrator ? phanes.orchestrator.name : null } };
    }
  } catch (e) {
    console.error(`[adherence] skipped: ${e && e.message ? e.message : e}`);
  }

  const md = renderMarkdown(ctx);
  const json = buildJson(ctx);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '') + '-' + process.pid;
  const mdPath = path.join(outDir, `session-audit-${stamp}.md`);
  const jsonPath = path.join(outDir, `session-audit-${stamp}.json`);
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), 'utf8');

  console.log(`[ok] audited ${ctx.filesAudited} main JSONL file(s): ${selectedMain.length} main session(s), ${agentFiles.length} inline agent file(s)`);
  console.log(`[ok] main sessions: ${Object.keys(ctx.sessions).length}, subagent actors: ${Object.keys(ctx.agents).length}`);
  console.log(`[ok] markdown: ${mdPath}`);
  console.log(`[ok] json:     ${jsonPath}`);
}

main().catch(e => { console.error('[fatal]', e); process.exit(1); });
