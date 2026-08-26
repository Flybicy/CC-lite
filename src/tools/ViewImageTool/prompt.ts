export const VIEW_IMAGE_TOOL_NAME = 'ViewImage'

export const DESCRIPTION = `Read and understand a local image file by asking the configured vision model to describe it.

Use this when the main model cannot see images directly (text-only provider) and the conversation involves an image: screenshots, UI mockups, diagrams, photos, error dialogs.

NOT needed when your provider already accepts image input. Returns the vision model's textual description, which you should then reason over yourself.`
