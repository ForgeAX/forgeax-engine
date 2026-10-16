export type FloatingMenuPlacement = 'right' | 'left' | 'bottom' | 'top';

export type AnchorRect = Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left' | 'width' | 'height'>;

export type ResolveFloatingMenuPositionOptions = {
  gap?: number;
  padding?: number;
  preference?: FloatingMenuPlacement[];
};

const DEFAULT_PREFERENCE: FloatingMenuPlacement[] = ['right', 'left', 'bottom', 'top'];

function viewportSize() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function candidatePosition(
  placement: FloatingMenuPlacement,
  anchor: AnchorRect,
  menuWidth: number,
  menuHeight: number,
  gap: number,
) {
  switch (placement) {
    case 'right':
      return { x: anchor.right + gap, y: anchor.top };
    case 'left':
      return { x: anchor.left - gap - menuWidth, y: anchor.top };
    case 'bottom':
      return { x: anchor.left + anchor.width / 2 - menuWidth / 2, y: anchor.bottom + gap };
    case 'top':
      return { x: anchor.left + anchor.width / 2 - menuWidth / 2, y: anchor.top - gap - menuHeight };
  }
}

function fitsHorizontally(x: number, menuWidth: number, padding: number) {
  const { width } = viewportSize();
  return x >= padding && x + menuWidth <= width - padding;
}

function fitsVertically(y: number, menuHeight: number, padding: number) {
  const { height } = viewportSize();
  return y >= padding && y + menuHeight <= height - padding;
}

function fitsViewport(x: number, y: number, menuWidth: number, menuHeight: number, padding: number) {
  return fitsHorizontally(x, menuWidth, padding) && fitsVertically(y, menuHeight, padding);
}

function visibleArea(x: number, y: number, menuWidth: number, menuHeight: number, padding: number) {
  const { width, height } = viewportSize();
  const left = Math.max(x, padding);
  const top = Math.max(y, padding);
  const right = Math.min(x + menuWidth, width - padding);
  const bottom = Math.min(y + menuHeight, height - padding);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function clampForPlacement(
  placement: FloatingMenuPlacement,
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  padding: number,
) {
  const { width, height } = viewportSize();
  if (placement === 'right' || placement === 'left') {
    return {
      x: Math.max(padding, Math.min(x, width - padding - menuWidth)),
      y: Math.max(padding, Math.min(y, height - padding - menuHeight)),
    };
  }
  return {
    x: Math.max(padding, Math.min(x, width - padding - menuWidth)),
    y: Math.max(padding, Math.min(y, height - padding - menuHeight)),
  };
}

export function resolveFloatingMenuPosition(
  anchor: AnchorRect,
  menuWidth: number,
  menuHeight: number,
  options: ResolveFloatingMenuPositionOptions = {},
): { x: number; y: number; placement: FloatingMenuPlacement } {
  const gap = options.gap ?? 8;
  const padding = options.padding ?? 8;
  const preference = options.preference ?? DEFAULT_PREFERENCE;

  let best = preference[0]!;
  let bestPoint = candidatePosition(best, anchor, menuWidth, menuHeight, gap);
  let bestScore = -1;

  for (const placement of preference) {
    const point = candidatePosition(placement, anchor, menuWidth, menuHeight, gap);
    const horizontal = placement === 'right' || placement === 'left';
    const vertical = placement === 'top' || placement === 'bottom';
    if (horizontal && fitsHorizontally(point.x, menuWidth, padding)) {
      return { ...clampForPlacement(placement, point.x, point.y, menuWidth, menuHeight, padding), placement };
    }
    if (vertical && fitsVertically(point.y, menuHeight, padding)) {
      return { ...clampForPlacement(placement, point.x, point.y, menuWidth, menuHeight, padding), placement };
    }
    if (fitsViewport(point.x, point.y, menuWidth, menuHeight, padding)) {
      return { ...point, placement };
    }
    const score = visibleArea(point.x, point.y, menuWidth, menuHeight, padding);
    if (score > bestScore) {
      bestScore = score;
      best = placement;
      bestPoint = point;
    }
  }

  const clamped = clampForPlacement(best, bestPoint.x, bestPoint.y, menuWidth, menuHeight, padding);
  return { ...clamped, placement: best };
}

export function anchorRectFromPoint(x: number, y: number): AnchorRect {
  return { top: y, right: x, bottom: y, left: x, width: 0, height: 0 };
}

export type MenuDropdownAlign = 'start' | 'end';

export type ResolveMenuDropdownPositionOptions = {
  gap?: number;
  padding?: number;
};

/** Places a menu below (or above) the anchor, start- or end-aligned to the trigger. */
export function resolveMenuDropdownPosition(
  anchor: AnchorRect,
  menuWidth: number,
  menuHeight: number,
  align: MenuDropdownAlign,
  options: ResolveMenuDropdownPositionOptions = {},
): { x: number; y: number } {
  const gap = options.gap ?? 4;
  const padding = options.padding ?? 8;
  const { width: viewportWidth, height: viewportHeight } = viewportSize();

  let x = align === 'end' ? anchor.right - menuWidth : anchor.left;
  let y = anchor.bottom + gap;

  const spaceBelow = viewportHeight - padding - anchor.bottom - gap;
  const spaceAbove = anchor.top - gap - padding;
  if (menuHeight > spaceBelow && spaceAbove > spaceBelow) {
    y = anchor.top - gap - menuHeight;
  }

  x = Math.max(padding, Math.min(x, viewportWidth - padding - menuWidth));
  y = Math.max(padding, Math.min(y, viewportHeight - padding - menuHeight));
  return { x, y };
}
