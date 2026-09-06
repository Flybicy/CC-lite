import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resetProviderConfigCacheForTests,
  saveProviderConfig,
} from './providers/providerRegistry.js'
import { getSessionAdvisorModel } from './advisor.js'

let dir: string
let prevCfg: string | undefined

beforeEach(() => {
  prevCfg = process.env.CLAUDE_CONFIG_DIR
  dir = mkdtempSync(join(tmpdir(), 'cclite-advisor-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  saveProviderConfig({
    version: 2,
    providers: [
      { id: "p", label: "P", type: "anthropic", baseURL: "https://p.example.com", apiKey: "", models: [] },
      { id: "q", label: "Q", type: "anthropic", baseURL: "https://q.example.com", apiKey: "", models: [] },
    ],
    tiers: {
      opus: { providerId: "p", model: "m-opus" },
      sonnet: { providerId: "q", model: "m-sonnet" },
    },
  })
  resetProviderConfigCacheForTests()
})

afterEach(() => {
  if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevCfg
  resetProviderConfigCacheForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('getSessionAdvisorModel', () => {
  it('manual switch (chain rebased: home === current, not sticky) keeps opus', () => {
    expect(
      getSessionAdvisorModel({ ccLiteTierHome: 'sonnet', ccLiteTierCurrent: 'sonnet' }),
    ).toBe('opus')
  })

  it('transient failover (current !== home) follows the degraded tier', () => {
    expect(
      getSessionAdvisorModel({ ccLiteTierHome: 'opus', ccLiteTierCurrent: 'sonnet' }),
    ).toBe('sonnet')
  })

  it('sticky balance downgrade follows the tier the main loop is on', () => {
    expect(
      getSessionAdvisorModel({
        ccLiteTierHome: 'sonnet',
        ccLiteTierCurrent: 'sonnet',
        ccLiteTierSticky: true,
      }),
    ).toBe('sonnet')
  })

  it('no session info falls back to the default (opus)', () => {
    expect(getSessionAdvisorModel(undefined)).toBe('opus')
    expect(getSessionAdvisorModel({})).toBe('opus')
  })
})
