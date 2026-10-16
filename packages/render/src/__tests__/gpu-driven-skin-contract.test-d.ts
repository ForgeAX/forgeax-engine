import type { PreparedGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import type { SkinPaletteReceipt } from '../systems/skin-palette-types';

declare const draw: PreparedGpuDrivenDraw;
declare const receipt: SkinPaletteReceipt;

// The skin address and palette receipt are one generation-scoped contract.
const generation: number = receipt.generation;
const address = draw.skinPaletteAddress;
void generation;
void address;
