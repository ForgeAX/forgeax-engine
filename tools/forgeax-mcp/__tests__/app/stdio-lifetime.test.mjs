import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('a surviving MCP orphan retires itself after its native host is killed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-stdio-owner-'));
  const module = new URL('../../src/stdio-lifetime.mjs', import.meta.url).href;
  const marker = join(directory, 'closed');
  const childFile = join(directory, 'child.mjs');
  await writeFile(childFile, `import {bindStdioLifetime} from ${JSON.stringify(module)};
import {writeFile} from 'node:fs/promises';
bindStdioLifetime(()=>writeFile(${JSON.stringify(marker)},'closed'),{watchParent:true});
process.stdout.write('ready\\n'); setInterval(()=>{},1000);`);
  const parentFile = join(directory, 'parent.mjs');
  await writeFile(parentFile, `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,[${JSON.stringify(childFile)}],{stdio:['pipe','pipe','inherit']});
child.stdout.once('data',()=>process.stdout.write(String(child.pid)+'\\n')); setInterval(()=>{},1000);`);
  const parent = spawn(process.execPath, [parentFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  let pid;
  t.after(async () => { parent.kill('SIGKILL'); if(pid) { try { process.kill(pid,'SIGKILL'); } catch {} } await rm(directory,{recursive:true,force:true}); });
  pid = Number(String((await once(parent.stdout, 'data'))[0]).trim());
  assert.ok(pid > 1);
  parent.kill('SIGKILL'); await once(parent,'exit');
  const deadline = performance.now()+5000;
  let closed;
  while(performance.now()<deadline) {
    closed=await readFile(marker,'utf8').catch(()=>undefined);
    if(closed) break; await new Promise(done=>setTimeout(done,50));
  }
  assert.equal(closed,'closed');
  await new Promise(done=>setTimeout(done,100));
  assert.throws(()=>process.kill(pid,0));
});
