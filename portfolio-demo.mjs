import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNpm } from './npm-package.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
function run(program, args, cwd, expected = 0) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== expected) throw new Error([result.stderr, result.stdout].filter(Boolean).join('\n').trim() || program + ' failed.');
  return result.stdout;
}

let temp;
try {
  const [localSemver, localKnip, ...extra] = process.argv.slice(2);
  if (extra.length || Boolean(localSemver) !== Boolean(localKnip)) {
    throw new Error('Usage: node portfolio-demo.mjs [<semver package directory> <Knip JS entry>]');
  }
  temp = mkdtempSync(join(tmpdir(), 'helpii-portfolio-'));
  const allocated = realpathSync.native(temp);
  const repo = join(temp, 'semver');
  let source = localSemver && resolve(localSemver);
  let scanner = localKnip && resolve(localKnip);
  if (!source) {
    const tools = join(temp, 'tools');
    mkdirSync(tools);
    writeFileSync(join(tools, 'package.json'), '{"name":"helpii-demo-tools","version":"1.0.0","private":true}');
    const install = runNpm(tools, ['install', '--no-audit', '--no-fund', '--ignore-scripts',
      '--no-package-lock', 'semver@7.8.5', 'knip@6.44.2']);
    if (install.error || install.status !== 0) throw new Error(install.error?.message ?? install.stderr);
    source = join(tools, 'node_modules', 'semver');
    const knip = join(tools, 'node_modules', 'knip');
    const { bin } = JSON.parse(readFileSync(join(knip, 'package.json'), 'utf8'));
    scanner = join(knip, typeof bin === 'string' ? bin : bin.knip);
  }
  if (!existsSync(scanner)) throw new Error('Knip entry was not found.');
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (manifest.name !== 'semver' || manifest.version !== '7.8.5') throw new Error('The demo expects semver 7.8.5.');
  cpSync(source, repo, { recursive: true });
  run('git', ['init', '-q'], repo);
  run('git', ['-c', 'core.autocrlf=false', 'add', '.'], repo);
  run('git', ['-c', 'user.name=helpii Demo', '-c', 'user.email=demo@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Snapshot semver 7.8.5'], repo);
  const cases = [
    ['Main API and CLI', 'const assert = require("node:assert/strict"); assert.equal(require("semver").satisfies("1.2.3", "^1"), true);'],
    ['Deep import', 'require("semver/preload");']
  ];
  for (const [label, code] of cases) {
    const checks = join(temp, 'checks.json');
    writeFileSync(checks, JSON.stringify({
      packed: true, api: [process.execPath, '-e', code],
      cli: [process.execPath, 'node_modules/semver/bin/semver.js', '1.2.3'], package: true
    }));
    const report = run(process.execPath, [
      join(here, 'verify-removal.mjs'), repo, 'preload.js', '--knip-entry', scanner, '--checks-json', checks
    ], temp, 2);
    const api = label === 'Deep import' ? /\| API \| PASS[^\n]*\| FAIL/ : /\| API \| PASS[^\n]*\| PASS/;
    if (!api.test(report) || !/\| CLI \| PASS[^\n]*\| PASS/.test(report) ||
        !/\| Package contents \| PASS[^\n]*\| FAIL/.test(report)) {
      throw new Error('Unexpected result for ' + label + '\n' + report);
    }
    console.log('# Demo case · ' + label + '\n\n' + report);
  }
  if (realpathSync.native(temp) !== allocated || relative(allocated, repo) !== 'semver') {
    throw new Error('Unexpected demo directory.');
  }
} catch (error) {
  console.error('helpii demo: ' + error.message);
  process.exitCode = 1;
} finally {
  if (temp) {
    const nativeTempRoot = realpathSync.native(tmpdir());
    const target = realpathSync.native(temp);
    if (/^helpii-portfolio-[a-zA-Z0-9]+$/.test(relative(nativeTempRoot, target))) {
      rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    }
  }
}
