import type { ThreeFrameCapture } from '@forgeax/engine/three';
import { commands } from 'vitest/browser';
import { compactTape } from '../../../runtime/src/__tests__/compact-tape.fixture';
import { displayPixels } from './render.fixture';

export async function saveBrowserBytes(name: string, bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  await commands.writeFile(`artifacts/three-compat/${name}`, btoa(binary), 'base64');
}

export async function saveBrowserEvidence(
  name: string,
  capture: ThreeFrameCapture,
  expected?: Uint8Array,
) {
  await saveBrowserBytes(`${name}.rhitape`, compactTape(capture.tape).bytes);
  await saveBrowserBytes(`${name}.rgba`, displayPixels(capture));
  if (expected !== undefined) await saveBrowserBytes(`${name}.three.rgba`, expected);
}
