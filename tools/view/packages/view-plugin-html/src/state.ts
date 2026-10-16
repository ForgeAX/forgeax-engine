import type { ViewFileOpenRequest } from '@forgeax/view-workspace-core/frontend-contract';

export type HtmlDevice = 'phone' | 'tablet' | 'desktop';
export type HtmlOrientation = 'portrait' | 'landscape';
export type HtmlInteraction = 'interact' | 'pan';
export type HtmlViewportPreset = { id: string; name: string; short: number; long: number };

export const HTML_DEVICE_PRESETS: Record<HtmlDevice, readonly HtmlViewportPreset[]> = {
  phone: [
    { id: 'iphone-14', name: 'iPhone 14', short: 390, long: 844 },
    { id: 'iphone-se', name: 'iPhone SE', short: 375, long: 667 },
    { id: 'iphone-16', name: 'iPhone 16', short: 393, long: 852 },
    { id: 'iphone-16-pro-max', name: 'iPhone 16 Pro Max', short: 440, long: 956 },
    { id: 'pixel-9', name: 'Pixel 9', short: 412, long: 915 },
    { id: 'samsung-a55', name: 'Samsung A55', short: 384, long: 854 },
  ],
  tablet: [
    { id: 'ipad-air', name: 'iPad Air', short: 820, long: 1180 },
    { id: 'ipad-mini', name: 'iPad mini', short: 744, long: 1133 },
    { id: 'ipad-pro', name: 'iPad Pro 12.9', short: 1024, long: 1366 },
    { id: 'surface-pro', name: 'Surface Pro', short: 912, long: 1368 },
  ],
  desktop: [
    { id: 'laptop', name: 'Laptop', short: 900, long: 1440 },
    { id: 'hd', name: 'HD', short: 720, long: 1280 },
    { id: 'full-hd', name: 'Full HD', short: 1080, long: 1920 },
    { id: 'qhd', name: 'QHD', short: 1440, long: 2560 },
  ],
};

export function presetSize(preset: HtmlViewportPreset, orientation: HtmlOrientation) {
  return orientation === 'portrait'
    ? { width: preset.short, height: preset.long }
    : { width: preset.long, height: preset.short };
}

export type HtmlUiViewState = {
  file: ViewFileOpenRequest['file'] | null;
  revision: number;
  width: number;
  height: number;
  zoom: 'fit' | 'actual' | number;
  pan: { x: number; y: number };
  interaction: HtmlInteraction;
  device: HtmlDevice;
  orientation: HtmlOrientation;
  status: 'idle' | 'loading' | 'ready' | 'error';
  size?: number;
  mtime?: number;
  issues: readonly string[];
};

export function createHtmlUiViewState() {
  let state: HtmlUiViewState = { file: null, revision: 0, ...presetSize(HTML_DEVICE_PRESETS.phone[0]!, 'portrait'), zoom: 'fit', pan: { x: 0, y: 0 }, interaction: 'interact', device: 'phone', orientation: 'portrait', status: 'idle', issues: [] };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<HtmlUiViewState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    open(file: ViewFileOpenRequest['file']) { update({ file, revision: state.revision + 1, pan: { x: 0, y: 0 }, status: 'loading', issues: [], size: undefined, mtime: undefined }); },
    selectDevice(device: HtmlDevice) {
      if (device === state.device) return;
      update({ device, ...presetSize(HTML_DEVICE_PRESETS[device][0]!, state.orientation), zoom: 'fit', pan: { x: 0, y: 0 } });
    },
    selectPreset(id: string) {
      const preset = HTML_DEVICE_PRESETS[state.device].find((item) => item.id === id);
      if (!preset) return;
      const size = presetSize(preset, state.orientation);
      if (size.width === state.width && size.height === state.height) return;
      update({ ...size, zoom: 'fit', pan: { x: 0, y: 0 } });
    },
    selectOrientation(orientation: HtmlOrientation) {
      if (orientation === state.orientation) return;
      update({ orientation, width: state.height, height: state.width, zoom: 'fit', pan: { x: 0, y: 0 } });
    },
    setDimension(name: 'width' | 'height', value: number) {
      const width = name === 'width' ? value : state.width;
      const height = name === 'height' ? value : state.height;
      if (width === state.width && height === state.height) return;
      update({ width, height, orientation: width === height ? state.orientation : width > height ? 'landscape' : 'portrait', zoom: 'fit', pan: { x: 0, y: 0 } });
    },
    setZoom(zoom: 'fit' | 'actual') { update({ zoom, pan: { x: 0, y: 0 } }); },
    zoomAt(zoom: number, pan: { x: number; y: number }) { update({ zoom, pan }); },
    panBy(x: number, y: number) { update({ pan: { x: state.pan.x + x, y: state.pan.y + y } }); },
    update,
    dispose() { listeners.clear(); },
  };
}

export type HtmlUiStateStore = ReturnType<typeof createHtmlUiViewState>;
