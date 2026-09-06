import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resetProviderConfigCacheForTests,
  saveProviderConfig,
  type ProviderConfig,
} from './providerRegistry.js'
import {
  clearTierModelOverride,
  resetTierOverridesForTests,
  setTierModelOverride,
} from './tierOverrides.js'
import { resolveTierConnectionByTier } from './tierResolver.js'

const origDir = process.env.CLAUDE_CONFIG_DIR
function pin(json: ProviderConfig, fn: () => void) {
  const dir = mkdtempSync(join(tmpdir(), 'cclite-ov-'))
  writeFileSync(join(dir, 'providers.json'), JSON.stringify(json))
  process.env.CLAUDE_CONFIG_DIR = dir
  resetProviderConfigCacheForTests()
  try { fn() } finally {
    if (origDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = origDir
    resetProviderConfigCacheForTests()
    resetTierOverridesForTests()
  }
}

const CFG: ProviderConfig = {
  version: 2,
  providers: [
    {
      id: 'gw',
      label: 'gw',
      type: 'openai',
      baseURL: 'https://gw.example/v1',
      apiKey: 'k',
      models: ['m1'],
    },
  ],
  tiers: {
    opus: { providerId: 'gw', model: 'm1' },
  },
}

describe('tier model overrides', () => {
  afterEach(resetTierOverridesForTests)

  test('unset → binding model', () => {
    pin(CFG, () => {
      expect(resolveTierConnectionByTier('opus')).toMatchObject({ model: 'm1' })
    })
  })

  test('/model glm-5.3 while on opus → same provider, model glm-5.3', () => {
    pin(CFG, () => {
      setTierModelOverride('opus', 'glm-5.3')
      const c = resolveTierConnectionByTier('opus')
      expect(c.source).toBe('routing')
      if (c.source === 'routing') {
        expect(c.model).toBe('glm-5.3')
        expect(c.baseURL).toBe('https://gw.example/v1')
      }
    })
  })

  test('clear resets', () => {
    pin(CFG, () => {
      setTierModelOverride('opus', 'glm-5.3')
      clearTierModelOverride('opus')
      expect(resolveTierConnectionByTier('opus')).toMatchObject({ model: 'm1' })
    })
  })
})
