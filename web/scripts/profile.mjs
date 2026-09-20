/* CPU profile of a live page — which functions actually burn the main thread. */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { WebSocket } from 'ws';

const PATHNAME = process.argv[2] ?? '/';
const BASE = process.argv[3] ?? 'http://localhost:3200';
const CHROME = ['/usr/bin/google-chrome-stable','/usr/bin/google-chrome'].find(existsSync);
const PORT = 9600 + (process.pid % 300);
const chrome = spawn(CHROME, ['--headless=new',`--remote-debugging-port=${PORT}`,'--no-sandbox','--disable-gpu','--hide-scrollbars','--user-data-dir=/tmp/prof-'+process.pid,'about:blank'],{stdio:'ignore'});
const waitPort = p => new Promise((res,rej)=>{const t0=Date.now();const go=()=>{const s=createConnection({port:p,host:'127.0.0.1'},()=>{s.end();res();});s.on('error',()=>{s.destroy();Date.now()-t0>15000?rej(new Error('x')):setTimeout(go,120);});};go();});
try {
  await waitPort(PORT);
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());
  const ws = new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl,{maxPayload:256*1024*1024});
  await new Promise(r=>ws.once('open',r));
  let id=0; const pend=new Map();
  ws.on('message',b=>{const m=JSON.parse(b.toString());if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}});
  const send=(mth,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:mth,params:p}));});
  await send('Page.enable'); await send('Profiler.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await send('Emulation.setCPUThrottlingRate',{rate:Number(process.env.THROTTLE||4)});
  await send('Page.navigate',{url:BASE+PATHNAME});
  await new Promise(r=>setTimeout(r,3500));
  await send('Profiler.start');
  await new Promise(r=>setTimeout(r,5000));
  const { profile } = await send('Profiler.stop');

  const self = new Map();
  const byId = new Map(profile.nodes.map(n=>[n.id,n]));
  const total = profile.timeDeltas.reduce((s,v)=>s+v,0);
  for (let i=0;i<profile.samples.length;i++){
    const n = byId.get(profile.samples[i]);
    if(!n) continue;
    const f = n.callFrame;
    const key = `${f.functionName||'(anonymous)'}  ${(f.url||'').split('/').pop()}:${f.lineNumber+1}`;
    self.set(key,(self.get(key)||0)+(profile.timeDeltas[i]||0));
  }
  const rows=[...self.entries()].sort((a,b)=>b[1]-a[1]).slice(0,18);
  console.log(`total ${(total/1000).toFixed(0)}ms sampled\n`);
  for(const [k,v] of rows) console.log(`  ${(v/1000).toFixed(0).padStart(6)}ms  ${(v/total*100).toFixed(1).padStart(5)}%  ${k}`);
} finally { chrome.kill(); }
