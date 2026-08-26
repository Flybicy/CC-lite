// ---------------------------------------------------------------------------
// Vision fallback service — CC-lite
//
// Gives text-only main-loop models "eyes": ViewImage reads a local image and
// asks the vision provider (providers.json tiers.vision) to describe it.
// Supports both Anthropic-compatible and OpenAI-compatible providers.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { APIError } from '@anthropic-ai/sdk'
import { resolveVisionProvider } from '../../utils/providers/providerRegistry.js'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/png',
}

const DEFAULT_QUESTION =
  '请详细描述这张图片的内容：主体、布局、文字、颜色、值得注意的细节。如果包含 UI 截图或图表，请提取关键信息。'

/**
 * Describe a local image with the configured vision provider.
 * Throws a plain Error (Chinese, user-facing) when unconfigured.
 */
export async function describeImage(
  imagePath: string,
  question?: string,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const binding = resolveVisionProvider()
  if (!binding) {
    throw new Error(
      '没有配置视觉模型。打开 WebUI（cclite web）在“视觉模型”一栏绑定提供商和模型，即可给纯文本主模型加上“眼睛”。',
    )
  }
  const { provider, model } = binding
  const data = readFileSync(imagePath)
  const mime = MIME_BY_EXT[extname(imagePath).toLowerCase()] ?? 'image/png'
  const b64 = data.toString('base64')
  const prompt = question?.trim() || DEFAULT_QUESTION

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(provider.headers ?? {}),
  }

  let response: Response
  if (provider.type === 'anthropic') {
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey
    headers['anthropic-version'] = '2023-06-01'
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
    response = await fetch(provider.baseURL.replace(/\/$/, '') + '/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
      signal: opts?.signal,
    })
  } else {
    if (provider.apiKey) headers['authorization'] = 'Bearer ' + provider.apiKey
    response = await fetch(
      provider.baseURL.replace(/\/$/, '') + '/chat/completions',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
                { type: 'text', text: prompt },
              ],
            },
          ],
        }),
        signal: opts?.signal,
      },
    )
  }

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown error')
    throw new APIError(
      response.status,
      undefined,
      `Vision API error ${response.status}: ${body}`,
      new Headers(),
    )
  }

  const payload = (await response.json()) as Record<string, unknown>
  if (provider.type === 'anthropic') {
    const content = payload.content as Array<{ type: string; text?: string }> | undefined
    const text = content?.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
    if (text) return text
  } else {
    const choices = payload.choices as Array<{ message?: { content?: unknown } }> | undefined
    const c = choices?.[0]?.message?.content
    if (typeof c === 'string' && c.trim()) return c
    if (Array.isArray(c)) {
      const text = c
        .map(p => (p && typeof p === 'object' ? (p as { text?: string }).text ?? '' : ''))
        .join('\n')
      if (text.trim()) return text
    }
  }
  throw new Error('视觉模型返回为空或不识别的格式')
}
