import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_LOCAL_ENDPOINTS,
  probeEndpoint,
  probeAllLocalEndpoints,
} from '../endpointDiscovery';

describe('endpointDiscovery', () => {
  test('KNOWN_LOCAL_ENDPOINTS contains 9931 (llama router), 8080 (alpaca), 11434 (ollama), and 8000 (vllm)', () => {
    const urls = KNOWN_LOCAL_ENDPOINTS.map((e) => e.url);
    assert.ok(urls.includes('http://127.0.0.1:9931'));
    assert.ok(urls.includes('http://127.0.0.1:8080'));
    assert.ok(urls.includes('http://127.0.0.1:11434'));
    assert.ok(urls.includes('http://127.0.0.1:8000'));
  });

  test('probeEndpoint returns undefined when server does not exist', async () => {
    // Port 59999 is unlikely to have an HTTP server running
    const result = await probeEndpoint('http://127.0.0.1:59999');
    assert.equal(result, undefined);
  });

  test('probeAllLocalEndpoints handles unreachable endpoints without throwing', async () => {
    const result = await probeAllLocalEndpoints();
    assert.ok(Array.isArray(result));
  });
});
