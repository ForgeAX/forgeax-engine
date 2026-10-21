// Explicit UI fixture responses; this does not establish Engine resource identity support.
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { mountInspectorPanel } from '../../packages/view-plugin-inspector/src/ui/mount';
import { setLocale } from '../../packages/view-plugin-inspector/src/i18n/index.ts';
import { entityInspectorCases, fixtureTransform } from './entity-inspections';

setLocale('zh');
let revision = 1;
let projectId = 'project';
let generation = 1;
let selected = 'floor';
let selectedIds = ['floor'];
let missingBindings = false;
let explicitGuids = false;
let meshName = 'Farm Floor / Unified Static Mesh With A Long Resource Name';
let failOperation: string | undefined;
let deferInspection = false;
let finishInspection: (() => void) | undefined;
let copyText = '';
let clipboardWrites = 0;
const removedComponents = new Set<string>();
const calls: { operation: string; args: Record<string, unknown>; aborted: boolean }[] = [];
let sceneTreeRequests = 0;
const listeners = new Set<(state: ReturnType<typeof state>) => void>();
const target = () => ({ targetId: 'scene', generation });
const state = () => ({ revision, project: { id: projectId, name: 'Inspector fixture', root: '/fixture' }, preview: { target: target() }, sceneSelection: { primary: { entityId: selected }, entityIds: selectedIds }, assets: [
  { guid: 'mesh-guid', kind: 'mesh', name: meshName, path: 'assets/farm.pack.ts', previewable: true },
  { guid: 'ground-material', kind: 'material', name: 'Farm Ground', path: 'assets/farm.pack.ts', previewable: true },
  { guid: 'trim-material', kind: 'material', name: 'Painted Trim', path: 'assets/farm.pack.ts', previewable: true },
] });
const changed = () => { revision++; for (const listener of listeners) listener(state()); };
const nodes = [
  { entityId: 'world', entity: 11, name: 'World', parentId: null, componentNames: ['Transform', 'SceneInstance'] },
  { entityId: 'floor', entity: 0, name: 'Farm Floor', parentId: 'world', componentNames: ['Entity', 'Transform', 'GlobalTransform', 'ChildOf', 'Name', 'MeshFilter', 'MeshRenderer', 'Visibility', 'RigidBody', 'CustomHealth'] },
  { entityId: 'part', entity: 1, name: 'Floor Trim', parentId: 'floor', componentNames: ['Transform', 'MeshFilter', 'MeshRenderer'] },
  { entityId: 'leaf', entity: 2, name: null, parentId: 'part', componentNames: ['Transform'] },
  { entityId: 'light', entity: 3, name: 'Sun', parentId: 'world', componentNames: ['DirectionalLight'] },
  ...entityInspectorCases.map((item, index) => ({ entityId: `case-${item.kind}`, entity: index + 100, name: `Fixture / ${item.kind} / Long Named Scene Object`, parentId: 'world', componentNames: ['Entity', 'Transform', ...item.components.map(component => component.name)] })),
  { entityId: 'bare', entity: 50, name: null, parentId: 'world', componentNames: ['Entity'] },
];
function inspect(id: string) {
  const node = nodes.find(n => n.entityId === id)!;
  const component = (name: string, fields: Record<string, unknown>, values: unknown) => ({ name, fields, values, schema: {}, meta: {}, writable: false });
  const fixture = entityInspectorCases.find(item => `case-${item.kind}` === id);
  const components = fixture ? [component('Entity', { self: { type: 'entity' } }, { self: node.entity }), { ...fixtureTransform, values: { ...fixtureTransform.values, pos: [0.123456789, -1234.56789, 1e12], quat: [0.123456789, 0.2, 0.3, 0.4] } }, ...fixture.components]
    : id === 'bare' ? [component('Entity', { self: { type: 'entity' } }, { self: node.entity })]
    : id === 'world' ? [component('Entity', { self: { type: 'entity' } }, { self: node.entity }), fixtureTransform, ...entityInspectorCases.find(item => item.kind === 'sceneInstance')!.components]
    : id === 'light' ? [component('DirectionalLight', { intensity: { type: 'f32' } }, { intensity: 3 })] : [
    component('Entity', { self: { type: 'entity' } }, { self: node.entity }),
    component('Transform', { pos: { type: 'array<f32, 3>' }, quat: { type: 'array<f32, 4>' }, scale: { type: 'array<f32, 3>' } }, { pos: [0, -0.2800000011920929, 0], quat: [-0.2588190451, 0, 0, 0.9659258263], scale: [1, 1, 1] }),
    component('GlobalTransform', { world: { type: 'array<f32, 16>' }, presentation: { type: 'array<f32, 16>' } }, { world: Array(16).fill(0), presentation: Array(16).fill(1) }),
    component('TransformInterpolation', {}, {}),
    component('ChildOf', { parent: { type: 'entity' } }, { parent: 11 }),
    component('Name', { value: { type: 'string' } }, { value: node.name }),
    component('MeshFilter', { assetHandle: { type: 'asset<mesh>' } }, { assetHandle: missingBindings ? undefined : explicitGuids ? 'mesh-guid' : 1025 }),
    component('MeshRenderer', { materials: { type: 'array<asset<material>>' }, lightingChannels: { type: 'f64' } }, { materials: explicitGuids ? ['ground-material', 'trim-material', 0] : [1026, 1027, 0], lightingChannels: 4294967295 }),
    component('Visibility', { state: { type: 'enum', labels: { inherited: 0, hidden: 1, visible: 2 } } }, { state: 2 }),
    component('RigidBody', { bodyType: { type: 'enum', labels: { static: 0, dynamic: 1 } } }, { bodyType: 0 }),
    component('CustomHealth', { health: { type: 'f32' } }, { health: 7 }),
  ];
  return {
    entityId: id, entity: node.entity, name: node.name, targetId: 'scene', worldId: 'world', sampledAt: Date.now(),
    components: components.filter(component => !removedComponents.has(component.name)),
  };
}
const client = {
  transport: { connected: true, async request() {} },
  subscribe(listener: (snapshot: ReturnType<typeof state>) => void) { listeners.add(listener); listener(state()); return () => listeners.delete(listener); },
  onDisconnect() { return () => {}; },
  async getState() { return state(); },
  async getSceneTree() { sceneTreeRequests++; return { nodes, revision: 1, nextOffset: null }; },
  async call(operation: string, args: Record<string, unknown>, options: { signal?: AbortSignal } = {}) {
    const call = { operation, args, aborted: false }; calls.push(call);
    options.signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
    if (operation === failOperation) throw new Error(`${operation} unavailable`);
    if (operation === 'entity.inspect') {
      const result = inspect(String(args.entityId));
      if (deferInspection) { deferInspection = false; await new Promise<void>(resolve => { finishInspection = resolve; }); }
      return result;
    }
    if (operation === 'scene.select') { selected = String(args.entityId); selectedIds = [selected]; changed(); return state(); }
    if (operation === 'entity.focus') return { entityId: args.entityId };
    if (operation === 'asset.open') return { asset: { guid: args.guid } };
    throw new Error(`Unexpected fixture operation ${operation}`);
  },
};
Object.assign(globalThis, { meshInspectorFixture: {
  calls,
  sceneTreeRequests: () => sceneTreeRequests,
  copyText: () => copyText,
  clipboardWrites: () => clipboardWrites,
  select(id: string, entityIds = [id]) { selected = id; selectedIds = entityIds; changed(); },
  missingBindings() { missingBindings = true; changed(); },
  explicitGuids() { explicitGuids = true; changed(); },
  renameMesh() { meshName = 'Updated Floor Mesh'; changed(); },
  fail(operation: string) { failOperation = operation; },
  restoreTools() { failOperation = undefined; changed(); },
  deferInspection() { deferInspection = true; },
  inspectionPending() { return finishInspection !== undefined; },
  finishInspection() { finishInspection?.(); },
  replaceTarget() { generation++; changed(); },
  replaceProject() { projectId = 'replacement-project'; changed(); },
  removeComponent(name: string) { removedComponents.add(name); changed(); },
  restoreComponents() { removedComponents.clear(); changed(); },
} });
await mountInspectorPanel({
  client: client as unknown as ViewWorkspaceClient,
  mountElement: document.getElementById('app')!,
  writeClipboard: async value => { copyText = value; clipboardWrites++; },
});
