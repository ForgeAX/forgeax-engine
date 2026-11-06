import { model, sel, type Model, type Tuple3 } from '@forgeax/engine/modeling';

export interface ConvoyBinding { readonly tag: string; readonly joint: string }

/** One paired part owns its bake identity and rigid binding in both sources. */
export function addConvoyPart(
  targets: readonly [Model | Model[], Model | Model[]],
  bindings: ConvoyBinding[], joint: string, tag: string,
  build: (part: Model, high: boolean) => void,
  placement: { readonly translate?: Tuple3; readonly structural?: boolean } = {},
): void {
  bindings.push({ tag, joint });
  for (const [index, target] of targets.entries()) {
    const part = model();
    build(part, index === 1);
    part.tag(sel.all(), tag);
    if (placement.structural) part.tag(sel.all(), 'structural');
    if (part.poisoned !== undefined) throw part.poisoned;
    if (Array.isArray(target)) {
      if (placement.translate !== undefined) part.translate(sel.all(), placement.translate);
      if (part.poisoned !== undefined) throw part.poisoned;
      target.push(part);
    } else target.append(part, placement.translate === undefined ? {} : { translate: placement.translate });
  }
}

export function appendConvoyParts(target: Model, parts: Model[]): void {
  // Peer assembly bounds the rollback copies while the complete body stays untouched.
  let level = parts;
  while (level.length > 1) {
    const next: Model[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const part = level[i]!;
      if (level[i + 1] !== undefined) part.append(level[i + 1]!);
      next.push(part);
    }
    level = next;
  }
  if (level[0] !== undefined) target.append(level[0]);
}
