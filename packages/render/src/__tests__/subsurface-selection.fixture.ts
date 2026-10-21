import { MaterialResource } from '../material-resource';
import type { MaterialSnapshot } from '../render-system-extract';
import { MaterialFrame } from '../scene/material-dispatch';
import { SubsurfaceSelection } from '../subsurface/selection';

export function subsurfaceSelection(materials: Iterable<MaterialSnapshot>): SubsurfaceSelection {
  const selection = new SubsurfaceSelection();
  let frame = new MaterialFrame(undefined);
  for (const snapshot of materials) {
    const material = new MaterialResource(snapshot);
    frame = frame.with(material);
    selection.add({ material, materials: [material] }, frame);
  }
  selection.adopt(frame);
  return selection;
}
