import { PackageId } from '@forgeax/engine/pack/guid';

const parsed = PackageId.parse('f04e8f4a-16b4-4a61-a611-114016aaf004');
if (!parsed.ok) throw new Error('Water R4 packageId is invalid');
export const WATER_R4_PACKAGE = parsed.value;
export const FOAM_MATERIAL_MODES = {
  default: { foamHeightBias: -1, foamScatterBias: 0.25 },
  static: { foamHeightBias: 1, foamScatterBias: 0 },
} as const;
export type FoamMaterialMode = keyof typeof FOAM_MATERIAL_MODES;
export function foamMaterialKey(mode: FoamMaterialMode, enabled: boolean, lod = false): string {
  return `material/ocean-${mode === 'static' ? 'static-' : ''}${enabled ? 'foam' : 'clear'}${lod ? '-lod' : ''}`;
}
export type PontoonCount=1|4|16;
export function pontoonLayout(count:PontoonCount):readonly (readonly [number,number,number])[] {
  if(count===1) return [[0,0.2,0]];
  const side=count===4?2:4,points:[number,number,number][]=[];
  for(let x=0;x<side;x++) for(let z=0;z<side;z++) points.push([-1.25+x*2.5/(side-1),0.2,-0.72+z*1.44/(side-1)]);
  return points;
}
export function pontoonRadius(count:PontoonCount):number {return count===16?0.78:0.8;}
