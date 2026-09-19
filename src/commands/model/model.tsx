import chalk from 'chalk'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics-stub.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall, LocalJSXCommandContext } from '../../types/command.js'
import type { EffortLevel } from '../../utils/effort.js'
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js'
import {
  clearFastModeCooldown,
  isFastModeAvailable,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from '../../utils/fastMode.js'
import { resolveModelProfileModel } from '../../utils/model/modelProfiles.js'
import { MODEL_ALIASES, isTierAlias } from '../../utils/model/aliases.js'
import {
  clearTierModelOverride,
  setTierModelOverride,
} from '../../utils/providers/tierOverrides.js'
import {
  checkOpus1mAccess,
  checkSonnet1mAccess,
} from '../../utils/model/check1mAccess.js'
import {
  getDefaultMainLoopModelSetting,
  isOpus1mMergeEnabled,
  renderDefaultModelSetting,
} from '../../utils/model/model.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { validateModel } from '../../utils/model/validateModel.js'
import { ModelPicker } from '../../components/ModelPicker.js'

function SetModelAndClose({
  args,
  context,
  onDone,
}: {
  args: string
  context: LocalJSXCommandContext
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}): React.ReactNode {
  const isFastMode = useAppState(s => s.fastMode)
  const setAppState = useSetAppState()
  const activeMainLoop = useAppState(s => s.mainLoopModel)
  const activeSessionModel = useAppState(s => s.mainLoopModelForSession)
  const model = args === 'default' ? null : args

  React.useEffect(() => {
    async function handleModelChange(): Promise<void> {
      if (model && !isModelAllowed(model)) {
        onDone(`Model '${model}' is not available. Your organization restricts model selection.`, {
          display: 'system',
        })
        return
      }

      if (model && isOpus1mUnavailable(model)) {
        onDone(
          `Opus 4.6 with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m`,
          { display: 'system' },
        )
        return
      }

      if (model && isSonnet1mUnavailable(model)) {
        onDone(
          `Sonnet 4.6 with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m`,
          { display: 'system' },
        )
        return
      }

      if (!model) {
        setModel(null)
        return
      }

      if (isKnownAlias(model)) {
        // Bare tier codename resets any pinned session override on it —
        // otherwise an old '/model glm-5.3' would still shadow the tier.
        if (isTierAlias(model)) clearTierModelOverride(model)
        setModel(model)
        return
      }

      // Concrete id while the session is running on a tier codename:
      // interpret it as 'same provider, different model' (a session-level
      // override on the active tier) instead of an env fallback. E.g. with
      // pro active, '/model glm-5.3' means 'pro 档供应商下用 glm-5.3'.
      const activeTierCandidate = (activeSessionModel ?? activeMainLoop) ?? ''
      if (
        !isKnownAlias(model) &&
        typeof activeTierCandidate === 'string' &&
        isTierAlias(activeTierCandidate)
      ) {
        // Apply immediately — a live API probe here takes seconds on a slow
        // provider. Validate in the background; on failure, roll back the
        // override and surface a notification.
        setTierModelOverride(activeTierCandidate, model)
        onDone(
          `已把 ${activeTierCandidate} 档的模型换成 ${model}（本会话）· 供应商不变`,
          { display: 'system' },
        )
        void validateModel(model).then(({ valid, error }) => {
          if (valid) return
          clearTierModelOverride(activeTierCandidate)
          context?.addNotification?.({
            key: 'model-override-invalid',
            text: `${model} 校验失败已回退：${error ?? '模型不可用'}`,
            color: 'error',
            priority: 'immediate',
          })
        })
        return
      }
      try {
        const { valid, error } = await validateModel(model)
        if (valid) {
          setModel(model)
        } else {
          onDone(error || `Model '${model}' not found`, { display: 'system' })
        }
      } catch (error) {
        onDone(`Failed to validate model: ${(error as Error).message}`, { display: 'system' })
      }
    }

    function setModel(modelValue: string | null): void {
      setAppState(prev => ({
        ...prev,
        mainLoopModel: modelValue,
        mainLoopModelForSession: null,
      }))
      let message = `Set model to ${chalk.bold(renderModelLabel(modelValue))}`

      let wasFastModeToggledOn = undefined
      if (isFastModeEnabled()) {
        clearFastModeCooldown()
        if (!isFastModeSupportedByModel(modelValue) && isFastMode) {
          setAppState(prev => ({ ...prev, fastMode: false }))
          wasFastModeToggledOn = false
        } else if (isFastModeSupportedByModel(modelValue) && isFastMode) {
          message += ` · Fast mode ON`
          wasFastModeToggledOn = true
        }
      }

      if (isBilledAsExtraUsage(modelValue, wasFastModeToggledOn === true, isOpus1mMergeEnabled())) {
        message += ` · Billed as extra usage`
      }
      if (wasFastModeToggledOn === false) {
        message += ` · Fast mode OFF`
      }
      onDone(message)
    }

    void handleModelChange()
  }, [model, onDone, setAppState])

  return null
}

function isKnownAlias(model: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(model.toLowerCase().trim())
}

function isOpus1mUnavailable(model: string): boolean {
  const m = model.toLowerCase()
  return !checkOpus1mAccess() && !isOpus1mMergeEnabled() && m.includes('opus') && m.includes('[1m]')
}

function isSonnet1mUnavailable(model: string): boolean {
  const m = model.toLowerCase()
  return !checkSonnet1mAccess() && (m.includes('sonnet[1m]') || m.includes('sonnet-4-6[1m]'))
}

function InteractiveModelPicker({
  onDone,
}: {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}): React.ReactNode {
  const setAppState = useSetAppState()
  const mainLoopModel_ = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)

  function handleSelect(model: string | null, _effort: EffortLevel | undefined) {
    setAppState(prev => ({
      ...prev,
      mainLoopModel: model,
      mainLoopModelForSession: null,
    }))
    onDone(`Set model to ${chalk.bold(renderModelLabel(model))}`, {
      display: 'system',
    })
  }

  function handleCancel() {
    onDone(undefined, { display: 'skip' })
  }

  return (
    <ModelPicker
      initial={mainLoopModel_}
      sessionModel={mainLoopModelForSession ?? undefined}
      onSelect={handleSelect}
      onCancel={handleCancel}
      isStandaloneCommand
    />
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  args = args?.trim() || ''

  if (COMMON_HELP_ARGS.includes(args)) {
    onDone('Run /model to view all model profiles, or /model [name] to switch the main model.', {
      display: 'system',
    })
    return
  }

  if (args && !COMMON_INFO_ARGS.includes(args)) {
    logEvent('tengu_model_command_inline', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return <SetModelAndClose args={args} context={_context} onDone={onDone} />
  }

  return <InteractiveModelPicker onDone={onDone} />
}

function renderModelLabel(model: string | null): string {
  const effective =
    model ??
    (process.env.ANTHROPIC_MODEL ||
      process.env.OPENAI_MODEL ||
      resolveModelProfileModel('main')) ??
    getDefaultMainLoopModelSetting()
  const rendered = renderDefaultModelSetting(effective)
  return model === null ? `${rendered} (default)` : rendered
}
