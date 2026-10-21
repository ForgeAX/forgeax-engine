declare module 'upng-js' {
  interface DecodedPng {
    readonly width: number;
    readonly height: number;
    readonly depth: number;
    readonly ctype: number;
    readonly data: Uint8Array;
  }
  const UPNG: {
    decode(bytes: Uint8Array | ArrayBuffer): DecodedPng;
    toRGBA8(image: DecodedPng): ArrayBuffer[];
  };
  export default UPNG;
}
