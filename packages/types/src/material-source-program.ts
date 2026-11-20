import type { MaterialCookRasterContext } from './material/program-context.js';
import type { MaterialTable } from './material/resolve.js';
import type { MaterialProgramAddress } from './material-program-abi.js';

export interface MaterialSourcePublication {
  readonly schemaVersion: 'material-source-modules/1';
  readonly modules: readonly (
    | { readonly kind: 'engine'; readonly module: string; readonly digest: string }
    | {
        readonly kind: 'project';
        readonly module: string;
        readonly digest: string;
        readonly source: string;
      }
  )[];
}

/** One source closure shared by all runtime selections for an authored material. */
export interface MaterialRasterSourceInputs {
  readonly modules: MaterialSourcePublication;
  readonly materials: MaterialTable;
}

/** Exact producer-selected compilation input with the expected output identity. */
export interface MaterialRasterSourceSelection {
  readonly material: string;
  readonly pass: string;
  readonly context: MaterialCookRasterContext;
  readonly address: MaterialProgramAddress;
  readonly artifactDigest: string;
  readonly vertexColorAvailable?: boolean;
}

/** Device-independent program declaration carried by render publication. */
export interface MaterialRasterSourceRecipe {
  readonly inputs: MaterialRasterSourceInputs;
  readonly selection: MaterialRasterSourceSelection;
}
