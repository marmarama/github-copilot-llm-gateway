import type { CancellationToken } from 'vscode';
import { DiscoveredModelInfo, ModelDiscovery, REQUEST_SAMPLER_KEYS } from './types';

/**
 * llama.cpp / llama-server / CachyLlama model discovery via the native `GET /props` endpoint.
 * Discovers context window sizes, server-side sampler defaults, and backend properties.
 *
 * All llama-server discovery logic lives in this module; downstream consumes
 * the backend-neutral {@link DiscoveredModelInfo}.
 */

export interface LlamaServerModelInfo {
  /** Runtime context window from props default_generation_settings.n_ctx */
  readonly nCtx?: number;
  /** Numeric sampler params from default_generation_settings */
  readonly params: Readonly<Record<string, number>>;
  /** Compute backend (vulkan, cuda, metal, cpu) if reported */
  readonly backend?: string;
  /** GPU / device name if reported */
  readonly deviceName?: string;
  /** Tools capability */
  readonly toolsSupported?: boolean;
}

/**
 * Parse llama-server `GET /props` response into {@link LlamaServerModelInfo}.
 */
export function parseLlamaServerProps(raw: unknown): LlamaServerModelInfo | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const isLlamaServer = 'default_generation_settings' in obj || 'total_slots' in obj;
  if (!isLlamaServer) {
    return undefined;
  }

  const settings =
    obj.default_generation_settings && typeof obj.default_generation_settings === 'object'
      ? (obj.default_generation_settings as Record<string, unknown>)
      : {};

  const params: Record<string, number> = {};
  for (const key of REQUEST_SAMPLER_KEYS) {
    const val = settings[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      params[key] = val;
    }
  }

  const nCtx =
    typeof settings.n_ctx === 'number' && Number.isFinite(settings.n_ctx) && settings.n_ctx > 0
      ? settings.n_ctx
      : undefined;
  const backend = typeof obj.backend === 'string' ? obj.backend : undefined;
  const deviceName = typeof obj.device_name === 'string' ? obj.device_name : undefined;

  return {
    nCtx,
    params,
    backend,
    deviceName,
    toolsSupported: true,
  };
}

/** Map parsed llama-server metadata onto the backend-neutral discovery shape. */
export function toDiscoveredModelInfoFromLlama(info: LlamaServerModelInfo): DiscoveredModelInfo {
  return {
    contextLength: info.nCtx,
    contextSource: info.nCtx !== undefined ? 'llama-server /props' : undefined,
    samplerParams: info.params,
    toolsSupported: info.toolsSupported ?? true,
    visionSupported: undefined,
  };
}

/** The subset of the gateway client the llama-server discovery probe needs. */
export interface LlamaServerDiscoveryClient {
  /** `GET /props` probe — true only when the server answers like llama-server. */
  probeLlamaServer(token?: CancellationToken): Promise<boolean>;
  /** `GET /props` raw JSON body, or `undefined` on any failure. */
  getLlamaProps(token?: CancellationToken): Promise<unknown>;
}

export interface LlamaServerDiscoveryDeps {
  client: LlamaServerDiscoveryClient;
  log: (message: string) => void;
}

/**
 * {@link ModelDiscovery} implementation for llama-server / CachyLlama.
 * Detection is a single short-timeout `GET /props` probe, cached (single-flight)
 * until `reset()`.
 */
export class LlamaServerDiscovery implements ModelDiscovery {
  private detection?: Promise<boolean>;
  private cachedProps?: DiscoveredModelInfo;

  constructor(private readonly deps: LlamaServerDiscoveryDeps) {}

  public reset(): void {
    this.detection = undefined;
    this.cachedProps = undefined;
  }

  public async enrichModel(
    _modelId: string,
    token?: CancellationToken
  ): Promise<DiscoveredModelInfo | undefined> {
    if (!(await this.isLlamaServer(token))) {
      return undefined;
    }
    if (this.cachedProps) {
      return this.cachedProps;
    }
    const raw = await this.deps.client.getLlamaProps(token);
    const parsed = parseLlamaServerProps(raw);
    const info = parsed ? toDiscoveredModelInfoFromLlama(parsed) : undefined;
    if (!token?.isCancellationRequested) {
      this.cachedProps = info;
    }
    return info;
  }

  private isLlamaServer(token?: CancellationToken): Promise<boolean> {
    if (!this.detection) {
      const probe = this.deps.client
        .probeLlamaServer(token)
        .catch(() => false)
        .then((detected) => {
          if (!detected && token?.isCancellationRequested) {
            if (this.detection === probe) {
              this.detection = undefined;
            }
            return false;
          }
          this.deps.log(
            detected
              ? 'llama-server detected (/props); enabling native model discovery'
              : 'Server is not llama-server (/props probe failed); skipping llama discovery'
          );
          return detected;
        });
      this.detection = probe;
    }
    return this.detection;
  }
}
