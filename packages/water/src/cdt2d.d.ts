declare module 'cdt2d' {
  export default function cdt2d(
    points: readonly (readonly [number, number])[],
    edges?: readonly (readonly [number, number])[],
    options?: { delaunay?: boolean; interior?: boolean; exterior?: boolean; infinity?: boolean },
  ): number[][];
}
