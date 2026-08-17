// ---------------------------------------------------------------------------
// Build-time macro fallback for running from source (`bun run dev`).
//
// `bun build --define` replaces MACRO.* expressions at compile time, so this
// module is inert in compiled binaries: the assignments below only run when
// the bare identifier is still undefined (i.e. running the TypeScript source
// directly with Bun). Keep this import FIRST in the CLI entrypoint so every
// later MACRO.* access sees a value.
// ---------------------------------------------------------------------------

const globalAny = globalThis as unknown as Record<string, unknown>

if (typeof globalAny.MACRO === 'undefined') {
  globalAny.MACRO = {
    VERSION: '2.1.87-source',
    BUILD_TIME: new Date().toISOString(),
    PACKAGE_URL: 'claude-code-source-snapshot',
    NATIVE_PACKAGE_URL: undefined,
    FEEDBACK_CHANNEL: 'github',
    ISSUES_EXPLAINER:
      'This reconstructed source snapshot does not include Anthropic internal issue routing.',
    VERSION_CHANGELOG: 'Local development build (running from source)',
  }
}

export {}
