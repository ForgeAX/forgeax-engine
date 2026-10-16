import { mountSceneTreePanel } from '../../packages/view-plugin-scene-tree/src/ui/mount.tsx';
import { mountInspectorPanel } from '../../packages/view-plugin-inspector/src/ui/mount.tsx';
const state = { revision: 1, project: { id: 'fixture' }, preview: { target: { targetId: 'scene', generation: 1 } }, sceneSelection: { primary: { entityId: 'entity' } } };
const count = name => { const element = document.getElementById(name); element.textContent = String(Number(element.textContent) + 1); };
const client = { transport: { connected: true, request() {} }, onDisconnect: () => () => {},
  subscribe(listener) { listener(state); return () => {}; }, getState: async () => state,
  async getSceneTree() { count('sceneReads'); return { nodes: [], nextOffset: null }; },
  async call() { count('inspectorReads'); return { entityId: 'entity', components: [] }; },
};
const element = document.getElementById('panels');
await mountSceneTreePanel({ mountElement: document.getElementById('scene'), client });
await mountInspectorPanel({ mountElement: document.getElementById('inspector'), client });
document.getElementById('toggle').onclick = () => { element.hidden = !element.hidden; };
