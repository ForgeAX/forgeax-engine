import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { type Drawing, model, sel } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0e9'),
  build() {
    const m = model();
    const sheet: Drawing = {
      name: 'tube sheet',
      views: [{ id: 'front', ortho: 'front' }, { id: 'plan', ortho: 'top' }],
      items: [
        { id: 'outline', view: 'front', role: 'silhouette', kind: 'curve', closed: true, curve: { kind: 'polyline', points: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] } },
        { id: 'base', view: 'front', role: 'package', kind: 'point', at: [0.6, -0.5] },
        { id: 'top', view: 'front', role: 'package', kind: 'point', at: [0.6, 0.5] },
        { id: 'height', view: 'front', role: 'package', kind: 'dimension', measure: 'distance', refs: ['base', 'top'], value: 1, basis: 'estimate' },
        { id: 'lid', view: 'plan', role: 'construction', kind: 'curve', closed: true, curve: { kind: 'spline', points: [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]] }, tolerance: 0.01 },
      ],
    };
    m.drawing(sheet);
    m.cylinder({ radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSegments: 24, tag: 'tube' });
    m.shell(sel.tag('tube'), { thickness: 0.1, open: sel.tag('tube').and(sel.facing('+y')) });
    m.extrudeContour(sheet, 'lid', { depth: [0.7, 0.8], tag: 'lid' });
    m.box({ size: [0.1, 0.1, 0.4], center: [0, 0.2, 0.75], tag: 'pin' });
    m.uv.project({ mode: 'box', scale: 1 });
    return m.finish({ key: 'tube' });
  },
});
