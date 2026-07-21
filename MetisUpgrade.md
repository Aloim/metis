<!-- MetisUpgrade v1.0.0, 2026-07-21, production upgrade command for existing Metis installations.
     Upgrades ANY installed Metis to the latest metis.md command and engine at github.com/Aloim/metis.
     It COMPLETELY REPLACES the legacy command and engine with the new ones, and PRESERVES every byte
     of per-project audit state (state.json, reports, archive, the ledger, the capability manifest).
     Companion to metis.md. Invoked by /metis when it detects a newer version and the user consents,
     or run directly as /metisupgrade. Same-version reinstall needs `--force`. Never downgrades. -->

# MetisUpgrade

Replace an existing Metis installation, command file and engine both, with the latest published version, while preserving every byte of this project's audit state. The engine and command are disposable and re-fetched on demand; the audit state (run counter, reports, archive, ledger, consented capability manifest) is irreplaceable and is never deleted.

**Prime directive: REPLACE THE ENGINE, PRESERVE THE STATE.** When uncertain about any file, preserve it. The only things this command deletes are the legacy engine files it is about to re-fetch. It never touches `state.json`, `reports/`, `archive/`, the ledger, or the capability manifest.

**YOU MUST** let `$ARGUMENTS` steer the run when provided: `--force` (reinstall even when not newer), `--project <path>` (target a specific project).

Constants for this version:

- Repo: `Aloim/metis`. Raw base: `https://raw.githubusercontent.com/Aloim/metis/main`.
- Command files: `metis.md` (from `<raw-base>/metis.md`) and this file `MetisUpgrade.md` (from `<raw-base>/MetisUpgrade.md`).
- Engine files (fetched into the engine directory): `metis.mjs`, `census.mjs`, `policy.mjs`, `ledger.mjs`, `session-audit.mjs`, `phanes-context.mjs`, `adherence.mjs`, `version.mjs`, `policy.json`, each from `<raw-base>/src/<file>`.
- This command's version stamp is on line 1 (`MetisUpgrade vX.Y.Z`).

Detect the platform first (PowerShell on Windows, bash on POSIX) and run only the matching commands.

## Phase 0: Self-refresh (this command)

Fetch `<raw-base>/MetisUpgrade.md` and read its line-1 stamp. If it is newer than this file's stamp, overwrite the installed command file you were invoked from (`~/.claude/commands/metisupgrade.md` for a global install, `<project>/.claude/commands/metisupgrade.md` for a per-project install), tell the user MetisUpgrade refreshed itself and to run `/metisupgrade` again, and **stop**. This guarantees the newest upgrade logic, and its current engine file list, is what runs. The fetch is best effort: on a network failure, note it and continue with the current file. **Local-newer rule:** if the installed stamp is HIGHER than upstream, this is a developer working copy; use the local file as the target and never downgrade.

## Phase 1: Resolve the install (scope, engine, state, command)

1. **Find the existing engine.** If `<project>/metis/metis.mjs` exists, the scope is **project**: the engine directory and the state directory are both `<project>/metis/`. Else if `~/.claude/metis/metis.mjs` exists (`$env:USERPROFILE\.claude\metis` on Windows), the scope is **global**: that folder is the engine directory and per-project state lives at `<project>/.metis/`.
2. **No engine found is not an upgrade.** If neither exists, there is nothing to replace: tell the user to run `/metis` first to install, and **stop**.
3. **Locate the installed command file.** `<project>/.claude/commands/metis.md` (per-project) then `~/.claude/commands/metis.md` (global). If both exist, the per-project copy is the active one; flag the duplication to the user.

## Phase 2: Fetch the target and gate on version

1. **Fetch the target command** `<raw-base>/metis.md` to a temporary path. Sanity-check it begins with `<!-- Metis v`; if the fetch fails or the check fails, **stop**, an upgrade without a confirmed target is guesswork. Read the target version from its line-1 stamp.
2. **Read the installed version.** In priority order, first hit wins: `<stateDir>/state.json` field `version`; else the installed `metis.md` line-1 stamp.
3. **Gate.** If the target version is not newer than the installed version and `--force` is not set: say Metis is already current, note that `--force` reinstalls the same version, and **stop**. Never downgrade: if the installed version is higher than the target, stop and say so.

## Phase 3: Replace the command files

Back up the active installed `metis.md` to `<same-path>.pre-upgrade` (best effort), then overwrite it with the fetched target. The installed `metisupgrade.md` was already refreshed in Phase 0; do not touch it again here.

## Phase 4: Completely replace the engine (stage, verify, then swap)

Replace every legacy engine file with the current set. Stage first so a mid-download failure can never leave a broken install.

1. **Stage the new engine into a temp directory.** Create a fresh temp folder and fetch each engine file from `<raw-base>/src/<file>` into it:
   - POSIX: `stage="$(mktemp -d)"; for f in metis.mjs census.mjs policy.mjs ledger.mjs session-audit.mjs phanes-context.mjs adherence.mjs version.mjs policy.json; do curl -fsSL "<raw-base>/src/$f" -o "$stage/$f" || { echo "FETCH-FAILED $f"; break; }; done`
   - PowerShell: `$stage = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "metis-upgrade-$(Get-Random)"); foreach ($f in 'metis.mjs','census.mjs','policy.mjs','ledger.mjs','session-audit.mjs','phanes-context.mjs','adherence.mjs','version.mjs','policy.json') { try { Invoke-WebRequest "<raw-base>/src/$f" -OutFile (Join-Path $stage $f) -ErrorAction Stop } catch { Write-Output "FETCH-FAILED $f" } }`
2. **Verify the staging is complete.** Every engine file above MUST be present and non-empty in the temp folder. If any is missing, **stop**: report the incomplete download and that the existing install is untouched and still working. Do not proceed to the swap.
3. **Remove the legacy engine, then move the new one in.** Delete only the engine files in the engine directory (`*.mjs` and `policy.json`); this clears any renamed or retired legacy file so nothing stale lingers. **Do not** delete `state.json`, `reports/`, `archive/`, or any subdirectory, those are state. Then move every staged file into the engine directory.
   - POSIX: `find "<engineDir>" -maxdepth 1 -type f \( -name '*.mjs' -o -name 'policy.json' \) -delete && mv "$stage"/* "<engineDir>/" && rmdir "$stage"`
   - PowerShell: `Get-ChildItem "<engineDir>" -File | Where-Object { $_.Extension -eq '.mjs' -or $_.Name -eq 'policy.json' } | Remove-Item -Force; Move-Item (Join-Path $stage '*') "<engineDir>" -Force; Remove-Item $stage -Force`

## Phase 5: Verify and record

1. **Confirm the new engine loads and reports the target version:** `node <engineDir>/metis.mjs version`. It MUST print the target version. Then, best effort, `node <engineDir>/metis.mjs detect --project <project> --json` to confirm the engine runs cleanly.
2. **Record the upgrade.** Update `<stateDir>/state.json` `version` to the target, preserving every other field (`installScope`, `engineDir`, `runCount`, `lastRun`). Create the state directory only if it was already the resolved state location; never relocate state.
3. **Report what changed.** Best effort, fetch `<raw-base>/Changelog.md` and summarize the entries between the old and new version. Tell the user the upgrade is complete and to run `/metis` to audit with the new engine.

## Constraints (hard)

- **Preserve, then replace.** The only deletions are the legacy engine files staged for re-fetch. State, reports, archive, ledger, and the capability manifest are never deleted or relocated.
- **Never downgrade.** A local or installed version higher than the target means stop, not overwrite.
- **Stage before swap.** A failed download leaves the working install intact; never delete the legacy engine before the full new set is verified in staging.
- **Advisory reporting.** Report each action taken; do not claim a step done without its command evidence.
- New prose here and in anything you write stays free of em and en dashes and dash-as-punctuation.
