import type { CancellationToken } from 'vscode';
import { DiscoveredModelInfo, ModelDiscovery } from './types';

/**
 * Chains multiple {@link ModelDiscovery} probes in sequence.
 * The first discovery provider to return enriched metadata wins.
 */
export class CompositeModelDiscovery implements ModelDiscovery {
  constructor(private readonly discoveries: readonly ModelDiscovery[]) {}

  public reset(): void {
    for (const d of this.discoveries) {
      d.reset();
    }
  }

  public async enrichModel(
    modelId: string,
    token?: CancellationToken
  ): Promise<DiscoveredModelInfo | undefined> {
    for (const d of this.discoveries) {
      const result = await d.enrichModel(modelId, token);
      if (result) {
        return result;
      }
    }
    return undefined;
  }
}
