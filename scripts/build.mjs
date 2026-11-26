import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const url = path => new URL(path, root);
const dir = url('dist/');
await mkdir(dir, { recursive: true });
for (const path of ['style.css', 'workbench.css', 'src', 'vendor']) await cp(url(path), url(join('dist', path)), { recursive: true });
const fingerprint = createHash('sha256');
for (const path of ['workbench.css', 'src/app.js', 'src/ocean.js']) fingerprint.update(await readFile(url(path)));
const version = fingerprint.digest('hex').slice(0, 12);
const index = await readFile(url('index.html'), 'utf8');
await writeFile(url('dist/index.html'), index.replace(/\.\/(workbench\.css|src\/app\.js)/g, path => `${path}?v=${version}`));
await cp(url('public'), dir, { recursive: true });
await writeFile(url('dist/.nojekyll'), '');
console.log('Built dist/ (relative paths work at repository URLs).');
