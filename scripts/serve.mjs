import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, sep, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const prefix = '/ndbc-wave-studio';
const port = Number(process.env.WAVE_PORT || 4261);
const mime = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.json': 'application/json', '.css': 'text/css;charset=utf-8', '.csv': 'text/csv;charset=utf-8', '.png': 'image/png', '.txt': 'text/plain;charset=utf-8' };
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === prefix) { response.writeHead(302, { Location: `${prefix}/` }).end(); return; }
    const relative = decodeURIComponent(url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : url.pathname);
    const file = resolve(join(root, relative.endsWith('/') ? `${relative}index.html` : relative));
    if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
    const info = await stat(file);
    if (!info.isFile()) { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-store' });
    if (request.method === 'HEAD') response.end(); else createReadStream(file).pipe(response);
  } catch { response.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}${prefix}/`));
