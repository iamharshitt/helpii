import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareConsumer } from './npm-package.mjs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const timeout = 120_000;
const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete environment[key];
const run = (program, args, cwd) => spawnSync(program, args, {
  cwd, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, shell: false,
  env: environment
});

function git(cwd, ...args) {
  const result = run('git', args, cwd);
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? (result.stderr.trim() || 'Git command failed.'));
  }
  return result.stdout;
}

function verify(command, args, cwd) {
  const start = Date.now();
  const result = run(command, args, cwd);
  return {
    passed: !result.error && result.status === 0,
    status: result.error?.code ?? result.signal ?? result.status,
    elapsed: ((Date.now() - start) / 1000).toFixed(2),
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim().slice(-12000)
  };
}

const safeText = text => String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
function fenced(text) {
  const safe = safeText(text);
  const ticks = String.fromCharCode(96);
  const fence = ticks.repeat(Math.max(3, ...Array.from(safe.matchAll(/`+/g), match => match[0].length + 1)));
  return fence + '\n' + safe + '\n' + fence;
}

function rehearsal(repo, input, command, args, expectedCommit, setup, patch, matrix) {
  const root = realpathSync.native(git(resolve(repo), 'rev-parse', '--show-toplevel').trim());
  if (git(root, 'status', '--porcelain', '--untracked-files=normal').trim()) {
    throw new Error('Use a clean checkout so the rehearsal exactly matches the committed snapshot.');
  }
  if (isAbsolute(input) || /^[a-z]:|^[\\/]/i.test(input)) throw new Error('Use a repository-relative file path.');
  const path = relative(root, resolve(root, input.replaceAll('\\', '/')));
  if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path) || /[\x00-\x1f]/.test(path)) {
    throw new Error('The target must be a file inside the repository.');
  }
  const file = path.replaceAll('\\', '/');
  const commit = git(root, 'rev-parse', 'HEAD').trim();
  if (expectedCommit && expectedCommit !== commit) throw new Error('HEAD changed since the scan. Start again.');
  const tree = git(root, 'ls-tree', commit, '--', file);
  if (!/^100(?:644|755) blob /m.test(tree)) throw new Error('Select a regular file tracked at HEAD.');
  const parent = mkdtempSync(join(tmpdir(), 'helpii-rehearsal-'));
  const allocatedParent = realpathSync.native(parent);
  const paths = [join(parent, 'baseline'), join(parent, 'removal')];
  const consumerPaths = matrix?.packed ? [join(parent, 'baseline-consumer'), join(parent, 'removal-consumer')] : [];
  const registered = [];
  try {
    for (const worktree of paths) {
      git(root, '-c', 'core.hooksPath=' + join(parent, 'disabled-hooks'), 'worktree', 'add', '--detach', worktree, commit);
      registered.push(worktree);
    }
    const [baselineTree, removalTree] = paths;
    const trackedDiff = cwd => git(cwd, 'diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--');
    const indexDiff = cwd => git(cwd, 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--');
    const matchesSnapshot = (cwd, expectedDiff, expectedIndex = '') =>
      git(cwd, 'rev-parse', 'HEAD').trim() === commit && trackedDiff(cwd) === expectedDiff &&
      indexDiff(cwd) === expectedIndex;
    const setupResults = setup
      ? paths.map(worktree => verify(setup[0], setup.slice(1), worktree))
      : [];
    if (setupResults.some(result => !result.passed) || paths.some(path => !matchesSnapshot(path, ''))) {
      return {
        exitCode: 2,
        report: ['# helpii removal rehearsal', 'Commit: ' + commit,
          'Inconclusive: setup failed or changed the tracked snapshot. No removal check ran.',
          ...setupResults.flatMap((result, index) => [
            (index === 0 ? 'Baseline setup: ' : 'Removal setup: ') +
              (result.passed ? 'PASS' : 'FAIL') + ' (' + result.status + ', ' + result.elapsed + 's)',
            fenced(result.output)
          ])
        ].join('\n\n')
      };
    }
    const target = join(removalTree, file);
    if (!lstatSync(target).isFile()) throw new Error('Expected a regular file in the removal worktree.');
    const targetRelative = relative(realpathSync.native(removalTree), realpathSync.native(target));
    if (isAbsolute(targetRelative) || targetRelative === '..' || targetRelative.startsWith('..' + sep)) {
      throw new Error('Resolved target leaves the removal worktree.');
    }
    if (patch) {
      git(removalTree, 'apply', '--check', '--index', '--', patch);
      git(removalTree, 'apply', '--index', '--', patch);
      try {
        lstatSync(target);
        throw new Error('The proposed patch must delete the selected file.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    } else {
      unlinkSync(target);
    }

    const diff = trackedDiff(removalTree);
    const proposedIndex = indexDiff(removalTree);
    const checks = matrix ? [
      ['API', matrix.api],
      ['CLI', matrix.cli],
      ['Package contents', matrix.package ? [process.execPath, fileURLToPath(new URL('./check-package.mjs', import.meta.url)), file] : undefined]
    ] : [['Selected check', [command, ...args]]];
    const integrity = [];
    function inspect(label, worktree, expectedDiff, expectedIndex) {
      try {
        if (!matchesSnapshot(worktree, expectedDiff, expectedIndex)) {
          integrity.push(label + ' check changed the tracked snapshot.');
        }
      } catch {
        integrity.push(label + ' snapshot could not be verified after the check.');
      }
    }
    function inspectTarget() {
      try {
        lstatSync(target);
        integrity.push('The removal target exists again after the check.');
      } catch (error) {
        if (error.code !== 'ENOENT') integrity.push('Target absence could not be verified after the check.');
      }
    }
    let inventories;
    const packedDetails = [];
    if (matrix?.packed) {
      const builds = matrix.build
        ? paths.map(cwd => verify(matrix.build[0], matrix.build.slice(1), cwd))
        : [];
      inspect('Baseline', baselineTree, '');
      inspect('Removal', removalTree, diff, proposedIndex);
      inspectTarget();
      if (builds.some(result => !result.passed) || integrity.length) {
        return {
          exitCode: 2,
          report: ['# helpii packed-package rehearsal', 'Commit: ' + commit,
            'Inconclusive: packaging build failed or changed the tracked snapshot.',
            ...integrity, ...builds.map(result => fenced(result.output))
          ].join('\n\n')
        };
      }
      try {
        inventories = paths.map((source, index) => {
          try { return prepareConsumer(source, consumerPaths[index]); }
          catch (error) { throw new Error((index ? 'Removal' : 'Baseline') + ': ' + error.message); }
        });
      } catch (error) {
        return {
          exitCode: 2,
          report: ['# helpii packed-package rehearsal', 'Commit: ' + commit,
            'Inconclusive: could not pack and install both snapshots.', fenced(error.message)
          ].join('\n\n')
        };
      }
      const [beforeFiles, afterFiles] = inventories;
      const removed = [...beforeFiles].filter(path => !afterFiles.has(path)).sort();
      const added = [...afterFiles].filter(path => !beforeFiles.has(path)).sort();
      packedDetails.push('## Installed tarballs',
        'API and CLI commands ran from disposable npm consumer projects.',
        'Removed paths (' + removed.length + '):', fenced(removed.join('\n') || '(none)'),
        'Added paths (' + added.length + '):', fenced(added.join('\n') || '(none)'));
      if (matrix.build) packedDetails.push('Build command:', fenced(JSON.stringify(matrix.build)),
        'Baseline build output:', fenced(builds[0].output), 'Removal build output:', fenced(builds[1].output));
    }
    const checkResults = checks.map(([label, invocation]) => {
      if (!invocation || integrity.length) return { label };
      if (inventories && label === 'Package contents') {
        const results = inventories.map(files => ({
          passed: files.has(file), status: files.has(file) ? 0 : 1, elapsed: '0.00',
          output: file + (files.has(file) ? ' is in the tarball.' : ' is absent from the tarball.')
        }));
        return { label, invocation: ['Inspect installed tarball inventory', file], baseline: results[0], after: results[1] };
      }
      const [program, ...checkArgs] = invocation;
      const baseline = verify(program, checkArgs, consumerPaths[0] ?? baselineTree);
      inspect('Baseline', baselineTree, '');
      const after = verify(program, checkArgs, consumerPaths[1] ?? removalTree);
      inspect('Removal', removalTree, diff, proposedIndex);
      inspectTarget();
      return { label, invocation, baseline, after };
    });
    const selected = checkResults.filter(check => check.invocation);
    const baselinePassed = selected.every(check => check.baseline.passed);
    const afterPassed = selected.every(check => check.after.passed);
    const outcome = integrity.length ? 'Inconclusive: check changed the rehearsal state or its integrity could not be verified.'
      : !baselinePassed ? (matrix ? 'Inconclusive: at least one baseline check failed.' : 'Inconclusive: the baseline check failed.')
        : afterPassed ? (matrix ? 'Selected checks passed before and after removal.' : 'Selected check passed before and after removal.')
          : 'Removal check failed after a passing baseline.';
    const summary = check => (check.passed ? 'PASS' : 'FAIL') + ' (' + check.status + ', ' + check.elapsed + 's)';
    const rows = checkResults.map(({ label, invocation, baseline, after }) => {
      const result = !invocation ? 'Unverified' : integrity.length || !baseline.passed ? 'Inconclusive'
        : after.passed ? 'Passed selected check' : 'Regression detected';
      return '| ' + label + ' | ' + (invocation ? summary(baseline) : 'Skipped') +
        ' | ' + (invocation ? summary(after) : 'Skipped') + ' | ' + result + ' |';
    });
    return {
      exitCode: !integrity.length && baselinePassed && afterPassed ? 0 : 2,
      report: [
        '# helpii removal rehearsal', 'Commit: ' + commit, 'Target:', fenced(file),
        '## Result', outcome,
        ...(matrix ? [[
          '| Consumer contract | Baseline | After removal | Verdict |',
          '| --- | --- | --- | --- |', ...rows
        ].join('\n')] : ['- Baseline: ' + summary(selected[0].baseline), '- Removal: ' + summary(selected[0].after)]),
        ...integrity.map(issue => '- Integrity: ' + issue),
        ...(setup ? ['## Setup', fenced(JSON.stringify(setup)), '- Baseline setup: ' + summary(setupResults[0]),
          '- Removal setup: ' + summary(setupResults[1])] : []),
        '## Proposed diff', fenced(diff), ...packedDetails,
        ...selected.flatMap(({ label, invocation, baseline, after }) => [
          '## ' + label, 'Command:', fenced(JSON.stringify(invocation)), 'Baseline output:', fenced(baseline.output),
          'Removal output:', fenced(after.output)
        ]),
        '## Coverage limits',
        'Integrity checks inspect the worktrees after the command exits. Temporary changes undone within the command may go undetected. Only the selected checks were run. External callers, deployment-only jobs, and untested behavior remain unverified. Review this report for sensitive data before sharing.'
      ].join('\n\n')
    };
  } finally {
    for (const worktree of registered.reverse()) {
      try { git(root, 'worktree', 'remove', '--force', worktree); }
      catch (gitError) {
        try {
          // Only remove the exact directories allocated beneath our private temp root.
          const folder = lstatSync(worktree, { throwIfNoEntry: false });
          if (folder) {
            const realParent = realpathSync.native(parent);
            const realFolder = realpathSync.native(worktree);
            if (realParent !== allocatedParent || folder.isSymbolicLink() || !['baseline', 'removal'].includes(relative(realParent, realFolder))) {
              throw new Error('Temporary worktree path no longer matches its allocation.');
            }
            rmSync(realFolder, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
          }
          try { git(root, 'worktree', 'remove', '--force', worktree); }
          catch {
            if (git(root, 'worktree', 'list', '--porcelain').includes('worktree ' + worktree.replaceAll('\\', '/'))) {
              throw gitError;
            }
          }
        } catch (error) {
          console.error('helpii: cleanup failed at ' + safeText(worktree) + ': ' + safeText(error.message));
          process.exitCode = 2;
        }
      }
    }
    for (const consumer of consumerPaths) {
      try {
        const info = lstatSync(consumer, { throwIfNoEntry: false });
        if (info) {
          const realConsumer = realpathSync.native(consumer);
          if (info.isSymbolicLink() || !['baseline-consumer', 'removal-consumer'].includes(relative(allocatedParent, realConsumer))) {
            throw new Error('Unexpected consumer path.');
          }
          rmSync(realConsumer, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
        }
      } catch (error) {
        console.error('helpii: consumer cleanup failed: ' + safeText(error.message));
        process.exitCode = 2;
      }
    }
    try { rmdirSync(parent); } catch { /* Retain the directory if cleanup failed. */ }
  }
}

try {
  const [repo, file, ...options] = process.argv.slice(2);
  const expectedCommit = options[0] === '--expected-commit' ? options.splice(0, 2)[1] : undefined;
  let setup;
  if (options[0] === '--setup-json') {
    const [, setupFile] = options.splice(0, 2);
    if (!setupFile || setupFile === '--') throw new Error('Supply a setup JSON file.');
    setup = JSON.parse(readFileSync(setupFile, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(setup) || !setup.length || typeof setup[0] !== 'string' ||
        !setup[0].trim() || !setup.every(item => typeof item === 'string')) {
      throw new Error('Setup must be a JSON array containing an executable and optional arguments.');
    }
  }
  let patch;
  if (options[0] === '--patch') {
    const [, patchFile] = options.splice(0, 2);
    if (!patchFile || patchFile === '--') throw new Error('Supply a reviewed patch file.');
    patch = resolve(patchFile);
  }
  let matrix;
  if (options[0] === '--checks-json') {
    const [, checksFile] = options.splice(0, 2);
    if (!checksFile) throw new Error('Supply a checks JSON file.');
    matrix = JSON.parse(readFileSync(checksFile, 'utf8').replace(/^\uFEFF/, ''));
    const isCommand = value => Array.isArray(value) && value.length > 0 &&
      value.every(item => typeof item === 'string') && value[0].trim().length > 0;
    if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix) ||
        Object.keys(matrix).some(key => !['api', 'cli', 'package', 'packed', 'build'].includes(key)) ||
        ['api', 'cli', 'build'].some(key => Object.hasOwn(matrix, key) && !isCommand(matrix[key])) ||
                ['package', 'packed'].some(key => Object.hasOwn(matrix, key) && typeof matrix[key] !== 'boolean') ||
        (matrix.build && !matrix.packed) ||
        !(matrix.api || matrix.cli || matrix.package) || options.length) {
      throw new Error('Checks JSON needs at least one API or CLI command array, or package: true. Choose the matrix or a custom command.');
    }
  }
  const [separator, command, ...args] = options;
  if (!repo || !file || !matrix && (separator !== '--' || !command)) {
    throw new Error('Usage: node rehearse.mjs <repo> <tracked-file> [--setup-json <file>] [--patch <file>] (--checks-json <file> | -- <program> [args...])');
  }
  const { report, exitCode } = rehearsal(repo, file, command, args, expectedCommit, setup, patch, matrix);
  console.log(report);
  process.exitCode = Math.max(process.exitCode ?? 0, exitCode);
} catch (error) {
  console.error('helpii: ' + safeText(error.message));
  process.exitCode = 1;
}










