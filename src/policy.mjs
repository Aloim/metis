#!/usr/bin/env node
// policy.mjs  --  Metis genericized policy derivation (v0.2)
//
// Turns "what should this setup be using" into a policy object the audit engine
// consumes, WITHOUT hardcoding any external tool name. Two paths:
//
//   Phanes mode (.phanes/ present): read .phanes/config.json. The consented
//   selection[] (reachable, selected MCP servers) becomes the configured set;
//   granted[] MCP servers become the stronger "granted, so expected to be used"
//   set. Only the built-in Phanes standard names ever appear from code.
//
//   Standalone mode: infer purely from detection (.mcp.json project + user,
//   settings enabledPlugins, .claude/agents). Nothing is assumed; every
//   reachable detected server is "configured", and never-called among them is
//   an advisory finding, never a hard mandate.
//
// mandatedTools stays empty unless the project's own config carries an explicit
// policy.mandatedTools list, because Metis has no license to invent a mandate.

import fs from 'node:fs';
import path from 'node:path';
import { census, detectMode } from './census.mjs';

// The Phanes CLI is detected by command-string pattern, harmless off-Phanes.
const PHANES_CLI_PATTERNS = [
  'phanes\\.cmd',
  '\\.phanes[\\\\/]scripts[\\\\/]cli\\.js',
  '\\bphanes\\s+(session-audit|update-run|init|status)\\b',
];

function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

// Derive a policy for a project. `opts.probe` (default false here: derivation
// should be cheap and never block) controls the live reachability probe.
export function derivePolicy(projectPath, opts = {}) {
  const project = path.resolve(projectPath);
  const mode = opts.mode || detectMode(project);

  if (mode === 'phanes') {
    const cfg = readJsonSafe(path.join(project, '.phanes', 'config.json')) || {};
    const caps = cfg.capabilities || {};
    const selection = Array.isArray(caps.selection) ? caps.selection : [];
    const granted = Array.isArray(caps.granted) ? caps.granted : [];
    const configuredMcpServers = selection
      .filter(s => s.type === 'mcp' && s.selected && s.authOk !== false)
      .map(s => s.name);
    const grantedServers = granted.filter(g => g.type === 'mcp').map(g => g.name);
    const explicitMandated = (cfg.policy && Array.isArray(cfg.policy.mandatedTools)) ? cfg.policy.mandatedTools : [];
    return {
      name: 'Phanes (derived from .phanes/config.json)',
      mode,
      mandatedTools: explicitMandated,
      configuredMcpServers: [...new Set(configuredMcpServers)],
      grantedServers: [...new Set(grantedServers)],
      phanesCliPatterns: PHANES_CLI_PATTERNS,
      _selection: selection,
      _source: path.join(project, '.phanes', 'config.json'),
    };
  }

  // Standalone: infer from detection only.
  const c = census(project, { mode, probe: opts.probe === true });
  const configuredMcpServers = c.detected
    .filter(x => x.type === 'mcp' && x.authOk !== false)
    .map(x => x.name);
  return {
    name: 'Inferred (standalone: .mcp.json / settings / agents)',
    mode,
    mandatedTools: [],
    configuredMcpServers: [...new Set(configuredMcpServers)],
    grantedServers: [],
    phanesCliPatterns: PHANES_CLI_PATTERNS,
    _source: '(inferred from detection)',
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function runCli(argv) {
  let project = process.cwd(), json = false, probe = false, help = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--project') project = argv[++i];
    else if (t === '--json') json = true;
    else if (t === '--probe') probe = true;
    else if (t === '-h' || t === '--help') help = true;
  }
  if (help) {
    console.log(`Metis policy derivation (v0.2)
Usage: node policy.mjs --project <repoRoot> [--json] [--probe]

Prints the policy the audit engine would use for this project. Phanes mode reads
.phanes/config.json; standalone mode infers from detection. No external tool name
is ever assumed.`);
    return 0;
  }
  const pol = derivePolicy(project, { probe });
  if (json) { console.log(JSON.stringify(pol, null, 2)); return 0; }
  console.log(`Policy: ${pol.name}  [${pol.mode}]`);
  console.log(`  configured MCP servers: ${pol.configuredMcpServers.join(', ') || '(none)'}`);
  console.log(`  granted MCP servers:    ${pol.grantedServers.join(', ') || '(none)'}`);
  console.log(`  mandated tools:         ${pol.mandatedTools.join(', ') || '(none)'}`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) process.exit(runCli(process.argv.slice(2)));
