import type { InspectorFormField, InspectorFormFieldKind, InspectorFormGroup } from './InspectorForm';
/** @param {string | number | undefined | null} key */
export function formatInspectorFieldLabel(key?: string | number | null) {
  if (key == null) return '';
  const text = String(key);
  if (!text) return '';
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/** @param {unknown} value */
function numericComponents(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return null;
  if (!value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return null;
  return value;
}

/** @param {unknown} schema */
function schemaTypeName(schema: unknown) {
  if (typeof schema === 'string') return schema.toLowerCase();
  if (schema && typeof schema === 'object' && 'type' in schema && typeof schema.type === 'string') return schema.type.toLowerCase();
  return '';
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function inspectorColorHex(value: unknown): string {
  if (typeof value === 'string') return value.toUpperCase();
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const channels = Array.isArray(value) ? value : record
    ? [record.r ?? record.x, record.g ?? record.y, record.b ?? record.z, record.a ?? record.w] : [];
  if (channels.length < 3 || !channels.slice(0, 3).every((channel) => typeof channel === 'number' && Number.isFinite(channel))) {
    return '';
  }
  const toByte = (channel: number) => {
    const linear = Math.max(0, Math.min(1, channel));
    const srgb = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255).toString(16).padStart(2, '0');
  };
  const rgb = channels.slice(0, 3).map((channel) => toByte(channel as number)).join('');
  const alpha = typeof channels[3] === 'number' && Number.isFinite(channels[3])
    ? Math.max(0, Math.min(1, channels[3])) : 1;
  return `#${rgb}${alpha < 1 ? Math.round(alpha * 255).toString(16).padStart(2, '0') : ''}`.toUpperCase();
}

/** @param {unknown} value */
function isAssetRefRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = (value as Record<string, unknown>);
  const identity = record.guid ?? record.id;
  if (typeof identity !== 'string' || identity.trim() === '') return false;
  return Object.values(record).every((entry) => entry == null || typeof entry !== 'object');
}

/**
 * @param {unknown} schema
 * @param {unknown} value
 * @returns {'bool' | 'switch' | 'number' | 'vector3' | 'vector4' | 'color' | 'asset' | 'enum' | 'text'}
 */
export function resolveInspectorFieldKind(schema: unknown, value: unknown): InspectorFormFieldKind {
  const type = schemaTypeName(schema);
  if (typeof value === 'boolean' && schema && typeof schema === 'object'
    && (schema as Record<string, unknown>).widget === 'switch') return 'switch';

  if (typeof value === 'boolean' || type.includes('bool')) return 'bool';
  if (type.includes('asset') || type.includes('guid') || type.includes('ref') || isAssetRefRecord(value)) return 'asset';
  if (typeof value === 'number' || type === 'f32' || type === 'f64' || type === 'i32' || type === 'u32' || type === 'number') {
    return 'number';
  }

  if (type.includes('color') || (schema && typeof schema === 'object'
    && (schema as Record<string, unknown>).widget === 'color')) return 'color';

  const array = numericComponents(value);
  if (array?.length === 3) return 'vector3';
  if (array?.length === 4) return 'vector4';

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = (value as Record<string, unknown>);
    if (typeof record.x === 'number' && typeof record.y === 'number' && typeof record.z === 'number') {
      return typeof record.w === 'number' ? 'vector4' : 'vector3';
    }
  }

  if (type.includes('enum') || (schema && typeof schema === 'object' && Array.isArray((schema as Record<string, unknown>).enum))) {
    return 'enum';
  }
  if (typeof value === 'string' && HEX_COLOR.test(value)) return 'color';
  if (Array.isArray(value) || (value && typeof value === 'object')) return 'text';
  return 'text';
}

/** @param {unknown} value @param {string} kind */
export function normalizeInspectorFieldValue(value: unknown, kind: string): InspectorFormField["value"] {
  if (value === undefined) return 'Unavailable';

  if (kind === 'asset' && (value === null || value === 0)) return '';
  if (kind === 'asset' && typeof value === 'number') return { name: `Handle ${value}` };
  if (kind === 'color' && (Array.isArray(value) || (value && typeof value === 'object'))) return value;

  if (kind === 'vector3' || kind === 'angle3') {
    const array = numericComponents(value);
    if (array?.length === 3) return { x: array[0], y: array[1], z: array[2] };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = (value as Record<string, number>);
      return { x: record.x ?? 0, y: record.y ?? 0, z: record.z ?? 0 };
    }
    return { x: 0, y: 0, z: 0 };
  }

  if (kind === 'vector4') {
    const array = numericComponents(value);
    if (array?.length === 4) return { x: array[0], y: array[1], z: array[2], w: array[3] };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = (value as Record<string, number>);
      return { x: record.x ?? 0, y: record.y ?? 0, z: record.z ?? 0, w: record.w ?? 0 };
    }
    return { x: 0, y: 0, z: 0, w: 0 };
  }

  if (kind === 'asset' && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = (value as Record<string, unknown>);
    return {
      ...(typeof record.guid === 'string' || typeof record.id === 'string'
        ? { guid: String(record.guid ?? record.id) } : {}),
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
      ...(record.missing === true ? { missing: true } : {}),
    };
  }

  if (kind === 'bool' || kind === 'switch' || kind === 'number') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/** @param {string} key @param {string} label @param {string} kind @param {unknown} value @param {string[] | undefined} [options] */
function freezeField(key: string, label: string, kind: InspectorFormFieldKind, value: unknown, options?: string[]): InspectorFormField {
  return Object.freeze({
    key,
    label,
    kind,
    value: normalizeInspectorFieldValue(value, kind),
    ...(options === undefined ? {} : { options: Object.freeze([...options]) }),
  });
}

function freezeGroup(group: InspectorFormGroup): InspectorFormGroup {
  return Object.freeze({
    key: group.key,
    name: group.name,
    ...(group.category === undefined ? {} : { category: group.category }),
    fields: Object.freeze(group.fields),
    ...(group.groups === undefined ? {} : { groups: Object.freeze(group.groups) }),
  });
}

/** @param {unknown} value */
function objectListItems(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) return null;
  return value;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} keyPrefix
 */
function partitionRecord(record: Record<string, unknown>, keyPrefix: string): { fields: InspectorFormField[]; groups: InspectorFormGroup[] } {
  const fields: InspectorFormField[] = [];
  const groups: InspectorFormGroup[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    const path = keyPrefix ? `${keyPrefix}.${key}` : key;
    const name = formatInspectorFieldLabel(key);
    const listed = objectListItems(value);
    if (listed) {
      const child = arrayToGroup(listed, path, name);
      if (child) groups.push(child);
      continue;
    }
    const kind = resolveInspectorFieldKind(undefined, value);
    const nestedObject = value && typeof value === 'object' && !Array.isArray(value)
      && kind !== 'vector3' && kind !== 'vector4' && kind !== 'asset';
    if (nestedObject) {
      const child = recordToGroup((value as Record<string, unknown>), path, name, 'all');
      if (child) groups.push(child);
      continue;
    }
    fields.push(freezeField(path, name, kind, value));
  }
  return { fields, groups };
}

/** @param {Record<string, unknown>} record @param {string} key @param {string} name @param {'all' | 'type' | 'capability'} category */
function recordToGroup(record: Record<string, unknown>, key: string, name: string, category: NonNullable<InspectorFormGroup["category"]>): InspectorFormGroup | null {
  const partitioned = partitionRecord(record, key);
  if (partitioned.fields.length === 0 && partitioned.groups.length === 0) return null;
  return freezeGroup({
    key,
    name,
    category,
    fields: partitioned.fields,
    groups: partitioned.groups,
  });
}

/** @param {Record<string, unknown>[]} items @param {string} path @param {string} name */
function arrayToGroup(items: Record<string, unknown>[], path: string, name: string): InspectorFormGroup | null {
  const groups: InspectorFormGroup[] = [];
  for (const [index, item] of items.entries()) {
    const label = item.name ?? item.id ?? item.slotName ?? item.guid ?? String(index);
    const child = recordToGroup(item, `${path}.${index}`, formatInspectorFieldLabel(String(label)), 'type');
    if (child) groups.push(child);
  }
  if (groups.length === 0) return null;
  return freezeGroup({
    key: path,
    name,
    category: 'capability',
    fields: [],
    groups,
  });
}

function identityFactFields(inspection: Record<string, unknown>): InspectorFormField[] {
  const asset = inspection.asset && typeof inspection.asset === 'object' ? inspection.asset as Record<string, unknown> : {};
  const source = inspection.source && typeof inspection.source === 'object' ? inspection.source as Record<string, unknown> : {};
  const ddc = inspection.ddc && typeof inspection.ddc === 'object' ? inspection.ddc as Record<string, unknown> : {};
  const facts: [string, string, unknown][] = [
    ['guid', 'GUID', inspection.guid ?? asset.guid],
    ['kind', 'Kind', asset.kind],
    ['name', 'Name', asset.name],
    ['path', 'Path', asset.path],
    ['source', 'Source', source.path ?? asset.sourcePath],
    ['revision', 'Revision', inspection.revision ?? asset.revision ?? source.revision],
    ['package', 'Package', asset.packageId ?? asset.packageUrl],
    ['ddc', 'DDC', ddc.state],
  ];
  const fields = [];
  for (const [key, label, value] of facts) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    fields.push(freezeField(key, label, resolveInspectorFieldKind(undefined, value), value));
  }
  return fields;
}

/**
 * @param {unknown} inspection
 * @param {{ identityTitle?: string }} [options]
 */
export function inspectorFormGroupsFromInspection(inspection: unknown, options: { identityTitle?: string } = {}): readonly InspectorFormGroup[] {
  if (!inspection || typeof inspection !== 'object' || Array.isArray(inspection)) {
    return Object.freeze([]);
  }
  const identityTitle = options.identityTitle ?? 'Asset';
  const identityFields = identityFactFields(inspection as Record<string, unknown>);
  const meta = (inspection as Record<string, unknown>).meta;
  let metaFields: InspectorFormField[] = [];
  let nested: InspectorFormGroup[] = [];
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const partitioned = partitionRecord((meta as Record<string, unknown>), 'meta');
    metaFields = partitioned.fields;
    nested = partitioned.groups;
  }
  const groups: InspectorFormGroup[] = [];
  const fields = [...identityFields, ...metaFields];
  if (fields.length) {
    groups.push(freezeGroup({
      key: 'identity',
      name: identityTitle,
      category: 'type',
      fields,
      groups: [],
    }));
  }
  groups.push(...nested);
  return Object.freeze(groups);
}
