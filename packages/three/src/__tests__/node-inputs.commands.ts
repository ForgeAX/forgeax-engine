import { cookPhysicalMaterials } from '@forgeax/engine/three/build';
import type {} from 'vitest/browser';

let publication: Promise<string> | undefined;
export function prepareThreeNodeInputMaterials(): Promise<string> {
  publication ??= cookPhysicalMaterials([['map', 'alphaMap']]);
  return publication;
}
export const threeNodeInputCommands = { prepareThreeNodeInputMaterials };
declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareThreeNodeInputMaterials(): Promise<string>;
  }
}
