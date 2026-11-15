import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createToolApi, defineTool, toolJsonSchema } from '@forgeax/engine/tool-runtime';
import { classifySceneEntity } from '../packages/view-workspace-core/src/scene-entity-classification.ts';
import { ViewWorkspaceBroker } from '../packages/view-workspace-core/src/broker.ts';
import { normalizeSceneTreeRows } from '../packages/view-plugin-scene-tree/src/hierarchy.ts';
import { inspectorEntityFromInspection, inspectorSections } from '../packages/view-plugin-inspector/src/inspection.ts';

// Independent public-schema witness; these values are not a rendered cloud oracle.
const values = {
  material: 1030, enabled: true, bottomMeters: 5000, thicknessMeters: 10000,
  extinctionOverridePerMeter: -1, entryLimitMeters: 350000, traceLimitMeters: 200000,
  viewSampleCountScale: 1, stopTransmittance: 0.005,
  layoutWeight: -1, maskWeight: -1, profileWeight: -1, bodyWeight: -1, erosionWeight: -1,
  coverageBias: -2, windOffsetMeters: [46000, 0, -35000], useDetail: 2, skipEmpty: true,
  diagnosticMode: 0, diagnosticPixelX: 0, diagnosticPixelY: 0,
};
const schema = Object.fromEntries(Object.keys(values).map(key => [key, {
  type: key === 'material' ? 'asset<cloud-material>' : ['enabled', 'skipEmpty'].includes(key) ? 'bool'
    : key === 'windOffsetMeters' ? 'array<f32, 3>' : key === 'useDetail' || key.startsWith('diagnostic') ? 'u32' : 'f32',
}]));
const cloud = (override = {}, extra = {}) => inspectorEntityFromInspection({
  entityId: 'world-b:7', targetId: 'preview', components: [{ name: 'VolumetricCloudLayer', fields: { ...schema, ...extra }, values: { ...values, ...override } }],
});

describe('volumetric cloud read-only inspection', () => {
  it('classifies the formal component as sky in Inspector and Scene Tree', () => {
    assert.equal(classifySceneEntity(['VolumetricCloudLayer']).kind, 'sky');
    assert.equal(classifySceneEntity(['CloudLayer']).kind, 'sky');
    const rows = normalizeSceneTreeRows({ nodes: [{ entityId: 'world-b:7', componentNames: ['VolumetricCloudLayer'] }] });
    assert.equal(rows[1].typeKey, 'sky');
  });

  it('projects the 21 returned fields exactly once into UE and extension groups', () => {
    const source = cloud();
    const all = inspectorSections(source, 'all');
    const sections = all.filter(section => !section.key.startsWith('VolumetricCloudLayer.runtime'));
    assert.equal(all.at(-1).fields[0].unavailable, true);
    assert.deepEqual(sections.map(section => section.key), [
      'VolumetricCloudLayer.layer', 'VolumetricCloudLayer.material', 'VolumetricCloudLayer.overrides',
      'VolumetricCloudLayer.motion', 'VolumetricCloudLayer.advanced',
    ]);
    const fields = sections.flatMap(section => section.fields);
    assert.equal(fields.length, 21);
    assert.deepEqual(new Set(fields.map(field => field.key)), new Set(Object.keys(values)));
    for (const field of fields) assert.deepEqual(field.rawValue, values[field.key]);
    assert.deepEqual(inspectorSections(source, 'common'), all);
    assert.equal(sections.at(-1).defaultCollapsed, true);
    for (const key of ['viewSampleCountScale', 'stopTransmittance']) {
      const field = sections.at(-1).fields.find(field => field.key === key);
      assert.equal(field.kind, 'number');
      assert.notEqual(field.inherited, true);
    }
  });

  it('separates returned optical and shadow settings without treating them as accepted runtime values', () => {
    const fields = {phaseG:0.6, multiScatteringOctaves:2, shadowMode:1, castCloudShadows:false,
      shadowExtentMeters:40000, materialInstance:1040, initializationRevision:7,
      atmosphereTransmittanceMode:0,enableDistantSkyLightSampling:false,atmosphereShadowStrength:0.25};
    const source = cloud(fields,Object.fromEntries(Object.keys(fields).map(key=>[key,{type:key==='materialInstance'?'asset<cloud-material-instance>':key==='enableDistantSkyLightSampling'?'bool':key==='atmosphereTransmittanceMode'?'u32':'f32'}])));
    const sections = inspectorSections(source,'all');
    assert.deepEqual(sections.find(section=>section.key.endsWith('.lighting')).fields.map(field=>field.key),['phaseG','multiScatteringOctaves','atmosphereTransmittanceMode','enableDistantSkyLightSampling']);
    assert.deepEqual(sections.find(section=>section.key.endsWith('.shadows')).fields.map(field=>field.key),['shadowMode','castCloudShadows','shadowExtentMeters','atmosphereShadowStrength']);
    for(const key of ['atmosphereTransmittanceMode','enableDistantSkyLightSampling','atmosphereShadowStrength'])
      assert.equal(sections.flatMap(section=>section.fields).find(field=>field.key===key).rawValue,fields[key]);
    assert.equal(sections.flatMap(section=>section.fields).find(field=>field.key==='enableDistantSkyLightSampling').kind,'bool');
    const missing=inspectorSections(cloud({atmosphereTransmittanceMode:undefined,enableDistantSkyLightSampling:undefined,atmosphereShadowStrength:undefined},
      {atmosphereTransmittanceMode:{type:'u32'},enableDistantSkyLightSampling:{type:'bool'},atmosphereShadowStrength:{type:'f32'}}),'all').flatMap(section=>section.fields);
    for(const key of ['atmosphereTransmittanceMode','enableDistantSkyLightSampling','atmosphereShadowStrength'])
      assert.equal(missing.find(field=>field.key===key).rawValue,undefined);
    assert.equal(sections.find(section=>section.key.endsWith('.runtime')).fields[0].unavailable,true);
    assert.equal(sections.flatMap(section=>section.fields).filter(field=>field.key==='initializationRevision').length,1);
  });

  it('projects only returned matching-target, World and device history, preserving cold and missing values', () => {
    const inspection={entityId:'preview:world-b:7',targetId:'preview',worldId:'world-b',components:[{name:'VolumetricCloudLayer',fields:schema,values}]};
    const observation={targetId:'preview',worldId:'world-b',frame:{frameId:24,deviceGeneration:3},cloudLayer:{'view-current':{
      status:'available',resourceStage:'candidate',mode0:{viewId:'view-current',deviceGeneration:3,
        historyValid:false,preparedPhase:0,materialIdentity:'actual-cooked-program',resetReasons:['history-missing']}}}};
    const runtime=extra=>inspectorSections(inspectorEntityFromInspection({...inspection,rendererObservation:{...observation,...extra}}),'all')
      .filter(section=>section.key.startsWith('VolumetricCloudLayer.runtime')).flatMap(section=>section.fields);
    const current=runtime({});
    assert.equal(current.find(field=>field.key==='runtimeHistoryValid').rawValue,false);
    assert.equal(current.find(field=>field.key==='runtimePreparedPhase').rawValue,0);
    assert.equal(current.find(field=>field.key==='runtimeAcceptedFrame').unavailable,true);
    for(const extra of [{targetId:'old-target'},{worldId:'old-world'},{frame:{frameId:25,deviceGeneration:4}},{cloudLayer:undefined}]) {
      const stale=runtime(extra);
      assert.equal(stale.length,1);
      assert.equal(stale[0].key,'runtimeObservation');
      assert.equal(stale[0].unavailable,true);
      assert.equal(stale[0].rawValue,undefined);
    }
  });

  it('marks only declared inheritance sentinels without resolving material defaults', () => {
    const fields = source => Object.fromEntries(source.components[0].fields.map(field => [field.key, field]));
    const inherited = fields(cloud());
    for (const key of ['extinctionOverridePerMeter', 'layoutWeight', 'maskWeight', 'profileWeight', 'bodyWeight', 'erosionWeight', 'coverageBias', 'useDetail']) {
      assert.equal(inherited[key].inherited, true, key);
      assert.equal(inherited[key].rawValue, values[key]);
    }
    const explicit = fields(cloud({ extinctionOverridePerMeter: 0, layoutWeight: 0, coverageBias: -1, useDetail: 0 }));
    for (const key of ['extinctionOverridePerMeter', 'layoutWeight', 'coverageBias', 'useDetail']) assert.notEqual(explicit[key].inherited, true, key);
    assert.notEqual(inherited.windOffsetMeters.inherited, true);
  });

  it('preserves future returned fields and missing values instead of supplying defaults', () => {
    const source = cloud({ ownerFutureField: 73, bottomMeters: undefined, viewSampleCountScale: undefined, stopTransmittance: undefined }, { ownerFutureField: { type: 'u32' } });
    const fields = inspectorSections(source, 'all').flatMap(section => section.fields);
    assert.equal(fields.find(field => field.key === 'ownerFutureField').rawValue, 73);
    assert.equal(fields.find(field => field.key === 'bottomMeters').rawValue, undefined);
    assert.notEqual(fields.find(field => field.key === 'bottomMeters').value, 5000);
    for (const key of ['viewSampleCountScale', 'stopTransmittance']) {
      assert.equal(fields.find(field => field.key === key).rawValue, undefined);
      assert.notEqual(fields.find(field => field.key === key).value, values[key]);
    }
  });

  it('uses the native resolved GUID for material navigation and keeps missing identities unresolved', () => {
    const asset = { guid: 'material-guid', kind: 'cloud-material', sourceKey: 'material/reference-layout' };
    const inspection = { entityId: 'world-b:7', targetId: 'preview', components: [{ name: 'VolumetricCloudLayer', fields: schema, values }] };
    const bindings = { entityId: 'world-b:7', projectId: 'project', targetId: 'preview', targetGeneration: 2,
      worldId: 'world-b', browserGeneration: 1, references: [{ key: 'VolumetricCloudLayer.material', component: 'VolumetricCloudLayer',
        field: 'material', origin: 'component', status: 'resolved', guid: asset.guid, kind: asset.kind, handle: 1030 }] };
    const source = inspectorEntityFromInspection(inspection, [asset], {}, bindings);
    assert.equal(source.components[0].fields[0].resource.guid, asset.guid);
    assert.equal(source.components[0].fields[0].resource.asset, asset);
    const missing = inspectorEntityFromInspection(inspection, [], {}, bindings);
    assert.equal(missing.components[0].fields[0].resource.status, 'missing');
    const stale = inspectorEntityFromInspection(inspection, [asset], {}, { ...bindings, references: [{ ...bindings.references[0], status: 'stale', guid: undefined }] });
    assert.equal(stale.components[0].fields[0].resource.guid, undefined);
    assert.equal(stale.components[0].fields[0].resource.asset, undefined);
  });

  for (const kind of ['cloud-material', 'cloud-material-instance']) it(`opens ${kind} as native identity facts without creating a preview`, async () => {
    const asset = { guid: `guid-${kind}`, kind, sourceKey: 'material/custom', path: 'assets/clouds/clouds.pack.ts', previewable: false };
    const api = createToolApi(), calls = [];
    const json = toolJsonSchema({ type: 'object' });
    api.registerProvider({ providerId: 'engine', sourceId: 'engine-workspace', realm: 'host', tools: [defineTool({
      id: 'engine.asset.inspect', path: ['engine', 'asset', 'inspect'], title: 'Inspect', summary: 'Inspect identity', realm: 'host',
      argsSchema: json, resultSchema: json, inputSchema: {}, outputSchema: {}, evidence: [],
    }, args => { calls.push(args); return { inspection: { guid: asset.guid, asset } }; })] });
    try {
      const broker = new ViewWorkspaceBroker({ toolApi: api, engine: { project: { project: { id: 'project', root: '/project' } }, previews: [] } });
      broker.assets = [asset];
      const result = await broker.invoke('asset.open', { projectId: 'project', targetId: 'project-target', targetGeneration: 3, guid: asset.guid });
      assert.deepEqual(calls, [{ projectId: 'project', targetId: 'project-target', targetGeneration: 3, guid: asset.guid, clientId: 'view-owner' }]);
      assert.equal(result.openRequest.detailsOnly, true);
      assert.equal(result.openRequest.asset.guid, asset.guid);
      assert.equal(result.openRequest.preview, undefined);
      assert.deepEqual(result.previews, []);
    } finally { await api.dispose(); }
  });
});
