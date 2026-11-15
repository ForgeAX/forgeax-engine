import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import type { AssetReferenceService } from '@forgeax/view-workspace-core/asset-references';
import { mountInspectorPanel } from '../../packages/view-plugin-inspector/src/ui/mount';
import { setLocale } from '../../packages/view-plugin-inspector/src/i18n/index.ts';

setLocale('en');
const calls: { operation: string; args: Record<string, unknown> }[] = [];
const clipboard: string[] = [];
const material = { guid: 'material-guid', kind: 'cloud-material', name: 'Reference layout', sourceKey: 'material/reference-layout', path: 'assets/clouds/clouds.pack.ts' };
let target = { targetId: 'scene-preview', generation: 3, worldId: 'world-cloud' };
const scope = { projectId: 'cloud-project', targetId: target.targetId, targetGeneration: target.generation, worldId: target.worldId, browserGeneration: 1 };
const referenceState = { phase: 'ready', scope } as const;
const values = {
  material: 1030, enabled: true, bottomMeters: 5000, thicknessMeters: 10000,
  extinctionOverridePerMeter: -1, entryLimitMeters: 350000, traceLimitMeters: 200000,
  viewSampleCountScale: 1, stopTransmittance: 0.005,
  layoutWeight: -1, maskWeight: -1, profileWeight: -1, bodyWeight: -1, erosionWeight: -1,
  coverageBias: -2, windOffsetMeters: [46000, 0, -35000], useDetail: 2, skipEmpty: true,
  diagnosticMode: 0, diagnosticPixelX: 0, diagnosticPixelY: 0,
  materialInstance: 0, phaseG: 0.15, phaseG2: -0.2, phaseBlend: 0,
  multiScatteringOctaves: 2, msContribution: 0.5, msOcclusion: 0.5, msEccentricity: 0.5,
  selfShadow: true, shadowMode: 1, shadowSamples: 10, shadowDistanceMeters: 15000,
  castCloudShadows: false, shadowExtentMeters: 40000, shadowDepthBiasMeters: 0,
  shadowStrength: 1, surfaceShadowStrength: 1, shadowResolution: 128, shadowMapSamples: 64,
  initializationRevision: 2,
};
const fields = Object.fromEntries(Object.keys(values).map(key => [key, {
  type: key === 'material' ? 'asset<cloud-material>' : key === 'materialInstance' ? 'asset<cloud-material-instance>' : ['enabled', 'skipEmpty', 'selfShadow', 'castCloudShadows'].includes(key) ? 'bool'
    : key === 'windOffsetMeters' ? 'array<f32, 3>' : key === 'useDetail' || key.startsWith('diagnostic') ? 'u32' : 'f32',
}]));
const inspection = {
  entityId: 'world-cloud:7', entity: 7, targetId: target.targetId, worldId: target.worldId, name: 'Reference Cloud',
  source: { guid: 'scene-guid', sourcePath: 'assets/game.pack.ts', sourceKey: 'scene/ground-reference', address: 'cloud' },
  components: [
    { name: 'Entity', fields: { self: { type: 'entity' } }, values: { self: 7 } },
    { name: 'Transform', fields: { pos: { type: 'array<f32, 3>' }, quat: { type: 'array<f32, 4>' }, scale: { type: 'array<f32, 3>' } },
      values: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { name: 'VolumetricCloudLayer', fields, values },
  ],
};
const runtime = {targetId:target.targetId,worldId:target.worldId,frame:{frameId:42,deviceGeneration:3},cloudLayer:{'world-cloud:camera':{
  status:'available',resourceStage:'accepted',mode0:{viewId:'world-cloud:camera',deviceGeneration:3,
    materialIdentity:'sha256:fixture-program',historyValid:true,preparedPhase:2,acceptedFrame:41,acceptedPhase:1,resetReasons:[]}}}};
let rendererObservation: unknown = runtime;
let deferInspection = false;
let releaseInspection: (() => void) | undefined;
const listeners = new Set<(state: WorkspaceState) => void>();
const state = (): WorkspaceState => ({
  revision: 1, browserGeneration: 1, catalogEpoch: 1,
  project: { id: scope.projectId, name: 'Cloud fixture', root: '/fixture' },
  projectTarget: { targetId: 'project-target', generation: 1, sessionId: 'project-session' },
  scenePreview: { target }, previews: [{ target }], assets: [material],
  sceneSelection: { targetId: target.targetId, targetGeneration: target.generation, primary: { entityId: inspection.entityId } },
} as WorkspaceState);
const client = {
  transport: { connected: true, async request() { return {}; } },
  subscribe(listener: (state: WorkspaceState) => void) { listeners.add(listener); listener(state()); return () => { listeners.delete(listener); }; },
  async getState() { return state(); },
  async call(operation: string, args: Record<string, unknown>) {
    calls.push({ operation, args });
    if (operation === 'entity.inspect') {
      const result = {...inspection, targetId: target.targetId, worldId: target.worldId, rendererObservation};
      if (deferInspection) {
        deferInspection = false;
        await new Promise<void>(resolve => { releaseInspection = resolve; });
      }
      return result;
    }
    if (operation === 'assets.thumbnails') return { thumbnails: [{ guid: material.guid, state: 'unsupported' }] };
    return {};
  },
};
const references: AssetReferenceService = {
  getState: () => referenceState,
  subscribe: () => () => {},
  async query(entityId) { return { ...scope, entityId, references: [{ key: 'VolumetricCloudLayer.material', component: 'VolumetricCloudLayer',
    field: 'material', origin: 'component', status: 'resolved', guid: material.guid, kind: material.kind, handle: 1030 }] }; },
  async open(guid) { return client.call('asset.open', { projectId: scope.projectId, targetId: target.targetId, targetGeneration: target.generation, guid }); },
};
Object.assign(globalThis, { cloudInspectionFixture: { calls, clipboard, setLocale,
  setRuntimeState(stale: boolean) { rendererObservation = stale ? {...runtime,worldId:'old-world'} : runtime; },
  deferNextInspection() { deferInspection = true; },
  hasDeferredInspection() { return releaseInspection !== undefined; },
  replaceTarget() {
    target = {...target, generation: target.generation + 1};
    const facts = runtime.cloudLayer['world-cloud:camera'];
    rendererObservation = {...runtime, frame: {frameId:84, deviceGeneration:4}, cloudLayer: {
      'world-cloud:camera': {...facts, mode0: {...facts.mode0, deviceGeneration:4, acceptedFrame:83}},
    }};
    for (const listener of listeners) listener(state());
  },
  releaseDeferredInspection() { const release = releaseInspection; releaseInspection = undefined; release?.(); },
} });
await mountInspectorPanel({ client: client as unknown as ViewWorkspaceClient, assetReferences: references,
  mountElement: document.getElementById('app')!, writeClipboard: async text => { clipboard.push(text); },
  addConversationReference: async () => { calls.push({ operation: 'conversation.add', args: {} }); },
  browseAsset: async guid => {
    if (guid !== material.guid) throw new Error('The reveal action must use the resolved material GUID');
    calls.push({ operation: 'asset.browse', args: { guid } });
    return true;
  },
});
