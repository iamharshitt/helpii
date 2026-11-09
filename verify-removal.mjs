import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const gitEnvironment = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete gitEnvironment[key];
const run = (program, args, cwd) => {
  const result = spawnSync(program, args, {
    cwd, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024, env: gitEnvironment
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(program + ' was stopped by ' + result.signal);
  return result;
};
function git(root, ...args) {
  const result = run('git', args, root);
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Git failed.');
  return result.stdout.trim();
}
function checkSnapshot(root, expected) {
  if (git(root, 'status', '--porcelain', '--untracked-files=normal')) {
    throw new Error('Use a clean checkout. Tracked changes and untracked files make the scan and rehearsal incomparable.');
  }
  const commit = git(root, 'rev-parse', 'HEAD');
  if (expected && expected !== commit) throw new Error('HEAD changed since the scan. Start again.');
  return commit;
}
function relativeFile(root, path) {
  const file = relative(root, realpathSync.native(resolve(root, path)));
  if (!file || file === '..' || file.startsWith('..' + sep) || isAbsolute(file)) {
    throw new Error('The selected file must be inside the repository.');
  }
  return file.replaceAll('\\', '/');
}
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function knipEntrypoint(root, supplied) {
  if (supplied) return resolve(supplied);
  const packageDir = join(root, 'node_modules', 'knip');
  const manifest = join(packageDir, 'package.json');
  if (!existsSync(manifest)) throw new Error('Install and configure Knip in this repository, or pass --knip-entry <path>.');
  const { bin } = readJson(manifest);
  const entry = typeof bin === 'string' ? bin : bin?.knip;
  if (typeof entry !== 'string') throw new Error('Could not locate the Knip executable in its package manifest.');
  return resolve(packageDir, entry);
}
function checkPlan(root, finding) {
  const plans = [];
  for (const ref of finding.configReferences) {
    if (ref.source === 'deploy.json') {
      plans.push({ source: ref.key, check: 'Run a job-specific smoke check and confirm active deployment registration. Production usage remains unverified.' });
    } else if (ref.key === 'bin' || ref.key.startsWith('bin.')) {
      plans.push({ source: ref.key, check: 'Run the registered CLI with representative arguments and assert its exit code and output.' });
    } else if (ref.key === 'types' || /(?:^|\.)types(?:\.|$)/.test(ref.key)) {
      plans.push({ source: ref.key, check: 'Type-check a consumer fixture against the published declaration entry.' });
    } else if (/^(?:main|module|exports)(?:\.|$)/.test(ref.key)) {
      plans.push({ source: ref.key, check: 'Import the affected public entry from a consumer fixture and exercise its behavior. Check each applicable export condition.' });
    } else if (ref.key.startsWith('scripts.')) {
      plans.push({ source: ref.key, check: 'Smoke-test the registered script with representative input and verify its expected output.' });
    }
  }
  const manifest = join(root, 'package.json');
  if (existsSync(manifest)) {
    const { files } = readJson(manifest);
    if (Array.isArray(files)) {
      for (const entry of files) {
        if (typeof entry !== 'string' || /[*?{}\[\]!]/.test(entry)) continue;
        const path = entry.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
        if (path && (finding.file === path || finding.file.startsWith(path + '/'))) {
          plans.push({ source: 'files: ' + entry, check: 'Compare npm pack --dry-run --ignore-scripts --json output before and after. Confirm whether losing the artifact is intentional.' });
        }
      }
    }
  }
  if (!plans.length) plans.push({
    source: 'No recognized package interface',
    check: 'Find a consumer or project test that exercises the affected behavior. Check external and dynamic callers separately.'
  });
  return plans;
}

const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
function scanAndPlan({ repo, file, entry, context, command, checkPackage, setup, production, patch, checks }) {
  const root = realpathSync.native(git(resolve(repo), 'rev-parse', '--show-toplevel'));
  const commit = checkSnapshot(root);
  const target = relativeFile(root, file);
  const scanFlags = ['--files', '--reporter', 'json'];
  if (production) scanFlags.push('--production', '--strict');
  const knip = run(process.execPath, [knipEntrypoint(root, entry), ...scanFlags], root);
  // Knip exits 1 when it reports findings. Other nonzero exits are scan failures.
  if (![0, 1].includes(knip.status)) throw new Error('Knip failed (' + knip.status + '): ' + knip.stderr.trim());
  checkSnapshot(root, commit);
  const temporary = mkdtempSync(join(tmpdir(), 'helpii-plan-'));
  const reportPath = join(temporary, 'scan.json');
  const emptyContext = join(temporary, 'context.json');
  let findings;
  try {
    writeFileSync(reportPath, knip.stdout);
    writeFileSync(emptyContext, '{"records":[]}');
    const review = run(process.execPath, [
      join(here, 'review.mjs'), root, reportPath, context ? resolve(context) : emptyContext, '--json'
    ], root);
    if (review.status !== 0) throw new Error(review.stderr.trim());
    findings = JSON.parse(review.stdout);
  } finally {
    for (const path of [reportPath, emptyContext]) if (existsSync(path)) unlinkSync(path);
    rmdirSync(temporary);
  }
  const finding = findings.find(candidate => candidate.file === target);
  if (!finding) throw new Error('The selected file is absent from the live Knip findings. Findings: ' +
    (findings.slice(0, 12).map(candidate => candidate.file).join(', ') || 'none'));
  const plan = checkPlan(root, finding);
  checkSnapshot(root, commit);
  console.log('# helpii removal review\n\nCommit: ' + commit + '\n\nFile: ' + clean(target));
  console.log('\nKnip mode: ' + (production ? 'production (strict)' : 'default'));
  console.log('\nReview: ' + finding.status);
  for (const reference of finding.configReferences) console.log('- Config evidence: ' + clean(reference.source + ' #' + reference.key));
  for (const record of finding.records) for (const cite of record.evidence) {
    console.log('- ' + record.kind + ' evidence: ' + clean(cite.path) + ':' + cite.line +
      ' (' + (cite.problem ?? (cite.exactLine ? 'exact match' : cite.matches ? 'partial match' : 'changed')) + ')');
  }
  console.log('\n## Suggested checks');
  for (const item of plan) console.log('- ' + clean(item.source) + ': ' + item.check);
  if (checkPackage) command = [process.execPath, join(here, 'check-package.mjs'), target];
  if (!command.length && !checks) {
    console.log('\nVerification pending. Supply an approved command after -- to rehearse this removal.');
    return 0;
  }
  const setupArgs = setup ? ['--setup-json', resolve(setup)] : [];
  const patchArgs = patch ? ['--patch', resolve(patch)] : [];
  const verification = checks ? ['--checks-json', resolve(checks)] : ['--', ...command];
  const rehearsal = run(process.execPath, [join(here, 'rehearse.mjs'), root, target,
    '--expected-commit', commit, ...setupArgs, ...patchArgs, ...verification], root);
  if (rehearsal.stdout) process.stdout.write('\n' + rehearsal.stdout);
  if (rehearsal.stderr) process.stderr.write(rehearsal.stderr);
  return rehearsal.status ?? 1;
}

try {
  const [repo, file, ...args] = process.argv.slice(2);
  if (!repo || !file) throw new Error('Usage: node verify-removal.mjs <repo> <file> [--knip-entry <js>] [--context <json>] [--production] [--patch <file>] [--setup-json <file>] [--checks-json <file> | --check-package | -- <program> [args...]]');
  const options = { repo, file, command: [] };
  while (args.length) {
    const option = args.shift();
    if (option === '--production' && !options.production) {
      options.production = true;
      continue;
    }
    if (option === '--check-package' && !options.checkPackage) {
      options.checkPackage = true;
      continue;
    }
    if (option === '--') {
      if (options.checkPackage) throw new Error('Choose --check-package or supply a custom command.');
      if (!args.length) throw new Error('Supply a check command after --.');
      options.command = args;
      break;
    }
    const key = { '--knip-entry': 'entry', '--context': 'context', '--setup-json': 'setup', '--patch': 'patch', '--checks-json': 'checks' }[option];
    if (!key || !args.length || args[0].startsWith('--') || options[key]) throw new Error('Invalid option: ' + option);
    options[key] = args.shift();
  }
  if (options.checks && (options.checkPackage || options.command.length)) {
    throw new Error('Choose --checks-json, --check-package, or a custom command.');
  }
  process.exitCode = scanAndPlan(options);
} catch (error) {
  console.error('helpii: ' + clean(error.message));
  process.exitCode = 1;
}




