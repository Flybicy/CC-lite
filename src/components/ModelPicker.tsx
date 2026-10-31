import capitalize from 'lodash-es/capitalize.js'
import * as React from 'react'
import { useState } from 'react'
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics-stub.js'
import {
  FAST_MODE_MODEL_DISPLAY,
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
} from 'src/utils/fastMode.js'
import { Box, Text, useInput } from '../ink.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import {
  convertEffortValueToLevel,
  type EffortLevel,
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  resolvePickerEffortPersistence,
  toPersistableEffort,
} from '../utils/effort.js'
import {
  getDefaultMainLoopModel,
  type ModelSetting,
  modelDisplayString,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import { getModelOptions } from '../utils/model/modelOptions.js'
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Pane } from './design-system/Pane.js'
import { effortLevelToSymbol } from './EffortIndicator.js'

export type Props = {
  initial: string | null
  sessionModel?: ModelSetting
  onSelect: (model: string | null, effort: EffortLevel | undefined) => void
  onCancel?: () => void
  isStandaloneCommand?: boolean
  showFastModeNotice?: boolean
  /** Overrides the dim header line below "Select model". */
  headerText?: string
  /**
   * When true, skip writing effortLevel to userSettings on selection.
   * Used by the assistant installer wizard where the model choice is
   * project-scoped (written to the assistant's .claude/settings.json via
   * install.ts) and should not leak to the user's global ~/.claude/settings.
   */
  skipSettingsWrite?: boolean
}

const NO_PREFERENCE = '__NO_PREFERENCE__'

/**
 * Model picker with fully local keyboard handling.
 *
 * Keys:
 *   ↑ / ↓  (k / j, ctrl+p / ctrl+n)  move the cursor
 *   ← / →  (h / l)                   lower / raise thinking effort
 *   1-9                              jump straight to that row and accept it
 *   Enter                            accept the focused row
 *   Esc                              cancel
 *
 * Up/down/left/right are read from useInput rather than from the shared
 * Select keybinding context so the picker keeps working when the REPL input
 * (or a parent dialog) has already claimed the arrow keys.
 */
export function ModelPicker(t0: Props): React.ReactNode {
  const {
    initial,
    sessionModel,
    onSelect,
    onCancel,
    isStandaloneCommand,
    showFastModeNotice,
    headerText,
    skipSettingsWrite,
  } = t0
  const setAppState = useSetAppState()
  const exitState = useExitOnCtrlCDWithKeybindings()
  const initialValue = initial === null ? NO_PREFERENCE : initial
  const [focusedValue, setFocusedValue] = useState<string>(initialValue)
  const isFastMode = useAppState(s => (isFastModeEnabled() ? s.fastMode : false))
  const [hasToggledEffort, setHasToggledEffort] = useState(false)
  const effortValue = useAppState(s => s.effortValue)
  const resolvedEffort = effortValue !== undefined ? convertEffortValueToLevel(effortValue) : undefined
  const [effort, setEffort] = useState<EffortLevel | undefined>(resolvedEffort)

  const modelOptions = getModelOptions(isFastMode ?? false)
  const optionsWithInitial =
    initial !== null && !modelOptions.some(opt => opt.value === initial)
      ? [...modelOptions, { value: initial, label: modelDisplayString(initial), description: 'Current model' }]
      : modelOptions
  const selectOptions = optionsWithInitial.map(opt => ({
    ...opt,
    value: opt.value === null ? NO_PREFERENCE : (opt.value as string),
  }))
  const initialFocusValue = selectOptions.some(o => o.value === initialValue)
    ? initialValue
    : (selectOptions[0]?.value ?? undefined)

  const focusedIndex = Math.max(
    0,
    selectOptions.findIndex(opt => opt.value === focusedValue),
  )
  const currentIndex = selectOptions[focusedIndex] ? focusedIndex : 0
  const focusedOption = selectOptions[currentIndex]
  const focusedModelName = focusedOption?.label
  const focusedModel = resolveOptionModel(focusedOption?.value)
  const focusedSupportsEffort = focusedModel ? modelSupportsEffort(focusedModel) : false
  const focusedSupportsMax = focusedModel ? modelSupportsMaxEffort(focusedModel) : false
  const focusedDefaultEffort = getDefaultEffortLevelForOption(focusedOption?.value)
  const displayEffort: EffortLevel = effort === 'max' && !focusedSupportsMax ? 'high' : (effort ?? focusedDefaultEffort)

  const visibleCount = Math.min(10, selectOptions.length)
  const maxStart = Math.max(0, selectOptions.length - visibleCount)
  const windowStart = Math.min(Math.max(0, currentIndex - visibleCount + 1), maxStart)
  const visibleOptions = selectOptions.slice(windowStart, windowStart + visibleCount)
  const hiddenCount = Math.max(0, selectOptions.length - visibleCount)

  function handleSelect(value: string): void {
    logEvent('tengu_model_command_menu_effort', {
      effort: effort as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (!skipSettingsWrite) {
      const effortLevel = resolvePickerEffortPersistence(
        effort,
        getDefaultEffortLevelForOption(value),
        getSettingsForSource('userSettings')?.effortLevel,
        hasToggledEffort,
      )
      const persistable = toPersistableEffort(effortLevel)
      if (persistable !== undefined) {
        updateSettingsForSource('userSettings', { effortLevel: persistable })
      }
      setAppState(prev => ({ ...prev, effortValue: effortLevel }))
    }
    const selectedModel = resolveOptionModel(value)
    const selectedEffort =
      hasToggledEffort && selectedModel && modelSupportsEffort(selectedModel) ? effort : undefined
    if (value === NO_PREFERENCE) {
      onSelect(null, selectedEffort)
      return
    }
    onSelect(value, selectedEffort)
  }

  function moveFocus(delta: number): void {
    if (selectOptions.length === 0) return
    const next = Math.min(Math.max(0, currentIndex + delta), selectOptions.length - 1)
    const nextOption = selectOptions[next]
    if (!nextOption) return
    setFocusedValue(nextOption.value)
    if (!hasToggledEffort && effortValue === undefined) {
      setEffort(getDefaultEffortLevelForOption(nextOption.value))
    }
  }

  function cycleEffort(direction: 'left' | 'right'): void {
    if (!focusedSupportsEffort) return
    setEffort(prev => cycleEffortLevel(prev ?? focusedDefaultEffort, direction, focusedSupportsMax))
    setHasToggledEffort(true)
  }

  useInput((input, key) => {
    if (key.escape) {
      ;(onCancel ?? (() => {}))()
      return
    }
    if (key.return) {
      if (focusedOption) handleSelect(focusedOption.value)
      return
    }
    if (key.upArrow || input === 'k' || (key.ctrl && input === 'p')) {
      moveFocus(-1)
      return
    }
    if (key.downArrow || input === 'j' || (key.ctrl && input === 'n')) {
      moveFocus(1)
      return
    }
    if (key.leftArrow || input === 'h') {
      cycleEffort('left')
      return
    }
    if (key.rightArrow || input === 'l') {
      cycleEffort('right')
      return
    }
    if (input === 'q') {
      ;(onCancel ?? (() => {}))()
      return
    }
    if (/^[1-9]$/.test(input)) {
      const idx = Number(input) - 1
      const target = selectOptions[idx]
      if (target) handleSelect(target.value)
    }
  })

  const t16 =
    headerText ??
    'Switch between Claude models. Applies to this session and future CC-lite sessions. For other/previous model names, specify with --model.'

  const content = (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color="remember" bold>
          Select model
        </Text>
        <Text dimColor>{t16}</Text>
        {sessionModel ? (
          <Text dimColor>
            Currently using {modelDisplayString(sessionModel)} for this session (set by plan mode).
            Selecting a model will undo this.
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        {visibleOptions.map((opt, i) => {
          const index = windowStart + i
          const isFocused = index === currentIndex
          return (
            <Box key={opt.value} flexDirection="row">
              <Box flexShrink={0}>
                <Text color="suggestion">{isFocused ? '❯' : ' '}</Text>
                <Text> </Text>
                <Text dimColor>{`${index + 1}.`.padEnd(4)}</Text>
                <Text color={isFocused ? 'suggestion' : undefined} bold={isFocused}>
                  {opt.label}
                </Text>
              </Box>
              <Box flexGrow={1} marginLeft={2}>
                <Text wrap="wrap" dimColor>
                  {opt.description ?? ' '}
                </Text>
              </Box>
            </Box>
          )
        })}
        {hiddenCount > 0 ? (
          <Box paddingLeft={3}>
            <Text dimColor>
              {windowStart > 0 ? '↑ ' : ''}
              {windowStart + visibleCount < selectOptions.length ? `and ${Math.max(0, selectOptions.length - windowStart - visibleCount)} more below…` : ''}
              {windowStart > 0 && windowStart + visibleCount >= selectOptions.length ? 'and more above…' : ''}
            </Text>
          </Box>
        ) : null}
      </Box>
      <Box marginBottom={1} flexDirection="column">
        {focusedSupportsEffort ? (
          <Text dimColor>
            <EffortLevelIndicator effort={displayEffort} /> {capitalize(displayEffort)} effort
            {displayEffort === focusedDefaultEffort ? ' (default)' : ''}{' '}
            <Text color="subtle">← → to adjust</Text>
          </Text>
        ) : (
          <Text color="subtle">
            <EffortLevelIndicator effort={undefined} /> Effort not supported
            {focusedModelName ? ` for ${focusedModelName}` : ''}
          </Text>
        )}
      </Box>
      <Box marginBottom={1}>
        <Text color="subtle">
          ↑↓ select · Enter confirm · ←→ thinking effort · 1-9 jump · Esc cancel
        </Text>
      </Box>
      {isFastModeEnabled() ? (
        showFastModeNotice ? (
          <Box marginBottom={1}>
            <Text dimColor>
              Fast mode is <Text bold>ON</Text> and available with {FAST_MODE_MODEL_DISPLAY} only
              (/fast). Switching to other models turn off fast mode.
            </Text>
          </Box>
        ) : isFastModeAvailable() && !isFastModeCooldown() ? (
          <Box marginBottom={1}>
            <Text dimColor>
              Use <Text bold>/fast</Text> to turn on Fast mode ({FAST_MODE_MODEL_DISPLAY} only).
            </Text>
          </Box>
        ) : null
      ) : null}
      {isStandaloneCommand ? (
        <Text dimColor italic>
          {exitState.pending ? (
            <>Press {exitState.keyName} again to exit</>
          ) : (
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="select:cancel"
                context="Select"
                fallback="Esc"
                description="exit"
              />
            </Byline>
          )}
        </Text>
      ) : null}
    </Box>
  )

  if (!isStandaloneCommand) {
    return content
  }
  return <Pane color="permission">{content}</Pane>
}

function resolveOptionModel(value?: string): string | undefined {
  if (!value) return undefined
  return value === NO_PREFERENCE ? getDefaultMainLoopModel() : parseUserSpecifiedModel(value)
}

function EffortLevelIndicator({ effort }: { effort: EffortLevel | undefined }): React.ReactNode {
  return <Text color={effort ? 'claude' : 'subtle'}>{effortLevelToSymbol(effort ?? 'low')}</Text>
}

function cycleEffortLevel(
  current: EffortLevel,
  direction: 'left' | 'right',
  includeMax: boolean,
): EffortLevel {
  const levels: EffortLevel[] = includeMax
    ? ['none', 'low', 'medium', 'high', 'max']
    : ['none', 'low', 'medium', 'high']
  // If the current level isn't in the cycle (e.g. 'max' after switching to a
  // non-Opus model), clamp to 'high'.
  const idx = levels.indexOf(current)
  const currentIndex = idx !== -1 ? idx : levels.indexOf('high')
  if (direction === 'right') {
    return levels[(currentIndex + 1) % levels.length]!
  }
  return levels[(currentIndex - 1 + levels.length) % levels.length]!
}

function getDefaultEffortLevelForOption(value?: string): EffortLevel {
  const resolved = resolveOptionModel(value) ?? getDefaultMainLoopModel()
  const defaultValue = getDefaultEffortForModel(resolved)
  return defaultValue !== undefined ? convertEffortValueToLevel(defaultValue) : 'high'
}
