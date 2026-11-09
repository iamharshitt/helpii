import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export function runNpm(cwd, args, explicitNpm) {
  const nodeDir = dirname(realpathSync.native(process.execPath));
  const inheritedNpm = basename(process.env.npm_execpath ?? '') === 'npm-cli.js'
    ? process.env.npm_execpath : undefined;
  const entry = explicitNpm ?? inheritedNpm ??
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const options = { cwd, encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024 };
  if (existsSync(entry)) return spawnSync(process.execPath, [resolve(entry), ...args], options);
  if (process.platform !== 'win32') return spawnSync('npm', args, options);
  throw new Error('Could not find npm-cli.js. Run with npm available or set npm_execpath.');
}

export function pack(cwd, flags, explicitNpm) {
  const result = runNpm(cwd, ['pack', '--ignore-scripts', '--offline', '--json', ...flags], explicitNpm);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'npm pack failed.');
  const packages = JSON.parse(result.stdout);
  if (!Array.isArray(packages) || packages.length !== 1 || !Array.isArray(packages[0]?.files)) {
    throw new Error('Expected one package from npm pack. Run from a single npm package root.');
  }
  return packages[0];
}

export function prepareConsumer(source, consumer) {
  mkdirSync(consumer);
  const info = pack(source, ['--pack-destination', consumer]);
  if (typeof info.filename !== 'string' || basename(info.filename) !== info.filename) {
    throw new Error('npm returned an invalid tarball filename.');
  }
  writeFileSync(join(consumer, 'package.json'), '{"name":"helpii-consumer","version":"1.0.0","private":true}');
  const install = runNpm(consumer, [
    'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
    './' + info.filename
  ]);
  if (install.error) throw install.error;
  if (install.status !== 0) throw new Error(install.stderr.trim() || 'Consumer install failed.');
  return new Set(info.files.map(file => file.path));
}

