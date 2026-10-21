import { useEffect, useRef, useState, type PointerEvent } from 'react';

export function useLocalSize(
  key: string,
  initial: number,
  min: number,
  max: number,
  previousDefault?: number,
): readonly [number, (next: number | ((prev: number) => number)) => void] {
  const clamp = (value: number) => Math.min(max, Math.max(min, value));
  const [value, setValueRaw] = useState<number>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return initial;
      const parsed = Number(raw);
      if (parsed === previousDefault) return initial;
      return Number.isFinite(parsed) ? clamp(parsed) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      /* ignore quota / privacy mode */
    }
  }, [key, value]);
  const setValue = (next: number | ((prev: number) => number)) => {
    setValueRaw((prev) => clamp(typeof next === 'function' ? next(prev) : next));
  };
  return [value, setValue] as const;
}

export function ResizeHandle({
  onDrag,
  onDragEnd,
  title,
}: {
  onDrag: (delta: number) => void;
  onDragEnd?: () => void;
  title?: string;
}) {
  const startRef = useRef<number | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    startRef.current = event.clientX;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (startRef.current == null) return;
    const delta = event.clientX - startRef.current;
    startRef.current = event.clientX;
    onDrag(delta);
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (startRef.current == null) return;
    startRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    onDragEnd?.();
  };
  return (
    <div
      className="cb-resize-handle"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      title={title}
      role="separator"
      aria-orientation="vertical"
    />
  );
}
