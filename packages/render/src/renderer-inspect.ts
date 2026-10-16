import type { TextureFormat } from '@forgeax/engine-rhi';
import type { TemporalFrame, TemporalResetReason } from './temporal/frame';

export type TemporalInspectionStatus =
  | 'authored-off'
  | 'available'
  | 'capability-unavailable'
  | 'temporal-degraded';

export interface TemporalInspection {
  readonly status: TemporalInspectionStatus;
  readonly resetReason: TemporalResetReason;
  readonly historyEpoch: number;
  readonly deviceEpoch: number;
  readonly backend: string | undefined;
  readonly format: TextureFormat | undefined;
  readonly limits: Readonly<{
    readonly maxTextureDimension2D?: number;
    readonly maxTextureDimension3D?: number;
    readonly maxTextureArrayLayers?: number;
  }>;
  readonly compute: 'available' | 'unavailable';
  readonly storage: 'available' | 'unavailable';
}

export interface TemporalInspectionInput {
  readonly authored: boolean;
  readonly capability: 'available' | 'unavailable';
  readonly degraded?: boolean;
  readonly frame?: TemporalFrame;
  readonly backend?: string;
  readonly format?: TextureFormat;
  readonly limits?: Readonly<Record<string, number>>;
}
