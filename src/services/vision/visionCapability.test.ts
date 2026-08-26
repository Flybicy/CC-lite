import { describe, expect, test } from 'bun:test'
import {
  mainModelAlreadySees,
  modelNameSuggestsVision,
} from './visionCapability.js'

describe('modelNameSuggestsVision', () => {
  test('known multimodal families pass', () => {
    for (const m of ['gpt-4o', 'gpt-4.1', 'gemini-2.5-pro', 'claude-opus-5', 'qwen-vl-max', 'glm-4v']) {
      expect(modelNameSuggestsVision(m)).toBe(true)
    }
  })
  test('text-only models fail', () => {
    for (const m of ['deepseek-chat', 'sensenova-u1.5-lite', 'kimi-k2', 'gpt-3.5-turbo']) {
      expect(modelNameSuggestsVision(m)).toBe(false)
    }
  })
})
