import { requireFact } from './lib.mjs';

export const GPU_INTERPRETATION = [
  'Resources cover the captured tape closure, not the whole device heap.',
  'Bytes are descriptor payload estimates, not driver allocation or physical residency. Views never duplicate storage bytes.',
  'Count is unique observed API objects. Only buffer/texture destruction is observed; other objects are not a live-object census.',
  'Label folders aid navigation; they do not establish ownership. Shared resource IDs are counted once.',
  'Edges describe captured draw/dispatch bindings and attachments, not barriers, hardware scheduling or a critical path. Transfer-only events are not projected; unknown access remains unknown.',
  'API destruction and first/last use do not establish GPU retirement. Bootstrap creation time is unknown.',
];
export const gpuLabel = (r) => r?.descriptor?.desc?.label || r?.resourceId || 'Unnamed';
const storage = (r) => ['buffer', 'texture'].includes(r.kind);
const byteValue = (r) =>
  r.lifecycle?.byteEstimate?.status === 'known' ? r.lifecycle.byteEstimate.bytes : null;

function resourceRows(model) {
  const ids = new Set();
  const source = new Map(model.resources.map((r) => [r.resourceId, r]));
  return model.resources.map((r) => {
    requireFact(
      typeof r.resourceId === 'string' && !ids.has(r.resourceId),
      'Duplicate or invalid GPU resource ID',
    );
    ids.add(r.resourceId);
    const bytes = byteValue(r);
    requireFact(
      bytes === null || (Number.isSafeInteger(bytes) && bytes >= 0),
      'Invalid GPU descriptor bytes',
    );
    return {
      ...r,
      label:
        r.descriptor?.desc?.label ||
        (r.kind === 'texture-view' && source.has(r.descriptor?.sourceHandleId)
          ? gpuLabel(source.get(r.descriptor.sourceHandleId)) + ' · view'
          : gpuLabel(r)),
      storage: storage(r),
      bytes,
      state: storage(r) ? (r.lifecycle?.state ?? 'unavailable') : 'observed',
      byteStatus: storage(r)
        ? (r.lifecycle?.byteEstimate ?? { status: 'unavailable', reason: 'lifecycle-unavailable' })
        : { status: 'not-storage' },
      parentResourceId: r.kind === 'texture-view' ? (r.descriptor?.sourceHandleId ?? null) : null,
    };
  });
}

function passLabel(model, pass) {
  const command = model.commands.find((c) => c.eventIndex === pass.beginEventIndex);
  return (
    command?.params?.desc?.label ||
    command?.params?.label ||
    command?.group?.at(-1) ||
    `${pass.kind} pass ${pass.passIndex}`
  );
}

/** Project canonical IDs and observed uses; never reconstruct pipeline or allocation state. */
export function buildGpuReport(model, identity) {
  for (const key of ['resources', 'works', 'passes', 'commands'])
    requireFact(Array.isArray(model?.[key]), 'Require canonical FrameModel arrays');
  requireFact(
    /^sha256:[a-f0-9]{64}$/.test(identity?.tapeDigest),
    'Require canonical tape SHA-256 identity',
  );
  const resources = resourceRows(model);
  const works = model.works.map((w) => ({
    ...w,
    label: w.pipeline?.descriptor?.desc?.label || w.pipeline?.shaders?.[0]?.entryPoint || w.kind,
  }));
  const passes = model.passes.map((p) => ({ ...p, label: passLabel(model, p) }));
  const report = {
    kind: 'gpu-report',
    schemaVersion: 1,
    identity,
    resources,
    works,
    passes,
    resourceLifecycle: model.resourceLifecycle ?? null,
    eventCount: model.commands.length,
    unseededResources: model.unseededResources ?? [],
    interpretation: GPU_INTERPRETATION,
  };
  report.uses = gpuUses(report);
  report.summary = {
    observedObjects: resources.length,
    storageObjects: resources.filter(storage).length,
    observedStorageLive: resources.filter((r) => r.storage && r.state === 'live').length,
    knownDescriptorBytes: resources.filter(storage).reduce((n, r) => n + (r.bytes ?? 0), 0),
    unknownStorageBytes: resources.filter((r) => r.storage && r.bytes === null).length,
    passes: passes.length,
    works: works.length,
    lifecycleUntrackedObjects: resources.filter((r) => r.lifecycle?.state === 'unavailable').length,
    scope: 'captured-tape-resource-closure',
    driverAllocationBytes: null,
    physicalResidencyBytes: null,
  };
  report.summary.byKind = gpuKindSummary(resources);
  return validateGpuReport(report);
}

export function gpuKindSummary(resources) {
  const groups = new Map();
  for (const r of resources) {
    const g = groups.get(r.kind) ?? {
      kind: r.kind,
      observedCount: 0,
      storageCount: 0,
      knownDescriptorBytes: 0,
      unknownStorageBytes: 0,
    };
    g.observedCount++;
    if (r.storage) {
      g.storageCount++;
      g.knownDescriptorBytes += r.bytes ?? 0;
      if (r.bytes === null) g.unknownStorageBytes++;
    }
    groups.set(r.kind, g);
  }
  return [...groups.values()].sort(
    (a, b) => b.knownDescriptorBytes - a.knownDescriptorBytes || b.observedCount - a.observedCount,
  );
}

export function validateGpuReport(value) {
  requireFact(value?.kind === 'gpu-report' && value.schemaVersion === 1, 'Unsupported GPU report');
  requireFact(/^sha256:[a-f0-9]{64}$/.test(value.identity?.tapeDigest), 'Missing tape identity');
  for (const key of ['resources', 'works', 'passes', 'uses', 'interpretation'])
    requireFact(Array.isArray(value[key]), 'Invalid GPU report arrays');
  const integer = (v) => Number.isSafeInteger(v) && v >= 0;
  requireFact(
    integer(value.eventCount) && value.summary?.observedObjects === value.resources.length,
    'Invalid GPU report summary',
  );
  const unique = (rows, key) => {
    const ids = rows.map((r) => r[key]);
    requireFact(new Set(ids).size === ids.length, 'Duplicate GPU coordinates');
  };
  unique(value.resources, 'resourceId');
  unique(value.works, 'workIndex');
  unique(value.passes, 'passIndex');
  for (const r of value.resources) {
    requireFact(
      typeof r.resourceId === 'string' && typeof r.label === 'string' && typeof r.kind === 'string',
      'Invalid GPU resource',
    );
    requireFact(
      typeof r.storage === 'boolean' && (r.bytes === null || integer(r.bytes)),
      'Invalid GPU resource size',
    );
    requireFact(
      ['live', 'destroyed', 'unavailable', 'observed'].includes(r.state),
      'Invalid GPU resource state',
    );
  }
  for (const w of value.works)
    requireFact(
      integer(w.workIndex) && typeof w.label === 'string' && Array.isArray(w.bindings),
      'Invalid GPU work',
    );
  for (const p of value.passes)
    requireFact(
      integer(p.passIndex) && typeof p.label === 'string' && Array.isArray(p.workIndices),
      'Invalid GPU pass',
    );
  for (const u of value.uses)
    requireFact(
      typeof u.resourceId === 'string' &&
        ['read', 'write', 'read-write', 'unknown'].includes(u.access),
      'Invalid GPU resource use',
    );
  return value;
}

function attachments(row) {
  const a = row.attachments;
  if (a)
    return [
      ...a.colorViewHandleIds,
      ...(a.colorResolveViewHandleIds ?? []),
      a.depthStencilViewHandleId,
    ].filter(Boolean);
  return [
    ...(row.colorAttachmentViewHandleIds ?? []),
    ...(row.colorAttachmentResolveViewHandleIds ?? []),
    row.depthStencilViewHandleId,
  ].filter(Boolean);
}

/** Read/write joins include indirect bindings; ResourceEntry.consumers is not a complete work-use index. */
export function gpuUses(report) {
  const resources = new Map(report.resources.map((r) => [r.resourceId, r]));
  const result = new Map();
  const add = (resourceId, passIndex, workIndex, access, role) => {
    if (!resourceId) return;
    const parent = resources.get(resourceId)?.parentResourceId;
    const row = {
      resourceId: parent ?? resourceId,
      viewResourceId: parent ? resourceId : null,
      passIndex,
      workIndex,
      access,
      role,
    };
    result.set(JSON.stringify(row), row);
  };
  for (const p of report.passes)
    for (const id of attachments(p)) add(id, p.passIndex, null, 'unknown', 'attachment');
  for (const w of report.works) {
    for (const b of w.bindings ?? [])
      add(
        b.resourceId,
        w.passIndex,
        w.workIndex,
        b.access ?? 'unknown',
        `binding ${b.groupIndex}:${b.binding}`,
      );
    for (const b of w.vertexBuffers ?? [])
      add(b.bufferHandleId, w.passIndex, w.workIndex, 'read', `vertex ${b.slot}`);
    add(w.indexBuffer?.bufferHandleId, w.passIndex, w.workIndex, 'read', 'index');
    for (const id of attachments(w)) add(id, w.passIndex, w.workIndex, 'unknown', 'attachment');
  }
  return [...result.values()];
}

/** Additive hierarchy: one leaf per resource, aliases/uses stay outside the byte/count tree. */
export function gpuResourceTree(
  report,
  { metric = 'bytes', group = 'kind', state = 'all', search = '' } = {},
) {
  requireFact(
    ['bytes', 'count'].includes(metric) && ['kind', 'labels'].includes(group),
    'Invalid GPU tree controls',
  );
  const root = {
    id: 'root',
    name: metric === 'bytes' ? 'Known descriptor bytes' : 'Observed API objects',
    value: 0,
    children: [],
  };
  const groups = new Map([['root', root]]);
  for (const r of report.resources) {
    if (state !== 'all' && r.state !== state) continue;
    if (
      search &&
      !(r.label + ' ' + r.resourceId + ' ' + r.kind).toLowerCase().includes(search.toLowerCase())
    )
      continue;
    const value = metric === 'bytes' ? (r.storage ? (r.bytes ?? 0) : 0) : 1;
    if (!value) continue;
    let parent = root;
    const path =
      group === 'kind'
        ? [r.kind]
        : [r.kind, ...r.label.split('/').slice(0, -1).filter(Boolean).slice(0, 8)];
    for (const part of path) {
      const id = parent.id + '/' + JSON.stringify(part);
      if (!groups.has(id)) {
        const node = { id, name: part, value: 0, children: [] };
        groups.set(id, node);
        parent.children.push(node);
      }
      parent.value += value;
      parent = groups.get(id);
    }
    parent.value += value;
    parent.children.push({
      id: 'resource/' + r.resourceId,
      resourceId: r.resourceId,
      name: r.label,
      value,
    });
  }
  return root;
}

export function gpuGraph(report, { passIndex = null, workIndex = null, maxNodes = 300 } = {}) {
  requireFact(
    Number.isInteger(maxNodes) && maxNodes >= 4 && maxNodes <= 2000,
    'Invalid GPU graph node budget',
  );
  const nodes = new Map(),
    edges = new Map();
  const resourceMap = new Map(report.resources.map((r) => [r.resourceId, r]));
  const node = (id, label, kind, extra = {}) => {
    if (!nodes.has(id)) nodes.set(id, { data: { id, label, kind, ...extra } });
    return id;
  };
  const edge = (a, b, label, unknown = false) => {
    const id = JSON.stringify([a, b, label]);
    edges.set(id, { data: { id, source: a, target: b, label, unknown } });
  };
  const resource = (id) =>
    node('resource/' + id, resourceMap.get(id)?.label ?? id, 'resource', { resourceId: id });
  const work = workIndex === null ? null : report.works.find((w) => w.workIndex === workIndex);
  requireFact(workIndex === null || work, 'Unknown GPU workIndex');
  if (work) {
    const target = node('work/' + work.workIndex, work.label, 'work', {
      workIndex: work.workIndex,
    });
    for (const s of work.pipeline?.shaders ?? [])
      edge(
        node(
          'shader/' + s.moduleHandleId,
          s.stage + ': ' + (s.entryPoint ?? s.moduleHandleId),
          'shader',
          { workIndex: work.workIndex, moduleHandleId: s.moduleHandleId },
        ),
        target,
        s.stage,
      );
    for (const use of report.uses.filter((u) => u.workIndex === workIndex))
      graphUse(use, target, resource, edge);
  } else {
    for (const p of report.passes) {
      if (passIndex !== null && p.passIndex !== passIndex) continue;
      const target = node('pass/' + p.passIndex, p.label, 'pass', { passIndex: p.passIndex });
      for (const use of report.uses.filter((u) => u.passIndex === p.passIndex))
        graphUse(use, target, resource, edge);
    }
  }
  const all = [...nodes.values()],
    kept = all.slice(0, maxNodes),
    ids = new Set(kept.map((n) => n.data.id));
  return {
    nodes: kept,
    edges: [...edges.values()].filter((e) => ids.has(e.data.source) && ids.has(e.data.target)),
    omittedNodes: all.length - kept.length,
  };
}
export function graphUse(use, target, resource, edge) {
  const r = resource(use.resourceId),
    unknown = use.access === 'unknown';
  if (['read', 'read-write', 'unknown'].includes(use.access))
    edge(r, target, use.role + (unknown ? ' · access unknown' : ''), unknown);
  if (['write', 'read-write'].includes(use.access)) edge(target, r, use.role, false);
}
