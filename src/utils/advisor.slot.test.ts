import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resetProviderConfigCacheForTests,
  resolveAdvisorProvider,
  saveProviderConfig,
  type ProviderConfig,
} from './providers/providerRegistry.js'
import { resolveAdvisorConnection } from './providers/tierResolver.js'
import { getAdvisorModel, getSessionAdvisorModel } from './advisor.js'
import { getAdvisorToolInstructions } from '../tools/AdvisorTool/prompt.js'
import { advisorCheckpointReason } from './attachments.js'

let dir: string
let prevCfg: string | undefined
let prevAdvisorEnv: string | undefined

const CFG: ProviderConfig = {
  version: 2,
  providers: [
    {
      id: 'main',
      label: 'Main',
      type: 'anthropic',
      baseURL: 'https://main.example.com',
      apiKey: 'k-main',
      models: ['m-opus'],
    },
    {
      id: 'review',
      label: 'Review',
      type: 'openai',
      baseURL: 'https://review.example.com/v1',
      apiKey: 'k-review',
      models: ['m-review'],
    },
  ],
  tiers: {
    opus: { providerId: 'main', model: 'm-opus' },
    advisor: { providerId: 'review', model: 'm-review' },
  },
}

beforeEach(() => {
  prevCfg = process.env.CLAUDE_CONFIG_DIR
  prevAdvisorEnv = process.env.CLAUDE_CODE_ADVISOR_MODEL
  delete process.env.CLAUDE_CODE_ADVISOR_MODEL
  dir = mkdtempSync(join(tmpdir(), 'cclite-advisor-slot-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  saveProviderConfig(CFG)
  resetProviderConfigCacheForTests()
})

afterEach(() => {
  if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevCfg
  if (prevAdvisorEnv === undefined) delete process.env.CLAUDE_CODE_ADVISOR_MODEL
  else process.env.CLAUDE_CODE_ADVISOR_MODEL = prevAdvisorEnv
  resetProviderConfigCacheForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('dedicated advisor slot', () => {
  it('resolves the bound provider and model', () => {
    expect(resolveAdvisorProvider()).toMatchObject({
      provider: { id: 'review' },
      model: 'm-review',
    })
  })

  it('wins over the main-loop opus tier', () => {
    expect(getAdvisorModel()).toBe('m-review')
  })

  it('is not dragged along by main-loop failover', () => {
    expect(
      getSessionAdvisorModel({ ccLiteTierHome: 'opus', ccLiteTierCurrent: 'sonnet' }),
    ).toBe('m-review')
  })

  it('still loses to the explicit env override', () => {
    process.env.CLAUDE_CODE_ADVISOR_MODEL = 'env-model'
    expect(getAdvisorModel()).toBe('env-model')
  })

  it('routes querySource=advisor to the slot provider connection', () => {
    const conn = resolveAdvisorConnection()
    expect(conn).not.toBeNull()
    expect(conn).toMatchObject({
      source: 'routing',
      scope: 'advisor',
      type: 'openai',
      baseURL: 'https://review.example.com/v1',
      apiKey: 'k-review',
      model: 'm-review',
    })
  })

  it('returns null when the slot is unbound', () => {
    saveProviderConfig({ ...CFG, tiers: { opus: CFG.tiers.opus } })
    resetProviderConfigCacheForTests()
    expect(resolveAdvisorProvider()).toBeNull()
    expect(resolveAdvisorConnection()).toBeNull()
  })
})

describe('advisor checkpoint', () => {
  it('is appended for proactive modes', () => {
    const text = getAdvisorToolInstructions('default', { checkpoint: true })
    expect(text).toContain('CHECKPOINT')
  })

  it('uses the stuck wording for a stalling attempt', () => {
    const text = getAdvisorToolInstructions('default', {
      checkpoint: true,
      reason: 'stuck',
    })
    expect(text).toContain('stalling')
    expect(text).not.toContain('many tool calls have passed')
  })

  it('never nags when the user drives the advisor manually', () => {
    const text = getAdvisorToolInstructions('atUserDemand', { checkpoint: true })
    expect(text).not.toContain('CHECKPOINT')
  })

  it('leaves the instructions untouched without a checkpoint', () => {
    expect(getAdvisorToolInstructions('default')).toBe(
      getAdvisorToolInstructions('default', { checkpoint: false }),
    )
  })
})

describe('advisor stuck detection', () => {
  const use = (id: string, name = 'Bash', input: unknown = { command: id }) =>
    ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }) as any
  const result = (id: string, isError: boolean) =>
    ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } }) as any

  it('fires on two consecutive tool errors', () => {
    expect(advisorCheckpointReason([use('a'), result('a', true), use('b'), result('b', true)])).toBe('stuck')
  })

  it('stays quiet after a successful call', () => {
    expect(advisorCheckpointReason([use('a'), result('a', true), use('b'), result('b', false)])).toBeNull()
  })

  it('fires when the same call repeats three times', () => {
    const same = { command: 'npm test' }
    expect(advisorCheckpointReason([use('1', 'Bash', same), use('2', 'Bash', same), use('3', 'Bash', same)])).toBe('stuck')
  })

  it('falls back to the long-run checkpoint past 30 calls', () => {
    const msgs: any[] = []
    for (let i = 0; i < 31; i++) msgs.push(use(`c${i}`, 'Read', { file: `f${i}` }))
    expect(advisorCheckpointReason(msgs)).toBe('long')
  })

  it('fires when the same error text repeats', () => {
    const msg = (id: string, text: string) =>
      ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] } }) as any
    expect(
      advisorCheckpointReason([
        use('a', 'Bash', { command: 'a' }),
        msg('a', 'TS2307: Cannot find module x at line 42'),
        use('b', 'Bash', { command: 'b' }),
        msg('b', 'TS2307: Cannot find module x at line 87'),
      ]),
    ).toBe('stuck')
  })

  it('fires on near-identical repeated edits', () => {
    const edit = (id: string) =>
      ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: 'a.ts', old_string: 'const a = 1\nconst b = 2\n', new_string: 'const a = 10\nconst b = 20\n' } }] } }) as any
    expect(advisorCheckpointReason([edit('e1'), edit('e2'), edit('e3')])).toBe('stuck')
  })

  it('fires on output-token burn', () => {
    const heavy = (id: string) =>
      ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file: id } }], usage: { output_tokens: 40_000 } } }) as any
    expect(advisorCheckpointReason([heavy('r1'), heavy('r2')])).toBe('long')
  })

  it('adapts the long-run threshold to the observed consult gap', () => {
    const msgs: any[] = []
    for (let i = 0; i < 10; i++) msgs.push(use(`a${i}`, 'Read', { file: `a${i}` }))
    msgs.push(use('adv1', 'Advisor', { question: 'q1' }))
    for (let i = 0; i < 10; i++) msgs.push(use(`c${i}`, 'Read', { file: `c${i}` }))
    msgs.push(use('adv2', 'Advisor', { question: 'q2' }))
    for (let i = 0; i < 21; i++) msgs.push(use(`b${i}`, 'Read', { file: `b${i}` }))
    expect(advisorCheckpointReason(msgs)).toBe('long')
  })

  it('resets after an Advisor consult', () => {
    const msgs: any[] = []
    for (let i = 0; i < 31; i++) msgs.push(use(`c${i}`, 'Read', { file: `f${i}` }))
    msgs.push(use('a', 'Advisor', { question: 'q' }))
    expect(advisorCheckpointReason(msgs)).toBeNull()
  })
})
