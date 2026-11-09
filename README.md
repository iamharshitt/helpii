# helpii Repository Review

Read-only CLI for reviewing unused-file candidates in TypeScript repositories. Requires Node.js 20 or later.


## Portfolio demo · semver

With Git, npm and Node.js 24, run:

```powershell
node portfolio-demo.mjs
```

The demo installs pinned Knip and semver versions in a temporary directory, runs the two packed-package comparisons, checks the expected results, and prints Markdown. The main API and CLI pass after removal, while the package loses preload.js. A second run checks the installed deep import and sees it fail. The demo itself exits successfully when both expected regressions are reproduced.

For an offline run with existing packages, pass the semver 7.8.5 package directory and the Knip JavaScript executable as two arguments. npm must be available for packing and local tarball installation.

See CASE-STUDY.md for the product rationale, evidence, and five-minute walkthrough.

## Try the demo

Run from this folder:

```powershell
node review.mjs demo demo/knip-sample.json demo/context.json
```

The demo uses synthetic source files and a synthetic Knip-format report. Expect one keep and two needs-verification findings.

## Review your repository

1. In your trusted project, use your installed, configured Knip. In PowerShell run:

   ```powershell
   npx --no-install knip --files --reporter json | Set-Content -Encoding utf8 knip-review.json
   ```

   Knip can return a nonzero exit code when it finds issues. The reviewer supports Knip v6 grouped issues and the older top-level files format. Rerun the scan after changes.

2. Create a context JSON file using the demo as a template. Start with architecture notes, requirements, deployment manifests, package scripts, and known public interfaces. You can ask Codex to draft the records from those files, then verify the mappings and set confirmed yourself. Use repo-relative paths, one-based lines, and exact excerpts. A confirmed entry-point record means you have verified that the cited source registers or invokes that specific file.
3. Run the reviewer with your repo path, scan report, and context file. Append --json for machine-readable output.

   ```powershell
   node review.mjs C:/path/to/repo C:/path/to/knip-review.json C:/path/to/context.json
   ```

| Status | Meaning |
| --- | --- |
| Keep | A supported configuration field directly references an existing file. Check whether the configuration is active. |
| Needs verification | No supported config reference was found, or the reported file is missing. The scan is an external input and its freshness is unverified. |

## Config references and verification

The reviewer checks the root deploy.json scheduledJob field and root package.json main, module, types, bin and explicit exports paths, plus direct script invocations such as "node src/worker.js" and "tsx src/worker.ts". The deploy.json field is the demo's convention. Verify whether your deployment actually consumes it. Simple arguments after the script path are supported. Shell wrappers, flags before the path, export wildcards, monorepo package manifests, and other deployment formats require manual review. Each finding includes a proposed verification step.

## Draft context with Codex

Append --codex-prompt to the review command and paste its output into Codex with your repository open. Start with an empty context file containing {"records":[]} if you have no confirmed records. Review the draft, merge any useful links into your context file, and confirm only the links you can verify. Rerun the CLI. It does not call Codex automatically.

helpii distinguishes exact lines, partial matches, changed citations, and missing sources. Context citations alone do not establish active usage. Reports omit raw notes and excerpts, and recognized sensitive files are excluded as evidence. This is path-based filtering, not a secret scanner. The scanner does not infer requirements on its own, execute project code, upload source, or edit the repository. Runtime benchmarks, VS Code diagnostics, and Codex MCP are future milestones.




## Rehearse a removal

Requires Git and a clean checkout. Choose one regular file tracked at HEAD and one command you trust. Use a command that can run in a fresh checkout:

```powershell
node rehearse.mjs C:/path/to/repo src/oldHelper.ts -- node scripts/smoke.mjs
```

The command checks out the same commit twice in temporary detached worktrees, removes the file in one, and runs the same command in both. It prints a Markdown report with the commit, diff, check results, and coverage limits. Save the report outside the target repo to avoid making the checkout dirty. A synthetic example is in demo/rehearsal-report.md.

Exit 0 means both checks passed and the final tracked snapshots matched the intended states. Exit 2 means a check failed, could not run, or changed the rehearsal state. A restored target makes the rehearsal inconclusive even if both commands exit successfully. Checks that undo temporary changes before exiting can evade this final-state check. Exit 1 means setup or input failed. Each check has a two-minute timeout. Worktrees are cleaned up on ordinary completion or handled errors.

The command executes code as your user. Git worktrees isolate checkout files, not processes, credentials, or network access. Existing node_modules and ignored files are not copied. Use the setup option below for dependencies or generated prerequisites. Pass an executable and arguments directly. On Windows, use node plus the path to a script instead of passing a .cmd shim. Inspect the report before sharing because the diff and command output can contain sensitive data.

The rehearsal is an explicit one-file check. It does not consume or verify a Knip report, publish a PR, or certify production safety.


## Scan, plan, and rehearse in one command

In a trusted Git checkout with Knip already installed and configured:

```powershell
node verify-removal.mjs C:/path/to/repo src/oldHelper.ts
node verify-removal.mjs C:/path/to/repo src/oldHelper.ts -- node scripts/smoke.mjs
```

The first form runs the local Knip scanner and prints the review and suggested checks. The second runs the same review and rehearses the removal with the one command you provide. That command can be a project script that runs multiple assertions. A file must be in the scan output before helpii will rehearse it through this entry point. The selected commit is checked before and after scanning and at rehearsal startup.

Optional flags before the command separator: --context <json> for confirmed project evidence, --knip-entry <path> for an explicit trusted JavaScript entry point when Knip is installed elsewhere. helpii runs the scanner in your checkout with your current dependencies and project config. Ignored files and external inputs are outside the snapshot check. The clean rehearsal worktrees do not inherit those files, so use a self-contained check or supply a setup command.

Suggestions are derived from recognized package fields (bin, exports, main, module, types, scripts and literal files entries) and the supported deployment convention. A literal files entry is evidence of intended packaging, not proof of the final tarball contents. Wildcards, external consumers and production usage require separate checks. The workflow runs only the verification command you explicitly supply.

### Check a published artifact

```powershell
node verify-removal.mjs C:/path/to/repo range.bnf --check-package
```

For a package-root checkout, --check-package runs npm pack --dry-run --ignore-scripts --offline --json in both worktrees and checks whether the selected path appears in the package file list. A file present in the baseline and missing after deletion is reported as a packaging regression. A file absent in the baseline yields an inconclusive result. This is a guard for an artifact expected to remain published. It does not compare unrelated package files or run lifecycle scripts. Use a custom verification script instead when packaging requires build or prepack steps. The flag cannot be combined with a custom check.

The same check can run without scanning for a known artifact:

```powershell
node rehearse.mjs C:/path/to/repo range.bnf -- node C:/path/to/helpii-review/check-package.mjs range.bnf
```


### Install dependencies or generate prerequisites

Provide a JSON array containing the approved executable and its arguments. On Windows, an npm example is:

```json
["node", "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]
```

```powershell
node verify-removal.mjs C:/path/to/repo src/oldHelper.ts --setup-json C:/path/to/setup.json -- node scripts/smoke.mjs
```

The same setup runs separately in both fresh worktrees before helpii deletes the selected file. Each invocation has a two-minute timeout. If setup fails, changes tracked files, stages changes, or moves HEAD, helpii reports an inconclusive rehearsal and skips the verification commands. Setup can create ignored dependencies and build outputs. The check must exercise the proposed source removal. A build artifact prepared before removal can mask it, so run the relevant rebuild inside the verification command. Treat setup and verification as trusted code running with your privileges.

### Production scans and reviewed patches

Use --production to run Knip in strict production mode when you want to find files used only by tests or tooling. Default mode remains available for findings across both production and development entry points.

Supply an existing Git-compatible patch with --patch when the removal has companion edits, such as deleting an obsolete test. The patch must apply cleanly to the scanned commit and delete the selected file. helpii applies it only to the temporary removal worktree. It checks the working tree and staged diff after verification. Review the patch before running it and verify that any removed tests are obsolete. Passing fewer tests does not by itself establish unchanged coverage.

```powershell
node verify-removal.mjs C:/path/to/repo src/oldHelper.ts --production --patch C:/path/to/reviewed.patch --setup-json C:/path/to/setup.json -- node scripts/smoke.mjs
```

### API, CLI, and package contents in one report

Save a checks file outside the target repository. This example expects both scripts to work in a fresh checkout:

```json
{
  "api": ["node", "scripts/api-smoke.mjs"],
  "cli": ["node", "scripts/cli-smoke.mjs"],
  "package": true
}
```

```powershell
node verify-removal.mjs C:/path/to/repo src/oldHelper.ts --checks-json C:/path/to/checks.json
```

Provide at least one check. API and CLI entries are commands you choose and approve. The package flag uses the built-in npm pack dry run to check whether the selected file remains in the package. Omitted checks appear as Unverified. A check that fails on the baseline is inconclusive, and a check that passes at baseline but fails after removal is reported as a regression. The report includes the exact commands and output. A passing row applies to the selected command, not every API call or CLI behavior.

The checks run in API, CLI, then package order within the same two worktrees. helpii verifies tracked state after each command and stops further checks if integrity is lost. Commands can still leave untracked or ignored state for later checks, so use self-contained checks and rebuild generated output when relevant. The matrix can be combined with --setup-json, --patch, or --production. It replaces the single verification command and cannot be combined with --check-package.

### Test the installed package

Set "packed": true in the checks file to pack each snapshot, install each tarball in its own disposable npm project, and run API and CLI commands from those projects. Commands should resolve the package by name or invoke the installed CLI. Paths relative to the source checkout will not work in the consumer project.

```json
{
  "packed": true,
  "api": ["node", "-e", "require('semver').satisfies('1.2.3', '^1') || process.exit(1)"],
  "cli": ["node", "node_modules/semver/bin/semver.js", "1.2.3"],
  "package": true
}
```

Use the same verify-removal.mjs --checks-json invocation. Packed mode compares tarball inventories and lists added and removed paths. Setting package to true requires the selected file to be present in both inventories. The API and CLI commands run against installed tarballs regardless of that flag.

If the package needs a build, add a "build" command array. It runs in both source worktrees after the removal is applied and before packing. The build may generate ignored or untracked outputs. Changes to the tracked snapshot make the result inconclusive. npm pack and npm install run offline with lifecycle scripts disabled. Dependencies needed by the consumer must already be available in the npm cache. A packaging or installation failure is reported as inconclusive with the failing side identified. Packed mode targets a single npm package root.

