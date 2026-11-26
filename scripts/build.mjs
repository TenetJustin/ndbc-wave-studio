import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const url = path => new URL(path, root);
const dir = url('dist/');
await mkdir(dir, { recursive: true });
for (const path of ['index.html', 'style.css', 'workbench.css', 'src', 'vendor']) await cp(url(path), url(join('dist', path)), { recursive: true });
await cp(url('public'), dir, { recursive: true });
await writeFile(url('dist/.nojekyll'), '');
console.log('Built dist/ (relative paths work at repository URLs).');
