import { ownConfigurationData } from './configuration-data';
import { EngineConfigurationError } from './configuration-error';
import type { EngineConfigurationStore, QualitySelection } from './configuration-types';
import { validateQualitySelection } from './configuration-validation';

/** Host storage owns bytes; only versioned user intent survives between App instances. */
export function createEngineConfigurationStore(storage: {
  read(): string | null | undefined | Promise<string | null | undefined>;
  write(bytes: string): void | Promise<void>;
}): EngineConfigurationStore {
  return {
    async read() {
      try {
        const bytes = await storage.read();
        if (bytes == null || bytes === '') return undefined;
        const saved = ownConfigurationData(JSON.parse(bytes)) as {
          schemaVersion?: unknown;
          selection?: unknown;
        };
        if (
          saved?.schemaVersion !== 1 ||
          Object.keys(saved).some((key) => key !== 'schemaVersion' && key !== 'selection')
        )
          throw new Error('unsupported quality preference version or fields');
        validateQualitySelection(saved.selection);
        return saved.selection as QualitySelection;
      } catch (cause) {
        console.warn(
          '[forgeax.configuration]',
          new EngineConfigurationError('configuration-invalid', {
            path: 'configurationHost.store',
            reason: 'saved quality is unavailable; using project defaults',
            cause,
          }),
        );
        return undefined;
      }
    },
    async write(selection) {
      const owned = ownConfigurationData(selection);
      validateQualitySelection(owned);
      await storage.write(JSON.stringify({ schemaVersion: 1, selection: owned }));
    },
  };
}
