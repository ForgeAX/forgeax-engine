declare module 'pako' {
  const pako: {
    gzip: (data: Uint8Array, options?: { readonly level?: number }) => Uint8Array;
    ungzip: (data: Uint8Array) => Uint8Array;
    deflate: (data: Uint8Array, options?: { readonly level?: number }) => Uint8Array;
  };

  export default pako;
}
