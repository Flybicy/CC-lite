// ---------------------------------------------------------------------------
// Image generation service — CC-lite
//
// Talks to any OpenAI-compatible images endpoint
// (POST {baseURL}/images/generations) — tested against SenseNova
// (token.sensenova.cn) which returns b64_json PNGs. The provider + model are
// bound in providers.json under tiers.image; configure via the WebUI
// (`cclite web` → 作图模型) or /image setup hint.
// ---------------------------------------------------------------------------

import { APIError } from '@anthropic-ai/sdk'
import { resolveImageProvider } from '../../utils/providers/providerRegistry.js'

export interface GeneratedImage {
  /** Raw decoded image bytes (PNG unless the provider says otherwise). */
  bytes: Buffer
  mime: string
}

/**
 * Generate one image from a text prompt. Throws APIError on non-2xx so the
 * caller's retry/error formatting matches the chat path.
 */
export async function generateImage(
  prompt: string,
  opts?: { size?: string; signal?: AbortSignal },
): Promise<GeneratedImage> {
  const binding = resolveImageProvider()
  if (!binding) {
    throw new Error(
      '还没有配置作图模型。打开 WebUI（cclite web）在“作图模型”一栏选择提供商和模型，或在 providers.json 的 tiers.image 里绑定。',
    )
  }
  const { provider, model } = binding
  const url = provider.baseURL.replace(/\/$/, '') + '/images/generations'
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(provider.headers ?? {}),
  }
  if (provider.apiKey) headers['authorization'] = 'Bearer ' + provider.apiKey

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      prompt,
      ...(opts?.size ? { size: opts.size } : {}),
      response_format: 'b64_json',
    }),
    signal: opts?.signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown error')
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = undefined
    }
    throw new APIError(
      response.status,
      parsed as object | undefined,
      'Image API error ' + response.status + ': ' + body,
      new Headers(),
    )
  }

  const payload = (await response.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>
  }
  const first = payload.data?.[0]
  if (first?.b64_json) {
    return { bytes: Buffer.from(first.b64_json, 'base64'), mime: 'image/png' }
  }
  if (first?.url) {
    const img = await fetch(first.url, { signal: opts?.signal })
    if (!img.ok) throw new Error('下载生成图片失败: HTTP ' + img.status)
    return {
      bytes: Buffer.from(await img.arrayBuffer()),
      mime: img.headers.get('content-type') ?? 'image/png',
    }
  }
  throw new Error('提供商返回里没有可用的图片数据（既无 b64_json 也无 url）')
}
