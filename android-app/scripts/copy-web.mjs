// Web版（../mountain-gps）をアプリに同梱するため www/ にコピーする
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, '..', 'mountain-gps');
const dst = join(root, 'www');
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true, filter: (p) => !p.endsWith('README.md') });

// Capacitor はアプリ起動時に橋渡し用のスクリプトをページへ差し込むため、
// アプリ版だけ script-src に 'unsafe-inline' を足す（通信先の制限はそのまま）
const html = join(dst, 'index.html');
const before = readFileSync(html, 'utf8');
const after = before.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';");
if (after === before) throw new Error('CSP の script-src が見つかりません');
writeFileSync(html, after);
console.log('copied', src, '->', dst);
