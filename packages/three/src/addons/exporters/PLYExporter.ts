import type {
  PLYExporterOptions,
  PLYExporterOptionsBinary,
  PLYExporterOptionsString,
} from 'three/examples/jsm/exporters/PLYExporter.js';
import { PLYExporter as OriginalPLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js';
import type { Object3D } from 'three/src/Three.Core.js';

export type {
  PLYExporterOptions,
  PLYExporterOptionsBase,
  PLYExporterOptionsBinary,
  PLYExporterOptionsString,
} from 'three/examples/jsm/exporters/PLYExporter.js';
/** r187 returns bytes synchronously; the callback is optional. */
export interface PLYExporter {
  parse(
    object: Object3D,
    onDone: ((result: ArrayBuffer) => void) | null | undefined,
    options: PLYExporterOptionsBinary,
  ): ArrayBuffer | null;
  parse(
    object: Object3D,
    onDone?: ((result: string) => void) | null,
    options?: PLYExporterOptionsString,
  ): string | null;
  parse(
    object: Object3D,
    onDone: ((result: string | ArrayBuffer) => void) | null | undefined,
    options: PLYExporterOptions,
  ): string | ArrayBuffer | null;
}
export const PLYExporter = OriginalPLYExporter as unknown as Omit<
  typeof OriginalPLYExporter,
  'prototype'
> & { new (): PLYExporter; readonly prototype: PLYExporter };
