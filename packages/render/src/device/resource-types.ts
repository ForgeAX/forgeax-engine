export const DEVICE_RESOURCE_KINDS = [
  'device',
  'listener',
  'surface',
  'shader',
  'pipeline',
  'buffer',
  'texture',
  'binding',
  'scene-table',
  'feature',
  'post-effect',
] as const;

export type DeviceResourceKind = (typeof DEVICE_RESOURCE_KINDS)[number];

export interface DeviceScopeReceipt {
  readonly owner: string;
  readonly generation: number;
  readonly resourceCount: number;
}
