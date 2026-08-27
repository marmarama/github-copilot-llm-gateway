import type { CancellationToken } from 'vscode';

/**
 * Information about a discovered local inference server.
 */
export interface DiscoveredEndpoint {
  readonly url: string;
  readonly type: 'llama-server' | 'ollama' | 'openai-compatible';
  readonly label: string;
  readonly details?: string;
}

/**
 * Standard local ports to probe in order of priority:
 * 1. 9931 — Upstream llama-server router mode standard port
 * 2. 8080 — Alpaca & current llama-server default port
 * 3. 11434 — Ollama default port
 * 4. 8000 — vLLM / LocalAI default port
 */
export const KNOWN_LOCAL_ENDPOINTS = [
  { url: 'http://127.0.0.1:9931', name: 'llama-server (Router :9931)' },
  { url: 'http://127.0.0.1:8080', name: 'Alpaca / llama-server (:8080)' },
  { url: 'http://127.0.0.1:11434', name: 'Ollama (:11434)' },
  { url: 'http://127.0.0.1:8000', name: 'vLLM / LocalAI (:8000)' },
] as const;

/**
 * Probe a single URL with a fast timeout to detect running backend types.
 */
export async function probeEndpoint(
  url: string,
  token?: CancellationToken
): Promise<DiscoveredEndpoint | undefined> {
  const timeoutMs = 400;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  if (token) {
    token.onCancellationRequested(() => controller.abort());
  }

  try {
    // Probe 1: Check llama-server /props
    try {
      const propsRes = await fetch(`${url}/props`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (propsRes.ok) {
        const body = (await propsRes.json()) as Record<string, unknown>;
        if (
          body &&
          typeof body === 'object' &&
          ('default_generation_settings' in body || 'total_slots' in body)
        ) {
          clearTimeout(timeoutId);
          const backend = typeof body.backend === 'string' ? ` (${body.backend})` : '';
          return {
            url,
            type: 'llama-server',
            label: `llama-server${backend}`,
            details: `${url}`,
          };
        }
      }
    } catch {
      // Not llama-server /props
    }

    // Probe 2: Check Ollama /api/version
    try {
      const ollamaRes = await fetch(`${url}/api/version`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (ollamaRes.ok) {
        const body = (await ollamaRes.json()) as { version?: unknown };
        if (body && typeof body.version === 'string') {
          clearTimeout(timeoutId);
          return {
            url,
            type: 'ollama',
            label: `Ollama v${body.version}`,
            details: `${url}`,
          };
        }
      }
    } catch {
      // Not Ollama /api/version
    }

    // Probe 3: Check generic /v1/models
    try {
      const modelsRes = await fetch(`${url}/v1/models`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (modelsRes.ok) {
        const body = (await modelsRes.json()) as { data?: unknown };
        if (body && Array.isArray(body.data)) {
          clearTimeout(timeoutId);
          return {
            url,
            type: 'openai-compatible',
            label: 'OpenAI-Compatible Server',
            details: `${url}`,
          };
        }
      }
    } catch {
      // Not responding to /v1/models
    }

    clearTimeout(timeoutId);
    return undefined;
  } catch {
    clearTimeout(timeoutId);
    return undefined;
  }
}

/**
 * Concurrently probe all known local endpoints and return any active servers found.
 */
export async function probeAllLocalEndpoints(
  token?: CancellationToken
): Promise<DiscoveredEndpoint[]> {
  const probes = KNOWN_LOCAL_ENDPOINTS.map(async (candidate) => {
    return await probeEndpoint(candidate.url, token);
  });
  const results = await Promise.all(probes);
  return results.filter((r): r is DiscoveredEndpoint => r !== undefined);
}
