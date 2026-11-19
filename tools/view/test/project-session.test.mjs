import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProjectSession, projectSessionUrl, readProjectSession } from '../packages/view-workspace-core/src/project-session.ts';

function browser(href, type = 'navigate') {
  const storage = new Map();
  const visits = [];
  const value = {
    visits,
    location: { href, assign(value) { visits.push(value); }, replace(value) { visits.push(value); } },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    history: { replaceState(_state, _title, nextHref) { if (nextHref) value.location.href = new URL(nextHref, value.location.href).href; } },
    performance: { getEntriesByType: () => [{ type }] },
  };
  return value;
}
function client(initial) {
  const withPresentation = value => Object.hasOwn(value, 'projectDocumentPresentation')
    ? value
    : { ...value, projectDocumentPresentation: 'presenter' };
  let snapshot = withPresentation(initial);
  const calls = [];
  const listeners = new Set();
  return {
    calls,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getState: async () => snapshot,
    set(value) { snapshot = withPresentation(value); for (const fn of listeners) fn(snapshot); },
    async openProject(root, options) {
      calls.push(['open', root, options]);
      return { project: { id: 'p', root }, projectTarget: { targetId: 'new', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=new' }, projectDocumentPresentation: 'presenter' };
    },
    async reopenProject(options) {
      calls.push(['recover', options]);
      return { project: { id: 'p', root: '/game' }, projectTarget: { targetId: 'new', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=new' }, projectDocumentPresentation: 'presenter' };
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
  const session = createProjectSession(api, { role: 'shell', window });
  assert.equal(session.getSnapshot().restoring, true, 'Keep stale workspace panels unmounted while opening');
  await session.ready;
  assert.deepEqual(api.calls.map(call => call[0]), ['open']);
  assert.equal(api.calls[0][1], '/game');
  assert.deepEqual(api.calls[0][2].expectedProject, { kind: 'empty' });
  assert.deepEqual(window.visits, []);
  assert.equal(readProjectSession(window).targetId, 'new');
  session.dispose();
});

test('URL-less fixture target stays in the current document after project open', async () => {
  const window = browser('http://localhost:5175/?project=%2Ffixture%2Fproject');
  const api = client({ revision: 1 });
  api.openProject = async (root) => ({ project: { id: 'fixture-project', root }, projectTarget: { targetId: 'fixture-scene-target' } });
  const session = createProjectSession(api, { role: 'shell', window });
  await session.ready;
  assert.equal(session.getSnapshot().restoring, false);
  assert.equal(session.getSnapshot().busy, false);
  assert.deepEqual(window.visits, []);
  session.dispose();
});

test('URL-less fixture target is reused after refresh', async () => {
  const window = browser('http://localhost:5080/?project=%2Ffixture%2Fproject', 'reload');
  const api = client({ revision: 1, project: { id: 'fixture-project', root: '/fixture/project' },
    projectTarget: { targetId: 'fixture-scene-target' } });
  const session = createProjectSession(api, { role: 'shell', window });
  await session.ready;
  assert.deepEqual(api.calls, []);
  assert.deepEqual(window.visits, []);
  assert.equal(session.getSnapshot().error, null);
  session.dispose();
});

test('failed URL project intent ends restoration and can be explicitly retried', async () => {
  const window = browser('http://localhost:8000/?project=%2Fgame');
  const api = client({ revision: 1 });
  const open = api.openProject;
  api.openProject = async () => {
    throw new Error('Resident host sources changed; restart the backend before replacing browser sessions.');
  };
  const session = createProjectSession(api, { role: 'shell', window });
  await session.ready;
  assert.equal(session.getSnapshot().restoring, false);
  assert.equal(session.getSnapshot().busy, false);
  assert.match(session.getSnapshot().error, /Resident host sources changed/);
  assert.deepEqual(window.visits, [], 'A rejected project must not navigate or start a renderer');
  api.openProject = open;
  await session.open('/game');
  assert.equal(session.getSnapshot().error, null);
  assert.equal(window.visits.length, 0);
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
  const session = createProjectSession(api, { role: 'shell', window });
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
  const session = createProjectSession(api, { role: 'shell', window });
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
  const session = createProjectSession(api, { role: 'shell', window });
  await session.ready;
  assert.deepEqual(api.calls, []);
  assert.deepEqual(window.visits, []);
  assert.equal(session.getSnapshot().restoring, false);
  assert.equal(new URL(window.location.href).searchParams.get('forgeaxWorkspaceTarget'), 'old');
  session.dispose();
});

test('Shell project open admits the headed document without transferring its outer URL', async () => {
  const window = browser('http://localhost:8000/?project=%2Fgame');
  const session = createProjectSession(client({ revision: 1 }), { role: 'shell', window });
  await session.ready;
  assert.deepEqual(window.visits, []);
  assert.equal(readProjectSession(window).targetId, 'new');
  session.dispose();
});

test('retained Shell records the admitted project document without leaving its outer URL', async () => {
  const window = browser('http://localhost:8000/');
  const api = client({ revision: 1 });
  const session = createProjectSession(api, { role: 'shell', window });
  await session.open('/game');
  assert.deepEqual(window.visits, []);
  assert.deepEqual(api.calls.map(call => call[0]), ['open']);
  assert.equal(readProjectSession(window).targetId, 'new');
  assert.equal(session.getSnapshot().busy, false);
  session.dispose();
});

test('explicit same-project recovery fences the old target and drops old resource references', async () => {
  const record = { version: 1, root: '/game', entry: 'http://localhost:8000/', targetId: 'old', resources: ['scene', 'mesh'] };
  const window = browser(projectSessionUrl(record.entry, record));
  const api = client({ revision: 2, project: { root: '/game' }, projectTarget: { targetId: 'old' }, projectStatus: {
    phase: 'failed', sessionId: 'session-old', generation: 7,
    failure: { code: 'engine-workspace-page-lost', expected: 'page', hint: 'reload' },
  } });
  const session = createProjectSession(api, { role: 'shell', window });
  await session.ready;
  assert.equal(api.calls.length, 0, 'cached session data never triggers recovery');
  await session.open('/game');
  assert.equal(api.calls[0][0], 'recover');
  assert.deepEqual(api.calls[0][1].expectedProject, {
    kind: 'session', sessionId: 'session-old', generation: 7, recovery: 'lost',
  });
  const recovered = readProjectSession(window);
  assert.equal(recovered.resources, undefined);
  assert.equal(recovered.targetId, 'new');
  assert.deepEqual(window.visits, []);
  session.dispose();
});

test('an exact page target cannot recover over a different backend target', async () => {
  const window = browser('http://localhost:8000/?forgeaxWorkspaceTarget=old');
  const api = client({ revision: 2, project: { root: '/game' }, projectTarget: { targetId: 'someone-else' } });
  const session = createProjectSession(api, { role: 'shell', window });
  await session.ready;
  await session.open('/game');
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
  const session = createProjectSession(api, { role: 'shell', window });
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
  const session = createProjectSession(api, { role: 'shell', window: browser('http://localhost:8000/?project=%2Fgame') });
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
  const session = createProjectSession(api, { role: 'shell', window });
  await session.ready;
  assert.deepEqual(api.calls, []);
  assert.equal(session.getSnapshot().error, null);
  session.dispose();
});

test('a project opened outside the page is admitted by a connected empty shell without navigation', async () => {
  const window = browser('http://localhost:8000/');
  const api = client({ revision: 1 });
  const session = createProjectSession(api, { role: 'shell', window });
  await session.ready;
  assert.deepEqual(window.visits, []);
  // `view project open` allocates the headed target after the shell connected.
  api.set({
    revision: 2,
    project: { id: 'p', root: '/game' },
    projectTarget: { targetId: 'new', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=new&forgeaxWorkspaceSession=s1' },
  });
  assert.equal(window.visits.length, 0);
  // The Shell records the document identity while keeping its outer URL.
  assert.equal(readProjectSession(window).targetId, 'new');
  api.set({ revision: 3, project: { id: 'p', root: '/game' },
    projectTarget: { targetId: 'new', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=new' } });
  assert.equal(window.visits.length, 0, 'The Shell never follows the child document URL');
  assert.equal(window.location.href, 'http://localhost:8000/');
  session.dispose();
});

test('an explicit project URL switches through the current backend session CAS', async () => {
  const window = browser('http://localhost:8000/?project=%2Frequested');
  const api = client({ revision: 1, project: { root: '/someone-else' },
    projectTarget: { targetId: 'other', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=other' },
    projectStatus: { phase: 'running', sessionId: 'current-session', generation: 4,
      document: { sessionId: 'current-session', targetId: 'other', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=other' } } });
  const session = createProjectSession(api, { role: 'shell', window });
  await session.ready;
  assert.equal(session.getSnapshot().error, null);
  assert.equal(api.calls[0][0], 'open');
  assert.equal(api.calls[0][1], '/requested');
  assert.deepEqual(api.calls[0][2].expectedProject, {
    kind: 'session', sessionId: 'current-session', generation: 4,
  });
  assert.deepEqual(window.visits, []);
  session.dispose();
});

test('a project opened before the page loads is adopted on the first snapshot', async () => {
  const window = browser('http://localhost:8000/');
  const api = client({
    revision: 1,
    project: { id: 'p', root: '/game' },
    projectTarget: { targetId: 'new', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=new&forgeaxWorkspaceSession=s1' },
  });
  const session = createProjectSession(api, { role: 'shell', window });
  await session.ready;
  assert.equal(window.visits.length, 0);
  assert.equal(readProjectSession(window).targetId, 'new');
  session.dispose();
});

test('an observer shell keeps project document identity until presenter admission', async () => {
  const window = browser('http://localhost:8000/');
  const api = client({
    revision: 1,
    project: { id: 'p', root: '/game' },
    projectDocument: { sessionId: 'session-1', targetId: 'new', url: 'http://localhost:9000/hidden' },
    projectDocumentPresentation: 'observer',
  });
  const session = createProjectSession(api, { role: 'shell', window });
  await session.ready;
  assert.equal(readProjectSession(window), null, 'an observer does not persist the hidden document URL or identity');
  api.set({
    revision: 2,
    project: { id: 'p', root: '/game' },
    projectDocument: { sessionId: 'session-1', targetId: 'new', url: 'http://localhost:9000/hidden' },
    projectDocumentPresentation: 'presenter',
  });
  assert.equal(readProjectSession(window).targetId, 'new');
  assert.deepEqual(window.visits, []);
  session.dispose();
});

test('an invalid explicit project switch preserves the current backend target', async () => {
  const window = browser('http://localhost:8000/?project=%2Frequested');
  const api = client({ revision: 2, project: { root: '/current' }, projectTarget: { targetId: 'current-target' },
    projectStatus: { phase: 'running', sessionId: 'session-current', generation: 9 } });
  api.openProject = async (_root, options) => {
    api.calls.push(['open', _root, options]);
    throw new Error('expected project session changed');
  };
  const session = createProjectSession(api, { role: 'shell', window });
  await session.ready;
  assert.deepEqual(api.calls[0][2].expectedProject, {
    kind: 'session', sessionId: 'session-current', generation: 9,
  });
  assert.match(session.getSnapshot().error, /expected project session changed/);
  assert.equal(readProjectSession(window)?.targetId, undefined);
  assert.deepEqual(window.visits, []);
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
  const session = createProjectSession(api, { role: 'shell', window });
  await session.ready;
  const pending = session.reconnectHost();
  assert.equal(session.reconnectHost(), pending);
  session.dispose();
  await pending;
  assert.equal(probes, 0);
  assert.deepEqual(window.visits, []);
});

test('local project open records once when its state notification precedes its response', async () => {
  const window = browser('http://localhost:8000/');
  const api = client({ revision: 1 });
  const open = api.openProject;
  api.openProject = async (...args) => {
    const snapshot = { ...await open(...args), revision: 2 };
    api.set(snapshot);
    return snapshot;
  };
  const session = createProjectSession(api, { role: 'shell', window });
  try {
    await session.ready;
    await session.open('/game');
    assert.equal(window.visits.length, 0);
    assert.equal(readProjectSession(window).targetId, 'new');
  } finally { session.dispose(); }
});

test('an empty artifact shell never navigates to a failed presentation target', async () => {
 const window=browser('http://localhost:8000/');
 const api=client({revision:1,project:{id:'p',root:'/game'},projectPhase:'failed',projectTarget:{targetId:'retired',url:'http://localhost:9000/'}});
 const session=createProjectSession(api,{role:'shell',window});await session.ready;
 assert.deepEqual(window.visits,[]);assert.deepEqual(api.calls,[]);
 session.dispose();
});

test('document admission from starting preserves the Shell URL and records its identity', async () => {
  const window = browser('http://localhost:8000/');
  const api = client({ revision: 1 });
  const session = createProjectSession(api, { role: 'shell', window });
  await session.ready;
  api.set({ revision: 2, project: { id: 'p', root: '/game' }, projectPhase: 'starting',
    projectStatus: { phase: 'starting', sessionId: 'session-1', generation: 1,
      document: { sessionId: 'session-1', targetId: 'new', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=new', browserGeneration: 0 } },
    projectDocument: { sessionId: 'session-1', targetId: 'new', url: 'http://localhost:9000/?forgeaxWorkspaceTarget=new', browserGeneration: 0 } });
  assert.deepEqual(window.visits, []);
  assert.equal(readProjectSession(window).targetId, 'new');
  session.dispose();
});
