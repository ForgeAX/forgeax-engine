import type { LoopEdge, ShapeAssembler } from './assembler';
import type { Curve, Shape, Surface } from './types';

/** Carries one input solid's surfaces, curves and edges into the output assembler, once each. */
export class Copier {
  private readonly surfaces = new Map<number, number>();
  private readonly curves = new Map<number, number>();
  private readonly edges = new Map<number, number>();

  private readonly src: Shape;
  private readonly asm: ShapeAssembler;

  constructor(src: Shape, asm: ShapeAssembler) {
    this.src = src;
    this.asm = asm;
  }

  surface(s: number): number {
    const known = this.surfaces.get(s);
    if (known !== undefined) return known;
    const id = this.asm.surface(this.src.surfaces[s] as Surface);
    this.surfaces.set(s, id);
    return id;
  }

  /** Makes this solid's edge `src` reuse an already copied output edge, for coincident bore circles. */
  alias(src: number, out: number): void {
    this.edges.set(src, out);
  }

  edge(e: number): number {
    const known = this.edges.get(e);
    if (known !== undefined) return known;
    const ed = this.src.edges[e] as Shape['edges'][number];
    let id: number;
    if (ed.curve < 0) {
      id = this.asm.degenerateEdge(this.asm.vertex(this.src.vertices[ed.v0]?.p ?? [0, 0, 0]));
    } else {
      let cid = this.curves.get(ed.curve);
      if (cid === undefined) {
        cid = this.asm.curve(this.src.curves[ed.curve] as Curve);
        this.curves.set(ed.curve, cid);
      }
      id = this.asm.edge(cid, ed.t0, ed.t1);
    }
    this.edges.set(e, id);
    return id;
  }

  loopEdges(loop: number): LoopEdge[] {
    const l = this.src.loops[loop];
    return (l?.coedges ?? []).map((c) => ({
      edge: this.edge(this.src.coedges[c]?.edge ?? -1),
    }));
  }
}
