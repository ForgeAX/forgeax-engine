/** Only the native Mini Game operations consumed by the platform owner. */
export interface WechatCanvas {
  width: number;
  height: number;
}

export interface WechatWindowInfo {
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly pixelRatio: number;
  readonly safeArea?: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface WechatHost {
  readonly wx: {
    createCanvas(): WechatCanvas;
    getPerformance(): { now(): number };
    getDeviceInfo(): { readonly platform: string };
    getWindowInfo(): WechatWindowInfo;
    onShow(listener: () => void): void;
    offShow(listener: () => void): void;
    onHide(listener: () => void): void;
    offHide(listener: () => void): void;
    onWindowResize(listener: () => void): void;
    offWindowResize(listener: () => void): void;
    onDeviceOrientationChange(listener: () => void): void;
    offDeviceOrientationChange(listener: () => void): void;
    onMemoryWarning?(listener: (event: { readonly level: number }) => void): void;
    offMemoryWarning?(listener: (event: { readonly level: number }) => void): void;
  };
  requestAnimationFrame(callback: () => void): unknown;
  cancelAnimationFrame(id: unknown): void;
}
