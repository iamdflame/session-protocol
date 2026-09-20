// Tiny static server. No framework, no build step.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.cwd(), PORT = process.env.PORT || 8080;
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json',
                '.css':'text/css', '.svg':'image/svg+xml' };

createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // redirect rather than rewrite: serving /src/index.html at "/" would make the
  // page's relative imports resolve against "/" and 404 the whole module graph
  if (p === '/') { res.writeHead(302, { location: '/src/' }); return res.end(); }
  if (p === '/src/' || p === '/src') p = '/src/index.html';
  const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(PORT, () => console.log(`prism → http://localhost:${PORT}`));
