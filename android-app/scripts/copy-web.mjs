// Web版（../mountain-gps）をアプリに同梱するため www/ にコピーする
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, '..', 'mountain-gps');
const dst = join(root, 'www');
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true, filter: (p) => !p.endsWith('README.md') });
console.log('copied', src, '->', dst);
