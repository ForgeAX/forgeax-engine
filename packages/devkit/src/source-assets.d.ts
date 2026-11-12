/** Text vector sources are embedded by Vite and the package bundler. */
declare module '*.svg?raw' {
  const source: string;
  export default source;
}
