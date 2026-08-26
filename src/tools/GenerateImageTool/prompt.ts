export const GENERATE_IMAGE_TOOL_NAME = 'GenerateImage'

export const DESCRIPTION = `Generate an image with the configured image model and save it under ./images/.

How to write a strong prompt (write it yourself when calling, don't parrot the user's raw words):
- Subject first: what is the main thing, concretely ("a ginger cat", not "cat")
- Composition & camera: shot type, angle, framing ("close-up", "top-down", "rule of thirds")
- Style: photo / watercolor / flat illustration / 像素画 / 3D render / 国风工笔…
- Lighting & mood: golden hour, soft window light, neon rim light, 黄昏逆光
- Detail anchors: colors, materials, background, small props that ground the scene
- Language: bilingual or Chinese is fine on Chinese providers; keep to ~1-3 vivid sentences, no filler

For EDITING an existing image, or when the image must depict real code/data, do not use this tool — say so.

Examples:
- prompt: "golden-hour photo, close-up of a ginger cat curled on a windowsill, soft window light, shallow depth of field, warm tones, pine branch outside the glass"
- prompt: "扁平矢量插画：一只橘猫趴在窗台晒太阳，黄昏暖光，窗外松枝剪影，米白背景，留白构图"`
