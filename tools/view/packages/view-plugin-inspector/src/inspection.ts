import type { InspectorFormField } from '@forgeax/view-components';
import type { WorkspaceAsset, WorkspaceEntityInspection, WorkspaceState } from '@forgeax/view-workspace-core/contract';
import type { AssetReference, EntityAssetReferences } from '@forgeax/view-workspace-core/asset-references';
import { classifySceneEntity, SCENE_ENTITY_COMPONENTS, type SceneEntityKind } from '@forgeax/view-workspace-core/scene-entity-classification';
import {
  formatInspectorFieldLabel,
  normalizeInspectorFieldValue,
  resolveInspectorFieldKind,
} from '@forgeax/view-components/inspector-form-model';

export type EntityInspection = WorkspaceEntityInspection;
export type InspectorField = InspectorFormField & {
  rawValue: unknown;
  presentation?: 'collection' | 'resource' | 'color' | 'handle';
  resource?: InspectorResourceReference;
  resources?: readonly InspectorResourceReference[];
  colorChannels?: readonly number[];
};
export type InspectorComponent = { name: string; icon: string; category: 'all' | 'type' | 'capability'; fields: InspectorField[] };
export type InspectorResourceReference = {
  kind: string;
  rawValue: unknown;
  handle?: number;
  guid?: string;
  asset?: WorkspaceAsset;
  inherited?: boolean;
  slotName?: string;
  bindingSource?: AssetReference['origin'];
  status?: AssetReference['status'];
};
export type InspectorEntity = {
  id: string;
  name: string;
  badge: string;
  kind: SceneEntityKind;
  primaryComponents: readonly string[];
  components: InspectorComponent[];
  raw: EntityInspection;
  meshReference: InspectorResourceReference;
  materialOverrides: InspectorResourceReference[] | null;
  materialOverridesTruncated: boolean;
  assetReferencesTruncated?: boolean;
};
export type InspectorGroup = 'common' | 'object' | 'rendering' | 'physics' | 'animation' | 'media' | 'effects' | 'behavior' | 'all';
export type InspectorSection = {
  key: string;
  component: string;
  titleKey?: string;
  kind: 'fields' | 'mesh' | 'materials';
  fields: InspectorField[];
};
export type InspectorComponentNode = {
  key: string;
  components: readonly string[];
  kind: SceneEntityKind;
  titleKey?: string;
};

const OBJECT_COMPONENTS = new Set(['Entity', 'Name', 'ChildOf', 'Children', 'SceneInstance', 'Mobility', 'Disabled']);
const RENDER_COMPONENTS = new Set(['MeshRenderer', 'Visibility', 'ShadowParticipation', 'Layer', 'SortKey', 'Instances', 'ClippingPlanes', 'CapsuleShadow']);
const PHYSICS_COMPONENTS = new Set(['RigidBody', 'Collider', 'CharacterController', 'CollidingEntities']);
const ANIMATION_COMPONENTS = new Set(['Skin', ...SCENE_ENTITY_COMPONENTS.animation, 'SpriteAnimation']);
const MEDIA_COMPONENTS = new Set<string>([...SCENE_ENTITY_COMPONENTS.audio, ...SCENE_ENTITY_COMPONENTS.video]);
const EFFECT_COMPONENTS = new Set<string>(SCENE_ENTITY_COMPONENTS.vfx);
const BEHAVIOR_COMPONENTS = new Set<string>([...SCENE_ENTITY_COMPONENTS.navigation, ...SCENE_ENTITY_COMPONENTS.npc]);
for (const kind of ['camera', 'directionalLight', 'pointLight', 'spotLight', 'areaLight', 'skylight', 'sky', 'fog', 'reflection', 'postProcess', 'sprite', 'tilemap', 'text', 'geometry', 'decal', 'terrain'] as const) {
  for (const name of SCENE_ENTITY_COMPONENTS[kind]) RENDER_COMPONENTS.add(name);
}
for (const name of ['MeshFilter', 'CameraView', 'RuntimeMaterialValue', 'RuntimeMeshVertices']) RENDER_COMPONENTS.add(name);
RENDER_COMPONENTS.delete('SpriteAnimation');

const FUNCTIONAL_GROUPS = {
  object: OBJECT_COMPONENTS, rendering: RENDER_COMPONENTS, physics: PHYSICS_COMPONENTS,
  animation: ANIMATION_COMPONENTS, media: MEDIA_COMPONENTS, effects: EFFECT_COMPONENTS, behavior: BEHAVIOR_COMPONENTS,
};
const COMMON_FIELDS: Record<string, readonly string[]> = {
  Camera: ['projection', 'fov', 'aspect', 'near', 'far', 'left', 'right', 'bottom', 'top', 'autoAspect'],
  DirectionalLight: ['direction', 'color', 'intensity', 'castShadow'],
  PointLight: ['color', 'intensity', 'range', 'iesProfile'],
  SpotLight: ['direction', 'color', 'intensity', 'range', 'innerConeDeg', 'outerConeDeg', 'castShadow'],
  RectAreaLight: ['color', 'intensity', 'width', 'height', 'range'],
  Skylight: ['equirect', 'color', 'intensity', 'rotation'],
  RigidBody: ['type', 'mass', 'gravityScale'],
  Collider: ['shape', 'mesh', 'halfExtents', 'radius', 'halfHeight', 'isSensor'],
  CharacterController: ['offset', 'maxSlopeClimbDeg', 'minSlopeSlideDeg', 'grounded'],
  AudioSource: ['clip', 'playing', 'paused', 'loop', 'volume', 'playbackRate'],
  AnimationPlayer: ['clips', 'paused', 'looping'],
};
const ASSET_KINDS: Record<string, string> = {
  MeshAsset: 'mesh', MaterialAsset: 'material', SceneAsset: 'scene', SkeletonAsset: 'skeleton',
  TextureAsset: 'texture', EquirectAsset: 'equirect', AudioClipAsset: 'audio', VideoAsset: 'video',
  ParticleEffectAsset: 'particle-effect', TerrainAsset: 'terrain', IesProfileAsset: 'ies-profile',
  AnimationClip: 'animation', AnimationGraph: 'animation-graph', AnimationMask: 'animation-mask', RenderTarget: 'render-target',
};
const CAMERA_RENDER_SECTIONS: Record<string, readonly string[]> = {
  exposure: ['tonemap', 'exposure', 'exposureMode', 'compensationEv', 'rangeEv', 'rates', 'whitePoint', 'temperature', 'tint', 'colorLut', 'colorLutStrength'],
  antialiasing: ['antialias', 'transparency', 'historyVersion'],
  bloom: ['bloom', 'bloomThreshold', 'bloomIntensity', 'bloomSoftKnee', 'bloomScatter'],
  cameraOutput: ['target', 'targetLayer', 'clearColor', 'autoAspect'],
};
const ENTITY_DATA_COMPONENTS = new Set([
  'Entity', 'Name', 'ChildOf', 'Children', 'GlobalTransform', 'Transform', 'TransformInterpolation', 'Mobility', 'Disabled',
  'Visibility', 'ShadowParticipation', 'Layer', 'SortKey', 'ClippingPlanes', 'CapsuleShadow',
  'CameraView', 'RuntimeMaterialValue', 'RuntimeMeshVertices',
]);
const MESH_COMPONENTS = ['MeshFilter', 'MeshRenderer', 'Skin', 'Instances'] as const;

export { formatInspectorFieldLabel };

function quaternionDegrees(value: unknown): { x: number; y: number; z: number } | null {
  const components = Array.isArray(value) ? value : value && typeof value === 'object'
    ? ['x', 'y', 'z', 'w'].map(axis => (value as Record<string, unknown>)[axis]) : null;
  if (!components || components.length !== 4 || !components.every(part => typeof part === 'number' && Number.isFinite(part))) return null;
  const numbers = components as number[];
  const lengthSquared = numbers.reduce((sum, part) => sum + part * part, 0);
  if (!Number.isFinite(lengthSquared) || lengthSquared < 1e-12) return null;
  const inverseLength = 1 / Math.sqrt(lengthSquared);
  const [x, y, z, w] = numbers.map(part => part * inverseLength);

  // Intrinsic XYZ extraction, with the same equivalent branch at gimbal lock.
  const sinY = 2 * (x * z + w * y);
  const angleY = Math.asin(Math.max(-1, Math.min(1, sinY)));
  const locked = Math.abs(sinY) >= 1 - 1e-7;
  const angleX = locked
    ? Math.atan2(2 * (y * z + w * x), 1 - 2 * (x * x + z * z))
    : Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y));
  const angleZ = locked ? 0 : Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z));
  if (![angleX, angleY, angleZ].every(Number.isFinite)) return null;
  const toDegrees = 180 / Math.PI;
  return { x: angleX * toDegrees, y: angleY * toDegrees, z: angleZ * toDegrees };
}

export function inspectorComponentDisplayName(name: string, translate: (key: string) => string) {
  const key = `inspector.component.${name}`;
  const translated = translate(key);
  return translated === key ? name : translated;
}

export function inspectorCollection(value: unknown) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const truncated = record?.truncated === true;
  const data = truncated ? record.items ?? record.fields ?? value : value;
  const entries = Array.isArray(data) ? data.map((entry, index) => [String(index), entry] as const)
    : data && typeof data === 'object' ? Object.entries(data) : [];
  return { entries, length: truncated && typeof record?.length === 'number' ? record.length : entries.length,
    truncated, unavailable: typeof record?.unavailable === 'string' ? record.unavailable : undefined };
}

export function inspectorResourceReference(rawValue: unknown, kind: string, assets: readonly WorkspaceAsset[] = []): InspectorResourceReference {
  const record = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
    ? rawValue as Record<string, unknown> : null;
  const guid = typeof rawValue === 'string' ? rawValue : typeof record?.guid === 'string' ? record.guid : undefined;
  const asset = guid === undefined ? undefined : assets.find(candidate => candidate.guid === guid && (kind === 'asset' || candidate.kind === kind));
  return { kind, rawValue, ...(typeof rawValue === 'number' ? { handle: rawValue } : {}),
    ...(guid === undefined ? {} : { guid }), ...(asset === undefined ? {} : { asset }) };
}

function componentValues(inspection: EntityInspection, name: string) {
  const values = inspection.components.find(component => component.name === name)?.values;
  return values && typeof values === 'object' && !Array.isArray(values) ? values as Record<string, unknown> : {};
}

export function inspectorEntityFromInspection(
  inspection: EntityInspection | null | undefined,
  assets: readonly WorkspaceAsset[] = [],
  labels: { rotation?: string; unavailable?: string } = {},
  bindings?: EntityAssetReferences,
): InspectorEntity | null {
  if (!inspection?.entityId || !Array.isArray(inspection.components)) return null;
  const classification = classifySceneEntity(inspection.components.map(component => component.name));
  const materials = componentValues(inspection, 'MeshRenderer').materials;
  const materialCollection = inspectorCollection(materials);
  const overrides = Array.isArray(materials) ? materials : materialCollection.truncated ? materialCollection.entries.map(([, value]) => value) : null;
  const references = bindings?.entityId === inspection.entityId && bindings.targetId === inspection.targetId ? bindings.references : [];
  const resource = (key: string, value: unknown, kind: string): InspectorResourceReference => {
    const reference = references.find(reference => reference.key === key);
    const projected = { ...inspectorResourceReference(value, kind, assets),
      ...(reference ? { slotName: reference.slotName, bindingSource: reference.origin, status: reference.status } : {}) };
    if (reference?.status !== 'resolved' || !reference.guid) return projected;
    const asset = assets.find(asset => asset.guid.toLowerCase() === reference.guid!.toLowerCase() && (!reference.kind || asset.kind === reference.kind));
    return { ...projected, guid: reference.guid, kind: asset?.kind ?? reference.kind ?? kind, asset,
      inherited: reference.origin !== 'component', slotName: reference.slotName, status: asset ? reference.status : 'missing' };
  };
  const materialReferences = references.filter(reference => reference.component === 'MeshRenderer' && reference.field === 'materials' && reference.index !== undefined);
  const slotCount = Math.max(overrides?.length ?? 0, ...materialReferences.map(reference => reference.index! + 1), 0);
  return {
    id: inspection.entityId,
    name: inspection.name?.trim() ? inspection.name : (inspection.entity === undefined ? inspection.entityId : `Entity ${inspection.entity}`),
    badge: classification.kind,
    kind: classification.kind,
    primaryComponents: classification.primaryComponents,
    raw: inspection,
    meshReference: resource('MeshFilter.assetHandle', componentValues(inspection, 'MeshFilter').assetHandle, 'mesh'),
    materialOverrides: overrides !== null || materialReferences.length ? Array.from({ length: slotCount }, (_, index) => {
      const value = overrides?.[index] ?? 0;
      const reference = resource(`MeshRenderer.materials[${index}]`, value, 'material');
      return { ...reference, inherited: reference.inherited ?? value === 0 };
    }) : null,
    materialOverridesTruncated: materialCollection.truncated,
    assetReferencesTruncated: bindings?.truncated,
    components: inspection.components.map((component) => {
      const values = component.values && typeof component.values === 'object' && !Array.isArray(component.values)
        ? component.values as Record<string, unknown> : {};
      return {
        name: component.name,
        icon: 'box',
        category: 'all',
        fields: [...new Set([...Object.keys(component.fields ?? {}), ...Object.keys(values)])].map(key => {
          const schema = component.fields?.[key] ?? {};
          const rawValue = values[key];
          if (component.name === 'Transform' && key === 'quat') {
            const angles = quaternionDegrees(rawValue);
            return {
              key, label: labels.rotation ?? 'Rotation', rawValue,
              kind: angles ? 'angle3' as const : 'text' as const,
              value: angles ?? (labels.unavailable ?? 'Unavailable'),
            };
          }
          const type = schema.type ?? '';
          const shared = /^shared<([^>]+)>$/.exec(type);
          const sharedArray = /^array<shared<([^>]+)>>$/.exec(type);
          const handle = /^unique<[^>]+>$/.test(type) && typeof rawValue === 'number';
          const vector = /^(?:array<(?:f32|f64),\s*([34])>|vec([34])|(quat))$/.exec(type);
          const vectorSize = vector ? Number(vector[1] ?? vector[2] ?? 4) : 0;
          const numeric = Array.isArray(rawValue) && rawValue.every(value => typeof value === 'number' && Number.isFinite(value));
          const vectorObject = vector && rawValue !== null && typeof rawValue === 'object' && !Array.isArray(rawValue)
            && ['x', 'y', 'z', ...(vectorSize === 4 ? ['w'] : [])].every(axis => {
              const value = (rawValue as Record<string, unknown>)[axis];
              return typeof value === 'number' && Number.isFinite(value);
            });
          const vectorValue = vector && ((numeric && rawValue.length === vectorSize) || vectorObject);
          const color = (type === 'color' && numeric && [3, 4].includes(rawValue.length))
            || (['color', 'clearColor', 'groundAlbedo', 'tintColor'].includes(key) && Boolean(vector) && numeric && rawValue.length === vectorSize);
          // Declared arrays remain collections; their current length is not a vector schema.
          const collection = !shared && !color && !vectorValue
            && (type.startsWith('array<') || (rawValue !== null && typeof rawValue === 'object'));
          const asset = type.toLowerCase().includes('assetref');
          const kind = schema.type === 'enum' || schema.labels ? 'enum'
            : shared ? 'asset'
              : color ? 'color'
                : handle ? 'text'
              : asset ? 'asset'
                : collection ? 'text'
              : vectorValue ? vectorSize === 4 ? 'vector4' : 'vector3'
                : rawValue === undefined || rawValue === null ? 'text' : resolveInspectorFieldKind(schema, rawValue);
          const label = kind === 'enum' && schema.labels ? Object.entries(schema.labels).find(([, value]) => value === rawValue)?.[0] : undefined;
          const enumOptions = 'enum' in schema ? schema.enum : undefined;
          const options = Array.isArray(enumOptions) && enumOptions.every((option: unknown) => typeof option === 'string')
            ? enumOptions as string[] : undefined;
          return {
            key, label: formatInspectorFieldLabel(key), kind, rawValue,
            value: label ?? normalizeInspectorFieldValue(rawValue, kind),
            ...(schema.labels ? { options: label ? Object.keys(schema.labels) : [...Object.keys(schema.labels), String(rawValue)] }
              : options ? { options } : {}),
            ...(shared || asset ? { presentation: 'resource' as const, resource: resource(`${component.name}.${key}`, rawValue, shared ? ASSET_KINDS[shared[1]!] ?? 'asset'
              : rawValue && typeof rawValue === 'object' && 'kind' in rawValue && typeof rawValue.kind === 'string' ? rawValue.kind : 'asset') }
              : sharedArray ? { presentation: 'collection' as const,
                resources: inspectorCollection(rawValue).entries.map(([index, value]) => resource(`${component.name}.${key}[${index}]`, value, ASSET_KINDS[sharedArray[1]!] ?? 'asset')) }
              : color ? { presentation: 'color' as const, colorChannels: rawValue as number[] }
                : collection ? { presentation: 'collection' as const }
                  : handle ? { presentation: 'handle' as const } : {}),
          };
        }),
      };
    }),
  };
}

/** A UI projection of available ECS component data; it does not imply attachment relationships. */
export function inspectorComponentTree(source: InspectorEntity): InspectorComponentNode[] {
  const names = new Set(source.components.map(component => component.name));
  const consumed = new Set<string>();
  const nodes: InspectorComponentNode[] = [];
  const hasMeshComponent = names.has('MeshFilter') || names.has('MeshRenderer');
  const meshComponents = hasMeshComponent ? MESH_COMPONENTS.filter(name => names.has(name)) : [];
  if (meshComponents.length > 0) {
    meshComponents.forEach(name => consumed.add(name));
    const hasSkin = names.has('Skin');
    const hasInstances = names.has('Instances');
    nodes.push({
      key: 'mesh', components: meshComponents,
      kind: hasSkin ? 'skinnedMesh' : hasInstances ? 'instancedMesh' : 'mesh',
      titleKey: hasSkin ? 'inspector.skeletalMesh' : hasInstances ? 'inspector.instancedMesh' : 'inspector.staticMesh',
    });
  } else if (names.has('Skin')) {
    consumed.add('Skin');
    nodes.push({ key: 'Skin', components: ['Skin'], kind: 'skinnedMesh' });
  }
  if (names.has('PointLight') && names.has('PointLightShadow')) {
    consumed.add('PointLight');
    consumed.add('PointLightShadow');
    nodes.push({ key: 'PointLight', components: ['PointLight', 'PointLightShadow'], kind: 'pointLight' });
  }
  for (const component of source.components) {
    if (consumed.has(component.name) || ENTITY_DATA_COMPONENTS.has(component.name)) continue;
    nodes.push({
      key: component.name,
      components: [component.name],
      kind: classifySceneEntity([component.name]).kind,
    });
  }
  const primary = new Set(source.primaryComponents);
  const order = new Map(source.components.map((component, index) => [component.name, index]));
  nodes.sort((left, right) => {
    const leftPrimary = left.components.some(component => primary.has(component));
    const rightPrimary = right.components.some(component => primary.has(component));
    if (leftPrimary !== rightPrimary) return leftPrimary ? -1 : 1;
    const first = (node: InspectorComponentNode) => Math.min(...node.components.map(component => order.get(component) ?? Number.MAX_SAFE_INTEGER));
    return first(left) - first(right);
  });
  return nodes;
}

export function inspectorSectionsForComponents(source: InspectorEntity, group: InspectorGroup, components?: readonly string[]) {
  const sections = inspectorSections(source, group);
  if (!components) return sections;
  const names = new Set(components);
  return sections.filter(section => names.has(section.component));
}

export function inspectorGroupsForComponents(source: InspectorEntity, components?: readonly string[]) {
  return inspectorGroups(source).filter(group => inspectorSectionsForComponents(source, group, components).length > 0);
}

export function inspectorSections(source: InspectorEntity, group: InspectorGroup): InspectorSection[] {
  if (group === 'common') {
    const sections: InspectorSection[] = [];
    const transform = source.components.find(component => component.name === 'Transform');
    if (transform) sections.push({ key: 'Transform', component: 'Transform', titleKey: 'transform', kind: 'fields', fields: transform.fields.filter(field => ['pos', 'quat', 'scale'].includes(field.key)) });
    if (['mesh', 'skinnedMesh', 'instancedMesh'].includes(source.kind)) {
      if (source.components.some(component => component.name === 'MeshFilter')) sections.push({ key: 'mesh', component: 'MeshFilter', titleKey: source.kind === 'skinnedMesh' ? 'skeletalMesh' : 'staticMesh', kind: 'mesh', fields: [] });
      if (source.components.some(component => component.name === 'MeshRenderer')) sections.push({ key: 'materials', component: 'MeshRenderer', titleKey: 'materials', kind: 'materials', fields: [] });
    } else {
      for (const component of source.components.filter(component => source.primaryComponents.includes(component.name))) {
        const keys = COMMON_FIELDS[component.name];
        sections.push({ key: component.name, component: component.name, kind: 'fields', fields: keys ? component.fields.filter(field => keys.includes(field.key)) : component.fields });
      }
    }
    return sections;
  }
  const components = group === 'all' ? undefined : FUNCTIONAL_GROUPS[group];
  const common = inspectorSections(source, 'common');
  return source.components.flatMap((component): InspectorSection[] => {
    if (components && !components.has(component.name)) return [];
    if (group === 'rendering' && component.name === 'MeshFilter' && !common.some(section => section.kind === 'mesh')) {
      return [{ key: 'mesh', component: 'MeshFilter', titleKey: 'staticMesh', kind: 'mesh' as const, fields: [] }];
    }
    if (group === 'rendering' && component.name === 'Camera') {
      const used = new Set(Object.values(CAMERA_RENDER_SECTIONS).flat());
      return [...Object.entries(CAMERA_RENDER_SECTIONS).map(([key, keys]) => ({ key: `Camera.${key}`, component: 'Camera', titleKey: key, kind: 'fields' as const, fields: component.fields.filter(field => keys.includes(field.key)) })),
        { key: 'Camera', component: 'Camera', kind: 'fields' as const, fields: component.fields.filter(field => !used.has(field.key)) }].filter(section => section.fields.length > 0);
    }
    const materials = group === 'rendering' && component.name === 'MeshRenderer' && !common.some(section => section.kind === 'materials')
      ? [{ key: 'materials', component: 'MeshRenderer', titleKey: 'materials', kind: 'materials' as const, fields: [] }] : [];
    const fields = group === 'rendering' && component.name === 'MeshRenderer'
      ? component.fields.filter(field => field.key !== 'materials')
      : group === 'rendering' && component.name === 'MeshFilter' && common.some(section => section.kind === 'mesh')
        ? component.fields.filter(field => field.key !== 'assetHandle') : component.fields;
    if (group === 'rendering' && fields.length === 0) return materials;
    return [...materials, { key: component.name, component: component.name, kind: 'fields' as const, fields }];
  });
}

export function inspectorGroups(source: InspectorEntity): InspectorGroup[] {
  return [...(['common', 'object', 'rendering', 'physics', 'animation', 'media', 'effects', 'behavior'] as const).filter(group => inspectorSections(source, group).length > 0), 'all'];
}

export function compactInspectorTransform(field: InspectorField): InspectorField {
  if ((field.kind !== 'vector3' && field.kind !== 'vector4') || !field.value || typeof field.value !== 'object') return field;
  return { ...field, value: Object.fromEntries(Object.entries(field.value).map(([axis, value]) =>
    [axis, typeof value === 'number' && Number.isFinite(value) ? Number(value.toPrecision(6)) : value])) };
}

export function compactInspectorDisplay(field: InspectorField): InspectorField {
  const format = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return value;
    const compact = Number.isInteger(value) ? value : Number(value.toPrecision(6));
    return String(compact).length <= 9 ? compact : compact.toExponential(5).replace(/\.?(0+)(?=e)/, '');
  };
  if (field.kind === 'number') return { ...field, value: format(field.value) };
  if ((field.kind === 'vector3' || field.kind === 'vector4') && field.value && typeof field.value === 'object') {
    return { ...field, value: Object.fromEntries(Object.entries(field.value).map(([axis, value]) => [axis, format(value)])) };
  }
  return field;
}

export function inspectorWorkspaceTarget(workspace: WorkspaceState | null) {
  const selection = workspace?.sceneSelection;
  const targets = [workspace?.scenePreview?.target, workspace?.preview?.target, workspace?.projectTarget];
  if (!selection?.targetId) return targets.find(target => target !== undefined && target !== null);
  return targets.find(target => target?.targetId === selection.targetId
    && target?.generation === selection.targetGeneration);
}

export function inspectorFieldMatches(field: InspectorField, query: string, label = field.label) {
  const text = query.trim().toLowerCase();
  return !text || [field.key, field.label, label, field.resource?.asset?.name, field.resource?.asset?.sourceKey, field.resource?.guid,
    ...(field.resources ?? []).flatMap(resource => [resource.asset?.name, resource.asset?.sourceKey, resource.guid])]
    .some(value => String(value ?? '').toLowerCase().includes(text));
}

export function inspectorSectionMatches(section: InspectorSection, source: InspectorEntity, query: string, title: string, fieldLabel?: (field: InspectorField) => string) {
  const text = query.trim().toLowerCase();
  const matches = (value: unknown) => String(value ?? '').toLowerCase().includes(text);
  if (!text || matches(title) || matches(section.component)) return true;
  if (section.kind === 'mesh') return matches(JSON.stringify(source.meshReference)) || matches('assetHandle');
  if (section.kind === 'materials') return matches(JSON.stringify(source.materialOverrides)) || matches('materials');
  if (section.component === 'MeshRenderer' && section.fields.some(field => field.key === 'materials')
    && matches(JSON.stringify(source.materialOverrides))) return true;
  return section.fields.some(field => inspectorFieldMatches(field, query, fieldLabel?.(field) ?? field.label));
}
