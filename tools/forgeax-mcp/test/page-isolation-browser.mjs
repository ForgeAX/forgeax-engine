import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const [rootArg, url, evidenceArg] = process.argv.slice(2);
if (!rootArg || !url || !evidenceArg)
  throw new Error('Usage: page-isolation-browser.mjs <project-root> <View-url> <evidence-directory>');
if (!process.env.FORGEAX_ISOLATION_RUN_A || !process.env.FORGEAX_ISOLATION_RUN_B)
  throw new Error('Set FORGEAX_ISOLATION_RUN_A and FORGEAX_ISOLATION_RUN_B to two real engine run start JSON receipts.');
const root = resolve(rootArg);
const evidenceDirectory = resolve(evidenceArg);
await mkdir(evidenceDirectory, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}),
  headless: false, args: ['--enable-unsafe-webgpu'],
  chromiumSandbox: true,
});
const client = new Client({ name: 'forgeax-two-headed-pages', version: '0.0.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve(import.meta.dirname, '../src/mcp-stdio.mjs'), root],
  env: { ...process.env } });
const observations = [];
const pages = [];
const pageState = page => page.evaluate(() => ({
  mounted: globalThis.__forgeaxViewReady?.mounted === true,
  activePage: document.documentElement.dataset.forgeaxViewActivePage ?? null,
  canvasCount: document.querySelectorAll('canvas').length,
  packVisible: [...document.querySelectorAll('[data-cb-path="assets/scene.pack.json"]')]
    .some(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0),
  body: document.body.innerText.slice(0, 1200),
}));
const snapshot = async label => {
  const status = (await client.callTool({ name: 'forgeax_view_status', arguments: {} })).structuredContent;
  const state = { label, status, pages: await Promise.all(pages.map(pageState)) };
  observations.push(state);
  return state;
};
const waitRunning = async targetId => {
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    const status = (await client.callTool({ name: 'forgeax_view_status', arguments: {} })).structuredContent;
    if (status?.ok && status.value.pages.some(page => page.projectPhase === 'running' &&
      page.targets.some(target => target.targetId === targetId))) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.fail('the first headed project must become running within 60 seconds');
};
const showContentBrowser = async page => {
  if (!await page.getByTestId('panel-content-browser').isVisible()) {
    await page.locator('.fx-view-workspace-row.is-active .dv-groupview-edge .dv-tab')
      .filter({ hasText: /^(\u5185\u5bb9\u6d4f\u89c8\u5668|Content Browser)$/ }).click();
  }
  await page.locator('[data-cb-path="assets/scene.pack.json"]').first()
    .waitFor({ state: 'visible', timeout: 60_000 });
};
// Observe and send through the actual frontend socket; adding a synthetic
// frontend connection would change the page-count and isolation contract.
const wireProbe = () => {
  const NativeSocket = window.WebSocket;
  const probe = window.__isolationProbe = { events: [], pending: new Map(), socket: null, template: null };
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => {
        let m; try { m = JSON.parse(event.data); } catch { return; }
        if (m.kind === 'event' && ['forgeax.view.workspace.state', 'forgeax.view.status'].includes(m.topic)) probe.events.push(m);
        if (m.kind === 'response' && probe.pending.has(m.id)) {
          const { resolve, reject, timer } = probe.pending.get(m.id); clearTimeout(timer); probe.pending.delete(m.id);
          if (m.ok) resolve(m.value); else reject(new Error(JSON.stringify(m.error)));
        }
      });
    }
    send(data) {
      let m; try { m = JSON.parse(data); } catch {}
      if (m?.kind === 'request' && m.service === 'forgeax.view.workspace.call') { if(probe.socket!==this){super.send(JSON.stringify({kind:'subscribe',topic:'forgeax.view.status'}));} probe.socket = this; probe.template = m.payload; }
      return super.send(data);
    }
  };
  probe.call = (operation, args = {}) => new Promise((resolve, reject) => {
    const id = `isolation-${crypto.randomUUID()}`;
    const timer = setTimeout(() => { probe.pending.delete(id); reject(new Error(`isolation request timed out: ${operation}`)); }, 60000);
    probe.pending.set(id, { resolve, reject, timer });
    probe.socket.send(JSON.stringify({kind:'request', id, service:'forgeax.view.workspace.call', payload:{...probe.template, operation, args, requestId:id}}));
  });
};
const pageCall = (page, operation, args = {}) => page.evaluate(({operation,args}) => window.__isolationProbe.call(operation,args), {operation,args});
const clearEvents = page => page.evaluate(() => { window.__isolationProbe.events.length = 0; });
const scopedState = state => ({ selectedTabId: state.selectedTabId, targetBinding: state.targetBinding,
  sceneSelection: state.sceneSelection, targetId: state.projectTarget?.targetId,
  openRequest: state.openRequest && {sequence:state.openRequest.sequence,guid:state.openRequest.asset?.guid,targetId:state.openRequest.preview?.target?.targetId},
  resources: Object.keys(state.resourceOpens ?? {}) });
const pageEvents = page => page.evaluate(() => window.__isolationProbe.events.map(({topic,payload}) => ({topic, payload:topic==='forgeax.view.status'
  ? {status:payload.status,binding:payload.binding,runId:payload.observation?.status?.runId,phase:payload.observation?.status?.phase}
  : {selectedTabId:payload.selectedTabId,targetBinding:payload.targetBinding,targetId:payload.projectTarget?.targetId,sceneSelection:payload.sceneSelection,
    openRequest:payload.openRequest && {guid:payload.openRequest.asset?.guid,targetId:payload.openRequest.preview?.target?.targetId},resources:Object.keys(payload.resourceOpens??{})}})));
const matrix = async (first, second, tool) => {
  await second.getByRole('tab', { name: /\u8fd0\u884c\u65f6\u622a\u56fe|Runtime Capture/ }).click();
  const a = await pageCall(first,'tabs.get'); const b = await pageCall(second,'tabs.get');
  assert.equal(b.selectedTabId, 'forgeax-cli-display');
  await Promise.all([clearEvents(first),clearEvents(second)]);
  const scene = a.assets.find(asset=>asset.kind==='scene'); const mesh = b.assets.find(asset=>asset.kind==='mesh');
  assert.ok(scene && mesh, 'real Catalog must include scene and mesh outputs');
  await pageCall(first,'asset.open',{projectId:a.project.id,guid:scene.guid,tabId:'forgeax-user-workspace'});
  const openedA = await pageCall(first,'tabs.get');
  assert.equal(openedA.openRequest.asset.guid,scene.guid);
  assert.equal((await pageCall(second,'tabs.get')).openRequest,b.openRequest,'resource opens must stay on their page');
  assert.equal((await pageCall(second,'tabs.get')).selectedTabId, b.selectedTabId,
    'opening a Scene in one page must preserve the other page selected tab');
  const ownTarget = openedA.preview.target;
  const statusAfterOpen = (await client.callTool({ name: 'forgeax_view_status', arguments: {} })).structuredContent;
  assert.equal(statusAfterOpen.value.pages.flatMap(page => page.targets)
    .find(target => target.targetId === ownTarget.targetId)?.generation, ownTarget.generation,
  'MCP status must supply the actual generation required by Scene Tree');
  const tree = await tool('forgeax_engine_scene_tree_get',{targetId:ownTarget.targetId,targetGeneration:ownTarget.generation,limit:50});
  assert.equal(tree.ok,true,JSON.stringify(tree)); assert.ok(tree.value.nodes.length);
  await pageCall(first,'scene.select',{entityId:tree.value.nodes[0].entityId,targetId:ownTarget.targetId,targetGeneration:ownTarget.generation,tabId:'forgeax-user-workspace'});
  await pageCall(first,'target.select',{targetId:ownTarget.targetId});
  const entity = await tool('forgeax_engine_entity_inspect',{entityId:tree.value.nodes[0].entityId,targetId:ownTarget.targetId,targetGeneration:ownTarget.generation});
  assert.equal(entity.ok,true,JSON.stringify(entity));
  // Restore the second page's original Editor fixture after proving that the
  // first page's Scene open preserved its Runtime Capture selection.
  await second.locator('[role="tab"][data-page-id="page-editor"]').click();
  await pageCall(second,'asset.open',{projectId:b.project.id,guid:mesh.guid,tabId:'forgeax-user-workspace'});
  await first.getByRole('tab',{name:/\u8fd0\u884c\u65f6\u622a\u56fe|Runtime Capture/}).click();
  const afterA=await pageCall(first,'tabs.get'), afterB=await pageCall(second,'tabs.get');
  assert.equal(afterA.selectedTabId,'forgeax-cli-display'); assert.equal(afterB.selectedTabId,'forgeax-user-workspace');
  assert.equal(afterB.sceneSelection,null); assert.equal(afterB.openRequest.asset.guid,mesh.guid);
  const runA=JSON.parse(await readFile(process.env.FORGEAX_ISOLATION_RUN_A,'utf8')).value;
  const runB=JSON.parse(await readFile(process.env.FORGEAX_ISOLATION_RUN_B,'utf8')).value;
  const binding = run => ({root:run.root??run.status?.root,runId:run.runId??run.status?.runId});
  assert.ok(binding(runA).runId && binding(runB).runId,'two actual runs must be ready');
  await pageCall(first,'display.bind',binding(runA)); await pageCall(second,'display.bind',binding(runB));
  let displayA,displayB;
  const deadline=performance.now()+60000;
  do { displayA=await pageCall(first,'display.status');displayB=await pageCall(second,'display.status');
    if(displayA.status==='running'&&displayB.status==='running')break;
    await new Promise(resolve=>setTimeout(resolve,250));
  } while(performance.now()<deadline);
  assert.equal(displayA.status,'running',JSON.stringify(displayA)); assert.equal(displayB.status,'running',JSON.stringify(displayB));
  assert.equal(displayA.observation.status.runId,binding(runA).runId); assert.equal(displayB.observation.status.runId,binding(runB).runId);
  const eventsA=await pageEvents(first),eventsB=await pageEvents(second);
  assert.ok(eventsA.some(event=>event.topic==='forgeax.view.workspace.state'&&event.payload.sceneSelection),'first must receive actual selection events');
  assert.ok(eventsB.some(event=>event.topic==='forgeax.view.workspace.state'&&event.payload.openRequest),'second must receive actual openRequest events');
  for(const event of eventsB) {
    assert.notEqual(event.payload.sceneSelection?.targetId,ownTarget.targetId);
    assert.notEqual(event.payload.openRequest?.targetId,ownTarget.targetId);
    assert.notEqual(event.payload.binding?.runId,binding(runA).runId);
  }
  for(const event of eventsA) assert.notEqual(event.payload.binding?.runId,binding(runB).runId);
  observations.push({label:'real-session-matrix',first:scopedState(afterA),second:scopedState(afterB),tree:tree.value,
    displayA:{status:displayA.status,binding:displayA.binding,runId:displayA.observation.status.runId},
    displayB:{status:displayB.status,binding:displayB.binding,runId:displayB.observation.status.runId},eventsA,eventsB});
  await first.getByRole('tab',{name:/^Empty Scene$|^Scene$/}).click();
  await second.getByRole('tab',{name:/^Empty Scene$|^Scene$/}).click();
};

try {
  await client.connect(transport);
  const first = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  pages.push(first);
  await first.addInitScript(wireProbe);
  await first.goto(url, { waitUntil: 'domcontentloaded' });
  await first.waitForURL(current => current.searchParams.has('forgeaxWorkspaceTarget'), { timeout: 180_000, waitUntil: 'domcontentloaded' });
  await first.waitForFunction(() => globalThis.__forgeaxViewReady?.mounted === true, undefined, { timeout: 60_000 });
  await showContentBrowser(first);
  await waitRunning(new URL(first.url()).searchParams.get('forgeaxWorkspaceTarget'));
  await snapshot('first-mounted');
  const second = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  pages.push(second);
  await second.addInitScript(wireProbe);
  await second.goto(url, { waitUntil: 'domcontentloaded' });
  await second.waitForURL(current => current.searchParams.has('forgeaxWorkspaceTarget'), { timeout: 180_000, waitUntil: 'domcontentloaded' });
  assert.notEqual(new URL(second.url()).searchParams.get('forgeaxWorkspaceTarget'), new URL(first.url()).searchParams.get('forgeaxWorkspaceTarget'), 'independent documents require distinct Engine targets');
  await second.waitForFunction(() => globalThis.__forgeaxViewReady?.mounted === true, undefined, { timeout: 60_000 });
  await showContentBrowser(second);
  const state = await snapshot('second-mounted');
  assert.equal(state.pages[0].packVisible, true, 'opening the second headed page must preserve the first project UI');
  assert.equal(state.pages[0].mounted, true, 'opening the second headed page must preserve the first mounted View');
  assert.equal(state.pages[1].mounted, true);
  assert.equal(state.status.value.pages.length, 2, 'both headed pages must retain their authenticated connections');
  assert.ok(state.status.value.pages.every(page => page.projectPhase === 'running'),
    'each page owner must report its project running, not merely a mounted Shell');
  const firstTargetId = new URL(first.url()).searchParams.get('forgeaxWorkspaceTarget');
  const firstConnection = state.status.value.pages.find(page => page.targets.some(target => target.targetId === firstTargetId))?.connectionId;
  assert.ok(firstConnection, 'status must identify the actual headed page target');
  const revision = `sha256:${createHash('sha256').update(await readFile(resolve(root, 'assets/scene.pack.json'))).digest('hex')}`;
  const revealArgs = { projectId: (await pageCall(first, 'tabs.get')).project.id, sourcePath: 'assets/scene.pack.json', revision };
  const tool = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  await matrix(first,second,tool);
  assert.equal((await tool('forgeax_view_workspace_pack_reveal', revealArgs)).error.code, 'view-page-ambiguous');
  const revealed = await tool('forgeax_view_workspace_pack_reveal', { ...revealArgs, connectionId: firstConnection });
  assert.equal(revealed.ok, true, JSON.stringify(revealed));
  assert.equal(revealed.value.code, 'shown');
  assert.equal(await first.locator('[data-cb-path="assets/scene.pack.json"]').first().getAttribute('aria-selected'), 'true');
  assert.notEqual(await second.locator('[data-cb-path="assets/scene.pack.json"]').first().getAttribute('aria-selected'), 'true');
  observations.push({ label: 'directed-reveal', revealed });
  const otherBeforeRefresh=scopedState(await pageCall(second,'tabs.get'));
  const displayBeforeRefresh=await pageCall(second,'display.status');
  await first.reload({ waitUntil: 'domcontentloaded' });
  await first.waitForFunction(() => globalThis.__forgeaxViewReady?.mounted === true, undefined, { timeout: 60_000 });
  await showContentBrowser(first);
  await waitRunning();
  const refreshed = await snapshot('first-refreshed');
  assert.equal(refreshed.status.value.pages.some(page => page.connectionId === firstConnection), false, 'refresh must retire the old page identity');
  assert.equal((await tool('forgeax_view_workspace_pack_reveal', { ...revealArgs, connectionId: firstConnection })).error.code, 'view-page-gone');
  assert.equal(refreshed.pages[1].packVisible, true);
  assert.equal(refreshed.status.value.pages.length, 2);
  assert.deepEqual(scopedState(await pageCall(second,'tabs.get')),otherBeforeRefresh,'refresh must preserve second resource and selection projection');
  assert.deepEqual((await pageCall(second,'display.status')).binding,displayBeforeRefresh.binding,'refresh must preserve second Display binding');
  assert.equal((await pageCall(first,'display.status')).binding,null,'new page must not inherit old Display intents');
  assert.equal(refreshed.pages[1].mounted, true, 'refreshing one headed page must preserve the other View');
  console.log(JSON.stringify({ ok: true, evidenceDirectory }));
} catch (error) {
  await snapshot('failure').catch(() => {});
  observations.push({ failure: { name: error.name, message: error.message } });
  throw error;
} finally {
  for (let index = 0; index < pages.length; index++)
    await pages[index].screenshot({ path: resolve(evidenceDirectory, `page-${index + 1}.png`) }).catch(() => {});
  await writeFile(resolve(evidenceDirectory, 'observations.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), browserVersion: browser.version(), root, observations,
  }, null, 2));
  await client.close();
  await browser.close();
}
