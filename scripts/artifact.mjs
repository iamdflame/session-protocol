// Build the publishable Artifact page from the repo app.
//
// An Artifact is wrapped in its own <!doctype>/<head>/<body> at publish time,
// so the file must carry only <title>, <link>, <style> and the body content.
// Everything else — the module graph and the data snapshot — ships as sibling
// files, which are same-origin and so readable by fetch.
//
// One capability does not survive the move: the Artifact CSP blocks fetch to
// external hosts, so live Jupiter quotes only work in the repo version. The
// page detects that and says so rather than failing silently.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const html = readFileSync('src/index.html', 'utf8');

const head = html.slice(html.indexOf('<title>'), html.indexOf('</head>'));
const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));

const page = `${head.trim()}
${body.trim()}
`;

mkdirSync('dist', { recursive: true });
writeFileSync('dist/artifact.html', page);

for (const f of ['app.js', 'engine.js', 'belief.js', 'meta.js'])
  writeFileSync(`dist/${f}`, readFileSync(`src/${f}`, 'utf8'));
mkdirSync('dist/data', { recursive: true });
writeFileSync('dist/data/universe.json', readFileSync('data/universe.json', 'utf8'));

// match the tags themselves, not <header>
const bad = /<!doctype|<\/?(?:html|head|body)(?=[\s>])/i.exec(page);
console.log(bad ? `!! wrapper tag survived: ${bad[0]}` : 'dist/artifact.html clean');
console.log(`page ${(page.length / 1024).toFixed(1)}kb  ` +
  `data ${(readFileSync('data/universe.json').length / 1024).toFixed(0)}kb`);
