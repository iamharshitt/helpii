# helpii · Verifying dead-code removals before release

**A local CLI that rehearses a proposed removal against the package a downstream developer would actually install.**

## The problem

An unused-file report is a starting point for a cleanup. Maintainers still have to decide whether a removal breaks a public import, CLI command, published artifact, or production-only path. Existing static analysis and agent workflows already help find and remove code. I focused on giving reviewers before-and-after evidence for one proposed change.

## What I built

helpii runs Knip against a clean Git checkout and binds the selected finding to the scanned commit. It prepares two temporary worktrees, applies a deletion or a reviewed patch to one, and runs the same approved checks on both. Packed mode builds when configured, creates npm tarballs, installs them in separate disposable consumer projects, and reports API, CLI, and package-content results together. Omitted checks appear as **Unverified**. If a check restores the deleted file or changes the expected tracked state, the rehearsal is **Inconclusive**.

## Two cases

| Case | What I observed | Product decision |
| --- | --- | --- |
| npm semver 7.8.5 | Live Knip flagged preload.js. After deletion the main API and CLI still worked. The tarball lost the file and an installed consumer's require("semver/preload") failed. | Test the installed package and show which consumer contracts the checks cover. |
| Freelens example extension, PR #349 | Default Knip mode missed the helper because its unit test imported it. Production mode surfaced it. Removing the helper alone broke the suite. Replaying the reviewed patch that removed both helper and obsolete test passed all 17 remaining tests, versus 20 on baseline. | Support production scans and small reviewed patches. Keep the before-and-after test counts visible. |

## What changed after testing

An adversarial check on the real npm CLI restored the deleted file and then exited successfully. The first version reported a pass. I added a final-state check for the target, working tree, index, and commit after each command. Repeating the case produced an inconclusive verdict. Temporary edits reversed within a command can still evade this check.

## What the evidence supports

The controlled package tests and historical PR replay show that helpii can expose a regression missed by narrower checks and distinguish a one-file deletion from a complete cleanup patch. I selected the cases and checks. The Freelens replay covered unit tests rather than the full upstream CI. Maintainer usability, adoption, and time savings remain unmeasured. The tool executes trusted commands locally, and external consumers and production-only behavior remain unverified unless exercised.

## Five-minute walkthrough

- **0:00–0:40** · Open with the decision a maintainer faces after an unused-file warning.
- **0:40–1:50** · Show the semver report. Point to the green API and CLI rows, then the missing tarball path. Switch to the consumer deep-import result.
- **1:50–2:50** · Explain the baseline and removal worktrees, optional setup, and why installed consumer checks run outside the source checkout.
- **2:50–3:45** · Walk through Freelens. Explain why the one-file deletion failed and why the reviewed patch needed a different result.
- **3:45–4:35** · Show the false green you reproduced and the integrity check you added.
- **4:35–5:00** · State the limits and the next experiment: compare maintainer decisions and review time against configured Knip plus their usual workflow.

## Resume bullet

Built helpii, a TypeScript repository cleanup CLI that combines Knip findings, isolated Git rehearsals, and installed npm consumer checks. Reproduced a broken semver import missed by the main API smoke test and validated a historical Freelens cleanup patch against its unit suite.
