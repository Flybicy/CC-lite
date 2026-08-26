import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  tierUsesVisionAssist,
  tiersUsingVisionAssist,
  visionAssistIsActive,
} from './visionCapability.js'
import {
  resetProviderConfigCacheForTests,
} from '../../utils/providers/providerRegistry.js'

const origConfigDir = process.env.CLAUDE_CONFIG_DIR

function withProviders(json: unknown, fn: () => void) {
  const dir = mkdtempSync(join(tmpdir(), 'cclite-vision-'))
  writeFileSync(join(dir, 'providers.json'), JSON.stringify(json))
  process.env.CLAUDE_CONFIG_DIR = dir
  resetProviderConfigCacheForTests()
  try {
    fn()
  } finally {
    if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = origConfigDir
    resetProviderConfigCacheForTests()
  }
}

const PROVIDER = { id: 'v1', label: 'vis', type: 'openai', baseURL: 'https://x', apiKey: 'k', models: [] }

describe('tier-based vision routing', () => {
  afterEach(() => resetProviderConfigCacheForTests())

  test('no bindings → vision assist inactive', () => {
    withProviders({ providers: [PROVIDER], tiers: {} }, () => {
      expect(visionAssistIsActive()).toBe(false)
      expect(tiersUsingVisionAssist()).toEqual([])
    })
  })

  test('vision bound but no tier set to assist → still inactive', () => {
    withProviders(
      { providers: [PROVIDER], tiers: { vision: { providerId: 'v1', model: 'gpt-4o' } } },
      () => expect(visionAssistIsActive()).toBe(false),
    )
  })

  test('tier set to assist + vision bound → active, per-tier lookup', () => {
    withProviders(
      {
        providers: [PROVIDER],
        tiers: {
          vision: { providerId: 'v1', model: 'gpt-4o' },
          se: { providerId: 'v1', model: 'deepseek', images: 'assist' },
        },
      },
      () => {
        expect(visionAssistIsActive()).toBe(true)
        expect(tierUsesVisionAssist('se')).toBe(true)
        expect(tierUsesVisionAssist('pro')).toBe(false)
      },
    )
  })
})
