import { isAbsolute } from 'node:path';
import { pack } from './npm-package.mjs';

try {
  const [file, explicitNpm, ...extra] = process.argv.slice(2);
  if (!file || isAbsolute(file) || file.split(/[\\/]/).includes('..') || extra.length) {
    throw new Error('Usage: node check-package.mjs <package-relative-file> [absolute-path-to-npm-cli.js]');
  }
  if (explicitNpm && !isAbsolute(explicitNpm)) throw new Error('Use an absolute path to npm-cli.js.');
  const info = pack(process.cwd(), ['--dry-run'], explicitNpm);
  const target = file.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!info.files.some(item => item.path === target)) throw new Error(target + ' is absent from the package contents.');
  console.log('Published artifact present: ' + target);
} catch (error) {
  console.error('helpii package check: ' + error.message);
  process.exitCode = 1;
}
