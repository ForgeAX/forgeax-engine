import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodePng } from '@forgeax/engine-image/png';
import type { EncodedTape } from '@forgeax/engine-rhi-debug';
import type { FieldImage } from './renderer-irradiance-field.fixture';

type Energy = Pick<FieldImage, 'red' | 'mean'>;
type EvidenceImage = Pick<FieldImage, 'bytes' | 'red' | 'mean'> & {
  readonly receipt: Pick<FieldImage['receipt'], 'frameId' | 'deviceGeneration'>;
};

function redPlanePng(image: Energy, size: number) {
  if (image.red.length !== size * size)
    throw new Error('Complete square red-plane extent required');
  const rgba = new Uint8Array(size * size * 4);
  for (let pixel = 0; pixel < image.red.length; pixel++) {
    const value = image.red[pixel] ?? Number.NaN;
    const mapped = value / (1 + value);
    const byte = Math.round(Math.max(0, Math.min(1, mapped)) * 255);
    rgba.set(Number.isFinite(value) ? [byte, byte, byte, 255] : [255, 0, 255, 255], pixel * 4);
  }
  return encodePng(size, size, rgba);
}

/** Persist actual captured inputs before any movement assertion. The PNGs show
 * the linear-HDR red plane used by the original oracle, with Reinhard exposure1. */
export function persistFieldEditMoveEvidence(input: {
  readonly directory: string;
  readonly size: number;
  readonly encoded: Pick<EncodedTape, 'bytes' | 'digest'>;
  readonly dark: EvidenceImage;
  readonly frames: readonly EvidenceImage[];
  readonly reference: Energy;
  readonly edit: EvidenceImage;
  readonly metadata: Readonly<Record<string, unknown>>;
}) {
  const { directory } = input;
  mkdirSync(directory, { recursive: true });
  const files: { name: string; bytes: number; sha256: string }[] = [];
  const save = (name: string, bytes: Uint8Array) => {
    writeFileSync(`${directory}/${name}`, bytes);
    files.push({
      name,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  };
  save('edit-frame.rhitape', input.encoded.bytes);
  for (const [name, image] of [
    ['dark', input.dark],
    ...input.frames.map((frame, index) => [`reference-${index}`, frame] as const),
    ['moved-first', input.edit],
  ] as const)
    save(`edit-${name}.linear-hdr.bin`, image.bytes);
  for (const [name, image] of [
    ['reference-mean', input.reference],
    ['moved-first', input.edit],
    ['dark', input.dark],
  ] as const) {
    save(
      `edit-${name}.red.f32`,
      new Uint8Array(image.red.buffer, image.red.byteOffset, image.red.byteLength),
    );
    save(`edit-${name}.red.png`, redPlanePng(image, input.size));
  }
  const difference = Float32Array.from(input.edit.red, (value, index) =>
    Math.abs(value - (input.reference.red[index] ?? Number.NaN)),
  );
  save(
    'edit-reference-moved-absdiff.red.png',
    redPlanePng({ red: difference, mean: 0 }, input.size),
  );
  const receipt = {
    status: 'CAPTURED_MOVE_EVIDENCE_BEFORE_ASSERTIONS_NOT_ACCEPTANCE',
    width: input.size,
    height: input.size,
    mapping:
      'Linear HDR red plane; fixed Reinhard exposure1, nonfinite magenta. Raw full observation bytes retained unchanged.',
    digest: input.encoded.digest,
    referenceMean: input.reference.mean,
    editMean: input.edit.mean,
    ratio: input.edit.mean / input.reference.mean,
    nonfiniteRed: {
      reference: [...input.reference.red].filter((value) => !Number.isFinite(value)).length,
      edit: [...input.edit.red].filter((value) => !Number.isFinite(value)).length,
    },
    referenceFrames: input.frames.map((image) => ({
      frameId: image.receipt.frameId,
      deviceGeneration: image.receipt.deviceGeneration,
      mean: image.mean,
    })),
    editFrameId: input.edit.receipt.frameId,
    editDeviceGeneration: input.edit.receipt.deviceGeneration,
    metadata: input.metadata,
    files,
  };
  writeFileSync(`${directory}/edit-move-evidence.json`, JSON.stringify(receipt, null, 2));
  return receipt;
}
