/** CI reduces repeated sampling and pixels; ordinary diagnostics keep the full workload. */
export function browserProofWorkload(lightweight = process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1') {
  return {
    runtimeViewport: lightweight ? { width: 1000, height: 700 } : { width: 1440, height: 1000 },
    gameViewport: lightweight ? { width: 1000, height: 700 } : { width: 1440, height: 900 },
    sceneFrames: lightweight ? 60 : 300,
    resourceCycles: lightweight ? 2 : 6,
  };
}
