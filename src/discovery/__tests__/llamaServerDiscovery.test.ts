import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LlamaServerDiscovery,
  LlamaServerDiscoveryClient,
  parseLlamaServerProps,
  toDiscoveredModelInfoFromLlama,
} from '../llamaServerDiscovery';
import { CompositeModelDiscovery } from '../compositeDiscovery';
import { DiscoveredModelInfo, ModelDiscovery } from '../types';

describe('parseLlamaServerProps', () => {
  test('parses context length, samplers, backend, and device from /props', () => {
    const info = parseLlamaServerProps({
      default_generation_settings: {
        n_ctx: 131072,
        n_predict: -1,
        top_k: 40,
        top_p: 0.95,
        min_p: 0.05,
        temperature: 0.8,
        repeat_penalty: 1.1,
      },
      total_slots: 4,
      backend: 'vulkan',
      device_name: 'AMD Radeon Graphics',
    });
    assert.ok(info);
    assert.equal(info.nCtx, 131072);
    assert.equal(info.params.top_p, 0.95);
    assert.equal(info.params.top_k, 40);
    assert.equal(info.params.min_p, 0.05);
    assert.equal(info.params.repeat_penalty, 1.1);
    assert.equal(info.backend, 'vulkan');
    assert.equal(info.deviceName, 'AMD Radeon Graphics');
    assert.equal(info.toolsSupported, true);
  });

  test('handles missing or non-numeric default_generation_settings gracefully', () => {
    const info = parseLlamaServerProps({
      total_slots: 1,
    });
    assert.ok(info);
    assert.equal(info.nCtx, undefined);
    assert.deepEqual(info.params, {});
    assert.equal(info.toolsSupported, true);
  });

  test('returns undefined for non-llama-server response', () => {
    assert.equal(parseLlamaServerProps({ id: 'gpt-4' }), undefined);
    assert.equal(parseLlamaServerProps(null), undefined);
    assert.equal(parseLlamaServerProps('invalid'), undefined);
  });
});

describe('toDiscoveredModelInfoFromLlama', () => {
  test('maps parsed llama metadata onto DiscoveredModelInfo shape', () => {
    const discovered = toDiscoveredModelInfoFromLlama({
      nCtx: 131072,
      params: { top_p: 0.95, min_p: 0.05 },
      backend: 'vulkan',
      toolsSupported: true,
    });
    assert.equal(discovered.contextLength, 131072);
    assert.equal(discovered.contextSource, 'llama-server /props');
    assert.equal(discovered.toolsSupported, true);
    assert.equal(discovered.samplerParams.top_p, 0.95);
    assert.equal(discovered.samplerParams.min_p, 0.05);
  });
});

describe('LlamaServerDiscovery', () => {
  test('detects llama-server, fetches props, and caches result', async () => {
    let probeCalls = 0;
    let propsCalls = 0;
    const client: LlamaServerDiscoveryClient = {
      probeLlamaServer: async () => {
        probeCalls++;
        return true;
      },
      getLlamaProps: async () => {
        propsCalls++;
        return {
          default_generation_settings: { n_ctx: 65536, top_p: 0.9 },
          total_slots: 2,
        };
      },
    };

    const discovery = new LlamaServerDiscovery({ client, log: () => undefined });
    const info1 = await discovery.enrichModel('model-1');
    assert.ok(info1);
    assert.equal(info1.contextLength, 65536);
    assert.equal(info1.samplerParams.top_p, 0.9);
    assert.equal(probeCalls, 1);
    assert.equal(propsCalls, 1);

    // Second call should use cached props
    const info2 = await discovery.enrichModel('model-2');
    assert.ok(info2);
    assert.equal(info2.contextLength, 65536);
    assert.equal(probeCalls, 1);
    assert.equal(propsCalls, 1);

    // Reset clears cache
    discovery.reset();
    await discovery.enrichModel('model-1');
    assert.equal(probeCalls, 2);
    assert.equal(propsCalls, 2);
  });

  test('returns undefined when server is not llama-server', async () => {
    let propsCalls = 0;
    const client: LlamaServerDiscoveryClient = {
      probeLlamaServer: async () => false,
      getLlamaProps: async () => {
        propsCalls++;
        return {};
      },
    };

    const discovery = new LlamaServerDiscovery({ client, log: () => undefined });
    const info = await discovery.enrichModel('model-1');
    assert.equal(info, undefined);
    assert.equal(propsCalls, 0);
  });
});

describe('CompositeModelDiscovery', () => {
  test('delegates to first discovery provider that returns metadata', async () => {
    const expectedInfo: DiscoveredModelInfo = {
      contextLength: 32768,
      samplerParams: { top_p: 0.9 },
    };

    const discovery1: ModelDiscovery = {
      reset: () => undefined,
      enrichModel: async () => undefined,
    };
    const discovery2: ModelDiscovery = {
      reset: () => undefined,
      enrichModel: async () => expectedInfo,
    };

    const composite = new CompositeModelDiscovery([discovery1, discovery2]);
    const result = await composite.enrichModel('any-model');
    assert.deepEqual(result, expectedInfo);
  });

  test('calls reset on all child discoveries', () => {
    let reset1 = false;
    let reset2 = false;
    const discovery1: ModelDiscovery = {
      reset: () => { reset1 = true; },
      enrichModel: async () => undefined,
    };
    const discovery2: ModelDiscovery = {
      reset: () => { reset2 = true; },
      enrichModel: async () => undefined,
    };

    const composite = new CompositeModelDiscovery([discovery1, discovery2]);
    composite.reset();
    assert.equal(reset1, true);
    assert.equal(reset2, true);
  });
});
