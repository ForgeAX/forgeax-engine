import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProjectSession, projectSessionUrl, readProjectSession } from '../packages/view-workspace-core/src/project-session.ts';

function browser(href, type = 'navigate') {
  const storage = new Map();
  const visits = [];
  return {
    visits,
    location: { href, assign(value) { visits.push(value); }, replace(value) { visits.push(value); } },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    history: { replaceState() {} },
    performance: { getEntriesByType: () => [{ type }] },
  };
}
function client(initial) {
  let snapshot = initial;
  const calls = [];
  const listeners = new Set();
  return {
    calls,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getState: async () => snapshot,
    set(value) { snapshot = value; for (const fn of listeners) fn(value); },
    async openProject(root, options) {
      calls.push(['open', root, options]);
      return { project: { id: 'p', root }, projectTarget: { targetId: 'new', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=new' } };
    },
    async reopenProject(options) {
      calls.push(['recover', options]);
      return { project: { id: 'p', root: '/game' }, projectTarget: { targetId: 'new', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=new' } };
    },
    async openAsset(guid, options) {
      assert.equal(options.projectId, 'p', 'Resource restore carries the new project identity');
      calls.push(['asset', guid]); return {};
    },
  };
}

test('explicit URL intent opens only after connection and never starts Play', async () => {
  const window = browser('http://localhost:8000/?project=%2Fgame');
  const api = client({ revision: 1 });
  const session = createProjectSession(api, { window });
  assert.equal(session.getSnapshot().restoring, true, 'Keep stale workspace panels unmounted while opening');
  await session.ready;
  assert.deepEqual(api.calls.map(call => call[0]), ['open']);
  assert.equal(api.calls[0][1], '/game');
  assert.equal(api.calls[0][2].expectedTargetId, null);
  assert.equal(new URL(window.visits[0]).searchParams.get('forgeaxWorkspaceTarget'), 'new');
  session.dispose();
});

test('URL-less fixture target stays in the current document after project open', async () => {
  const window = browser('http://localhost:5175/?project=%2Ffixture%2Fproject');
  const api = client({ revision: 1 });
  api.openProject = async (root) => ({ project: { id: 'fixture-project', root }, projectTarget: { targetId: 'fixture-editor-target' } });
  const session = createProjectSession(api, { window });
  await session.ready;
  assert.equal(session.getSnapshot().restoring, false);
  assert.equal(session.getSnapshot().busy, false);
  assert.deepEqual(window.visits, []);
  session.dispose();
});

test('failed URL project intent ends restoration and can be explicitly retried', async () => {
  const window = browser('http://localhost:8000/?project=%2Fgame');
  const api = client({ revision: 1 });
  const open = api.openProject;
  api.openProject = async () => {
    throw new Error('Resident host sources changed; restart the backend before replacing browser sessions.');
  };
  const session = createProjectSession(api, { window });
  await session.ready;
  assert.equal(session.getSnapshot().restoring, false);
  assert.equal(session.getSnapshot().busy, false);
  assert.match(session.getSnapshot().error, /Resident host sources changed/);
  assert.deepEqual(window.visits, [], 'A rejected project must not navigate or start a renderer');
  api.openProject = open;
  await session.open('/game');
  assert.equal(session.getSnapshot().error, null);
  assert.equal(window.visits.length, 1);
  session.dispose();
});

test('refresh stays on the current document until the replacement browser is running', async () => {
  const record = { version: 1, root: '/game', entry: 'http://127.0.0.1:8000/', targetId: 'old', resources: ['scene'] };
  const window = browser(projectSessionUrl('http://localhost:9000/?forgeaxWorkspaceTarget=old', record), 'reload');
  const api = client({
    revision: 1,
    project: { id: 'p', root: '/game' },
    projectTarget: { targetId: 'old' },
    projectPhase: 'starting',
    browserGeneration: 1,
  });
  const session = createProjectSession(api, { window });
  assert.equal(session.getSnapshot().restoring, true, 'A reloaded target must not issue stale panel commands');
  await session.ready;
  assert.equal(session.getSnapshot().restoring, true);
  assert.deepEqual(api.calls, []);
  assert.deepEqual(window.visits, []);
  assert.equal(readProjectSession(window).targetId, 'old');
  assert.equal(readProjectSession(window).resources, undefined);
  api.set({
    revision: 2,
    project: { id: 'p', root: '/game' },
    projectTarget: { targetId: 'old' },
    projectPhase: 'running',
    browserGeneration: 2,
  });
  assert.equal(session.getSnapshot().restoring, false);
  assert.equal(session.getSnapshot().busy, false);
  assert.deepEqual(window.visits, []);
  session.dispose();
});

test('refresh hides the shell again when a running snapshot is followed by detach', async () => {
  const record = { version: 1, root: '/game', entry: 'http://127.0.0.1:8000/', targetId: 'old' };
  const window = browser(projectSessionUrl('http://localhost:9000/?forgeaxWorkspaceTarget=old', record), 'reload');
  const api = client({
    revision: 1,
    project: { id: 'p', root: '/game' },
    projectTarget: { targetId: 'old' },
    projectPhase: 'running',
    browserGeneration: 1,
  });
  const session = createProjectSession(api, { window });
  await session.ready;
  assert.equal(session.getSnapshot().restoring, false);
  api.set({
    revision: 2,
    project: { id: 'p', root: '/game' },
    projectTarget: { targetId: 'old' },
    projectPhase: 'starting',
    browserGeneration: 1,
  });
  assert.equal(session.getSnapshot().restoring, true);
  api.set({
    revision: 3,
    project: { id: 'p', root: '/game' },
    projectTarget: { targetId: 'old' },
    projectPhase: 'running',
    browserGeneration: 1,
  });
  assert.equal(session.getSnapshot().restoring, true);
  api.set({
    revision: 4,
    project: { id: 'p', root: '/game' },
    projectTarget: { targetId: 'old' },
    projectPhase: 'running',
    browserGeneration: 2,
  });
  assert.equal(session.getSnapshot().restoring, false);
  assert.deepEqual(api.calls, []);
  assert.deepEqual(window.visits, []);
  session.dispose();
});

test('refresh carries the document identity even when optional tab storage is unavailable', async () => {
  const record = { version: 1, root: '/game', entry: 'http://127.0.0.1:8000/', targetId: 'old' };
  const window = browser(projectSessionUrl('http://localhost:9000/?forgeaxWorkspaceTarget=old', record), 'reload');
  window.sessionStorage = undefined;
  const api = client({ revision: 1, project: { id: 'p', root: '/game' }, projectTarget: { targetId: 'old' } });
  const session = createProjectSession(api, { window });
  await session.ready;
  assert.deepEqual(api.calls, []);
  assert.deepEqual(window.visits, []);
  assert.equal(session.getSnapshot().restoring, false);
  assert.equal(new URL(window.location.href).searchParams.get('forgeaxWorkspaceTarget'), 'old');
  session.dispose();
});

test('project navigation holds activation until pagehide and is cancellable by its owner', async () => {
  for (const cancel of [false, true]) {
    const window = browser('http://localhost:8000/?project=%2Fgame');
    const events = new EventTarget();
    window.addEventListener = events.addEventListener.bind(events);
    window.removeEventListener = events.removeEventListener.bind(events);
    const api = client({ revision: 1 });
    const session = createProjectSession(api, { window });
    let ready = false;
    void session.ready.then(() => { ready = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(window.visits.length, 1);
    assert.equal(ready, false, 'The departing document must not proceed to renderer activation');
    if (cancel) session.dispose();
    else events.dispatchEvent(new Event('pagehide'));
    await session.ready;
    session.dispose();
    assert.equal(ready, true);
  }
});

test('recovery fences the old target and drops old resource references', async () => {
  const record = { version: 1, root: '/game', entry: 'http://localhost:8000/', targetId: 'old', resources: ['scene', 'mesh'] };
  const window = browser(projectSessionUrl(record.entry, record));
  const api = client({ revision: 2, project: { root: '/game' }, projectTarget: { targetId: 'old' } });
  const session = createProjectSession(api, { window });
  assert.equal(session.getSnapshot().restoring, true, 'The View entry remains a transfer page');
  await session.ready;
  assert.equal(api.calls[0][0], 'recover');
  assert.equal(api.calls[0][1].expectedTargetId, 'old');
  assert.equal(api.calls[0][1].expectedTargetState, 'lost');
  const transferred = readProjectSession(browser(window.visits[0]));
  assert.equal(transferred.resources, undefined);
  assert.equal(transferred.targetId, 'new');
  session.dispose();
});

test('a different current target is a terminal conflict, not a replacement or replay', async () => {
  const record = { version: 1, root: '/game', entry: 'http://localhost:8000/', targetId: 'old' };
  const window = browser(projectSessionUrl(record.entry, record));
  const api = client({ revision: 2, project: { root: '/game' }, projectTarget: { targetId: 'someone-else' } });
  const session = createProjectSession(api, { window });
  await session.ready;
  assert.deepEqual(api.calls, []);
  assert.match(session.getSnapshot().error, /another page/);
  assert.equal(session.getSnapshot().restoring, false);
  assert.deepEqual(window.visits, []);
  session.dispose();
});

test('replacement starts fresh and ignores older baselines', async () => {
  const record = { version: 1, root: '/game', entry: 'http://localhost:8000/', targetId: 'new', resources: ['scene', 'mesh'] };
  const window = browser(projectSessionUrl('http://localhost:9000/?forgeaxWorkspaceTarget=new', record));
  const api = client({ revision: 3, project: { id: 'p', root: '/game' }, projectTarget: { targetId: 'new' } });
  const session = createProjectSession(api, { window });
  assert.equal(session.getSnapshot().restoring, false, 'A fresh target may mount workspace panels');
  await session.ready;
  assert.deepEqual(api.calls, []);
  api.set({ revision: 1, project: { root: '/stale' } });
  assert.equal(session.getSnapshot().snapshot.project.root, '/game');
  session.dispose();
});

test('restoration cannot navigate to a foreign origin or run after owner disposal', async () => {
  const window = browser(projectSessionUrl('http://localhost:8000/', {
    version: 1, root: '/game', entry: 'https://foreign.example/', targetId: 'old',
  }));
  assert.equal(readProjectSession(window), null);
  let resolve;
  const api = client({});
  api.getState = () => new Promise(done => { resolve = done; });
  const session = createProjectSession(api, { window: browser('http://localhost:8000/?project=%2Fgame') });
  session.dispose();
  resolve({});
  await session.ready;
  assert.deepEqual(api.calls, []);
});

test('legacy resource history cannot trigger commands or errors in a new document', async () => {
  const record = { version: 1, root: '/game', targetId: 'new', resources: ['removed', 'scene', 'mesh'] };
  const window = browser(projectSessionUrl('http://localhost:9000/?forgeaxWorkspaceTarget=new', record));
  const api = client({ revision: 3, project: { id: 'p', root: '/game' }, projectTarget: { targetId: 'new' } });
  const openAsset = api.openAsset;
  api.openAsset = async (guid, options) => {
    if (guid === 'removed') throw new Error('Asset no longer exists');
    return openAsset(guid, options);
  };
  const session = createProjectSession(api, { window });
  await session.ready;
  assert.deepEqual(api.calls, []);
  assert.equal(session.getSnapshot().error, null);
  session.dispose();
});

test('a project opened outside the page is adopted by a connected empty shell', async () => {
  const window = browser('http://localhost:8000/');
  const api = client({ revision: 1 });
  const session = createProjectSession(api, { window });
  await session.ready;
  assert.deepEqual(window.visits, []);
  // `view project open` allocates the headed target after the shell connected.
  api.set({
    revision: 2,
    project: { id: 'p', root: '/game' },
    projectTarget: { targetId: 'new', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=new&forgeaxWorkspaceSession=s1' },
  });
  assert.equal(window.visits.length, 1);
  assert.equal(new URL(window.visits[0]).searchParams.get('forgeaxWorkspaceTarget'), 'new');
  // The adoption transfers a session record so a refresh can recover.
  assert.equal(readProjectSession(browser(window.visits[0])).targetId, 'new');
  api.set({ revision: 3, project: { id: 'p', root: '/game' },
    projectTarget: { targetId: 'new', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=new' } });
  assert.equal(window.visits.length, 1, 'Later snapshots cannot repeat a pending navigation');
  session.dispose();
});

test('remote project adoption cannot override a conflicting explicit URL project', async () => {
  const window = browser('http://localhost:8000/?project=%2Frequested');
  const api = client({ revision: 1, project: { root: '/someone-else' },
    projectTarget: { targetId: 'other', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=other' } });
  const session = createProjectSession(api, { window });
  await session.ready;
  assert.match(session.getSnapshot().error, /Another project/);
  assert.deepEqual(window.visits, []);
  assert.deepEqual(api.calls, []);
  session.dispose();
});

test('a project opened before the page loads is adopted on the first snapshot', async () => {
  const window = browser('http://localhost:8000/');
  const api = client({
    revision: 1,
    project: { id: 'p', root: '/game' },
    projectTarget: { targetId: 'new', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=new&forgeaxWorkspaceSession=s1' },
  });
  const session = createProjectSession(api, { window });
  await session.ready;
  assert.equal(window.visits.length, 1);
  assert.equal(new URL(window.visits[0]).searchParams.get('forgeaxWorkspaceSession'), 's1');
  session.dispose();
});

test('a page that remembers another target keeps its conflict instead of adopting', async () => {
  const record = { version: 1, root: '/game', entry: 'http://localhost:8000/', targetId: 'old' };
  const window = browser(projectSessionUrl(record.entry, record));
  const api = client({
    revision: 2,
    project: { root: '/game' },
    projectTarget: { targetId: 'someone-else', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=someone-else&forgeaxWorkspaceSession=s2' },
  });
  const session = createProjectSession(api, { window });
  await session.ready;
  assert.deepEqual(window.visits, []);
  assert.match(session.getSnapshot().error, /another page/);
  session.dispose();
});

test('malformed layout references are rejected and reconnect delay is owned', async () => {
  const record = { version: 1, root: '/game', entry: 'http://localhost:8000/', targetId: 'old' };
  assert.equal(readProjectSession(browser(projectSessionUrl(record.entry,
    { ...record, presentation: { pageOrder: 'scene' } }))), null);
  const window = browser(projectSessionUrl('http://localhost:9000/?forgeaxWorkspaceTarget=old', record));
  let probes = 0;
  window.fetch = async () => { probes++; return { ok: true }; };
  const api = client({ revision: 1, project: { id: 'p', root: '/game' }, projectTarget: { targetId: 'old' } });
  const session = createProjectSession(api, { window });
  await session.ready;
  const pending = session.reconnectHost();
  assert.equal(session.reconnectHost(), pending);
  session.dispose();
  await pending;
  assert.equal(probes, 0);
  assert.deepEqual(window.visits, []);
});

test('local project open navigates once when its state notification precedes its response', async () => {
  const window = browser('http://localhost:8000/');
  const api = client({ revision: 1 });
  const open = api.openProject;
  api.openProject = async (...args) => {
    const snapshot = { ...await open(...args), revision: 2 };
    api.set(snapshot);
    return snapshot;
  };
  const session = createProjectSession(api, { window });
  try {
    await session.ready;
    await session.open('/game');
    assert.equal(window.visits.length, 1);
    assert.equal(readProjectSession(browser(window.visits[0])).targetId, 'new');
  } finally { session.dispose(); }
});

test('an empty artifact shell never navigates to a failed presentation target', async () => {
 const window=browser('http://localhost:8000/');
 const api=client({revision:1,project:{id:'p',root:'/game'},projectPhase:'failed',projectTarget:{targetId:'retired',url:'http://localhost:9000/'}});
 const session=createProjectSession(api,{window});await session.ready;
 assert.deepEqual(window.visits,[]);assert.deepEqual(api.calls,[]);
 session.dispose();
});

test('embedded platform navigation releases restoration only after its exact target document is prepared', async () => {
  const window = browser('http://localhost:8000/?project=%2Fgame');
  const api = client({ revision: 1 });
  let complete;
  let requested;
  const prepared = new Promise(resolve => { complete = resolve; });
  const session = createProjectSession(api, { window, navigate: async (url, options) => {
    requested = new URL(url);
    assert.equal(options.signal.aborted, false);
    await prepared;
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requested.searchParams.get('forgeaxWorkspaceTarget'), 'new');
  assert.equal(session.getSnapshot().restoring, true);
  assert.deepEqual(window.visits, [], 'The outer document remains attached');
  complete();
  await session.ready;
  assert.equal(session.getSnapshot().restoring, false);
  assert.equal(session.getSnapshot().error, null);
  session.dispose();
});
