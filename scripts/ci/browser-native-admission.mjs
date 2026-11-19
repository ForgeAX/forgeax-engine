/** Explicit native acceptance requires the browser's actual adapter identity. */
export function requireNativeBrowserAdapter(adapter) {
  const info = adapter?.info;
  const identity = info && {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    isFallbackAdapter: info.isFallbackAdapter,
  };
  if (
    !identity ||
    identity.isFallbackAdapter !== false ||
    /swiftshader|llvmpipe|lavapipe|software|warp/i.test(JSON.stringify(identity))
  )
    throw new Error(`Browser native GPU admission failed: ${JSON.stringify(identity ?? null)}`);
  return identity;
}
