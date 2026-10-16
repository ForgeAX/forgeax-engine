import { decodeMeshDistanceField } from '../../../packages/geometry/dist/index.mjs';
import { createSdfCardLookup, createSdfQuery } from '../../../packages/render/dist/internal.mjs';

/** Diagnostic controller: both capture and cost execute these same production owners. */
export async function createSdfCardChains(device, compile, cards, sources, probeDirectory) {
  if (!probeDirectory) return [];
  const load = async (name) => {
    const response = await fetch(`/@fs/${probeDirectory}/${name}`);
    if (!response.ok) throw Error(`SDF probe fetch failed: ${name} (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const json = async (name) => JSON.parse(new TextDecoder().decode(await load(name)));
  const manifest = await json('probes.json'),
    chains = [];
  try {
    for (const row of manifest.rows) {
      const data = await json(row.file);
      const field = (
        await decodeMeshDistanceField(await load(data.fieldFile), data.meshDigest)
      ).unwrap();
      const query = (
        await createSdfQuery(device, compile, [{ ...data.instance, field }], data.rays, {
          maxSteps: 512,
        })
      ).unwrap();
      try {
        const lookup = (await createSdfCardLookup(device, compile, query, cards, sources)).unwrap();
        chains.push({ section: row.section, query, lookup });
      } catch (e) {
        query.dispose();
        throw e;
      }
    }
    return chains;
  } catch (e) {
    for (const chain of chains) {
      chain.lookup.dispose();
      chain.query.dispose();
    }
    throw e;
  }
}
