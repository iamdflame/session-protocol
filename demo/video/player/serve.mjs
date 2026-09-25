/* A static server for the player: the page, its bundle, and public/ (fonts,
   captures, B-roll) with HTTP Range, which <video> needs to seek. */
import { createServer } from 'node:http';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
const HERE = new URL('.', import.meta.url).pathname;
const PUBLIC = join(HERE, '../public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.mp4': 'video/mp4', '.jpg': 'image/jpeg' };
export function serve(port = 4600) {
  return new Promise((res) => {
    const server = createServer((req, rsp) => {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path === '/' ? join(HERE, 'index.html') : path === '/player.js' ? join(HERE, 'dist/player.js') : join(PUBLIC, path);
      if (!existsSync(file)) { rsp.writeHead(404); rsp.end(); return; }
      file = realpathSync(file);
      const size = statSync(file).size;
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Number(range[2]) : size - 1;
        rsp.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
        createReadStream(file, { start, end }).pipe(rsp);
      } else {
        rsp.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
        createReadStream(file).pipe(rsp);
      }
    });
    server.listen(port, () => res(server));
  });
}
