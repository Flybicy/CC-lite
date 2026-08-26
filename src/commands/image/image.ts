import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { LocalCommandCall } from '../../types/command.js'
import { generateImage } from '../../services/images/imageGen.js'

export const call: LocalCommandCall = async (args, _context) => {
  const prompt = args.trim()
  if (!prompt) {
    return {
      type: 'text',
      value: '用法: /image <描述> — 例: /image 一只在窗台上晒太阳的橘猫。在 WebUI（cclite web）配置作图模型。',
    }
  }
  try {
    const img = await generateImage(prompt)
    const dir = resolve('images')
    mkdirSync(dir, { recursive: true })
    const ext = img.mime.includes('png') ? 'png' : img.mime.includes('webp') ? 'webp' : 'jpg'
    const name = `image-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`
    const file = join(dir, name)
    writeFileSync(file, img.bytes)
    return {
      type: 'text',
      value: `已生成: ${file}（${(img.bytes.length / 1024).toFixed(0)} KB）`,
    }
  } catch (err) {
    return {
      type: 'text',
      value: '作图失败: ' + (err instanceof Error ? err.message : String(err)),
    }
  }
}
