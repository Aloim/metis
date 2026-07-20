#!/usr/bin/env node
// version.mjs  --  Metis version marker and self-update check (v0.2)
//
// Metis checks its own public repository for a newer release on invocation, in
// both standalone and Phanes-integrated use. The check is best effort: a short
// timeout, every network error swallowed, and it never blocks a run. This
// mirrors the Phanes pre-flight self-check, scaled down to a single fetch.
//
// The authoritative local version is package.json's `version`; METIS_VERSION
// here is the fallback when package.json cannot be read.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const METIS_REPO = 'Aloim/metis';
export const METIS_VERSION = '0.3.0';
const RAW_PACKAGE_URL = `https://raw.githubusercontent.com/${METIS_REPO}/main/package.json`;

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Local version, read from the sibling package.json, falling back to the
// constant above.
export function localVersion() {
  // package.json lives at the repo root, one level up from src/.
  for (const rel of ['package.json', path.join('..', 'package.json')]) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(HERE, rel), 'utf8'));
      if (j && typeof j.version === 'string') return j.version;
    } catch { /* try next */ }
  }
  return METIS_VERSION;
}

// Compare two dotted numeric versions. Returns > 0 if a is newer than b.
export function cmpSemver(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Best-effort update check. Never throws; returns a plain result object.
export async function checkForUpdate({ timeoutMs = 4000 } = {}) {
  const current = localVersion();
  if (typeof fetch !== 'function') {
    return { ok: false, reason: 'fetch unavailable (Node < 18)', current };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(RAW_PACKAGE_URL, {
      signal: ac.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'metis-update-check' },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, current };
    const j = await res.json();
    const latest = (j && typeof j.version === 'string') ? j.version : null;
    if (!latest) return { ok: false, reason: 'no version field in remote package.json', current };
    const updateAvailable = cmpSemver(latest, current) > 0;
    return {
      ok: true, current, latest, updateAvailable, repo: METIS_REPO,
      message: updateAvailable
        ? `A newer Metis is available: ${latest} (you have ${current}). Update from https://github.com/${METIS_REPO}`
        : `Metis is up to date (${current}).`,
    };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'error', current };
  } finally {
    clearTimeout(timer);
  }
}

// CLI: `node version.mjs [--check] [--json]`
async function runCli(argv) {
  const doCheck = argv.includes('--check');
  const json = argv.includes('--json');
  if (!doCheck) {
    console.log(json ? JSON.stringify({ version: localVersion(), repo: METIS_REPO }) : localVersion());
    return 0;
  }
  const r = await checkForUpdate();
  if (json) { console.log(JSON.stringify(r, null, 2)); return 0; }
  if (r.ok) console.log(r.message);
  else console.log(`Metis ${r.current}. Update check skipped (${r.reason}).`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) runCli(process.argv.slice(2)).then(c => process.exit(c)).catch(() => process.exit(0));
