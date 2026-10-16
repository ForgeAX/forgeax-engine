declare module 'core-js-pure/actual/structured-clone.js' {
  const clone: <T>(value: T, options?: { transfer?: object[] }) => T;
  export default clone;
}

declare module 'core-js-pure/actual/url/index.js' {
  const URL: typeof import('node:url').URL;
  export default URL;
}

declare module 'core-js-pure/actual/url-search-params/index.js' {
  const params: typeof URLSearchParams;
  export default params;
}

declare module 'core-js-pure/actual/dom-exception/index.js' {
  const exception: typeof DOMException;
  export default exception;
}
