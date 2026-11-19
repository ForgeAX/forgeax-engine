import { MD2CharacterComplex as OriginalMD2CharacterComplex } from 'three/examples/jsm/misc/MD2CharacterComplex.js';
import type { MorphBlendMesh } from './MorphBlendMesh';

/** The original animation configuration is a name map, not an array. */
export interface MD2CharacterComplex
  extends Omit<
    OriginalMD2CharacterComplex,
    | 'meshBody'
    | 'meshWeapon'
    | 'weapons'
    | 'meshes'
    | 'animations'
    | 'activeAnimation'
    | 'oldAnimation'
    | 'currentSkin'
    | 'shareParts'
  > {
  meshBody: MorphBlendMesh | null;
  meshWeapon: MorphBlendMesh | null;
  weapons: MorphBlendMesh[];
  meshes: MorphBlendMesh[];
  animations: Record<string, string | undefined>;
  activeAnimation: string | null | undefined;
  oldAnimation: string | null | undefined;
  currentSkin: number | undefined;
  shareParts(original: MD2CharacterComplex): void;
}
export const MD2CharacterComplex = OriginalMD2CharacterComplex as unknown as Omit<
  typeof OriginalMD2CharacterComplex,
  'prototype'
> & {
  new (): MD2CharacterComplex;
  readonly prototype: MD2CharacterComplex;
};
