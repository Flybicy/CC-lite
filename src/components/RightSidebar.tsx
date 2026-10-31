import figures from 'figures'
import { readdirSync } from 'node:fs'
import { basename } from 'node:path'
import React, { useEffect, useState } from 'react'
import { useTasksV2 } from '../hooks/useTasksV2.js'
import { Box, Text } from '../ink.js'
import { execFileNoThrow } from '../utils/execFileNoThrow.js'

const REFRESH_MS = 5_000
const MAX_CHANGES = 6
const MAX_DIRS = 5
const MAX_TASKS = 8

type ProjectInfo = {
  branch: string
  changes: string[]
  changeCount: number
  dirs: string[]
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text
  return `${text.slice(0, Math.max(0, width - 1))}…`
}

/**
 * Cheap, local-only project snapshot: branch, changed files, top-level dirs.
 * Every command is read-only and bounded by a 2s timeout; a missing git binary
 * simply yields an empty branch line.
 */
function useProjectInfo(): ProjectInfo {
  const [info, setInfo] = useState<ProjectInfo>({
    branch: '',
    changes: [],
    changeCount: 0,
    dirs: [],
  })

  useEffect(() => {
    let alive = true
    const load = async () => {
      const [branch, status] = await Promise.all([
        execFileNoThrow('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          timeout: 2_000,
        }),
        execFileNoThrow('git', ['status', '--porcelain'], { timeout: 2_000 }),
      ])
      if (!alive) return
      const lines = status.stdout.split('\n').filter(Boolean)
      let dirs: string[] = []
      try {
        dirs = readdirSync(process.cwd(), { withFileTypes: true })
          .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
          .map(entry => `${entry.name}/`)
          .slice(0, MAX_DIRS)
      } catch {
        dirs = []
      }
      setInfo({
        branch: branch.code === 0 ? branch.stdout.trim() : '',
        changes: lines.slice(0, MAX_CHANGES).map(line => line.slice(3)),
        changeCount: lines.length,
        dirs,
      })
    }
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  return info
}

function PanelTitle({ children, count }: { children: string; count?: string }) {
  return (
    <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
      <Text bold dimColor>
        {children}
      </Text>
      {count ? <Text dimColor>{count}</Text> : null}
    </Box>
  )
}

export function RightSidebar({ width = 34 }: { width?: number }): React.ReactNode {
  const project = useProjectInfo()
  const tasks = useTasksV2() ?? []
  const openTasks = tasks.filter(task => task.status !== 'completed').length
  const textWidth = width - 4

  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      paddingX={1}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor="subtle"
      overflow="hidden"
    >
      <Box flexDirection="column" marginBottom={1}>
        <PanelTitle>PROJECT</PanelTitle>
        <Text bold>{truncate(basename(process.cwd()), textWidth)}</Text>
        {project.branch ? (
          <Text dimColor>
            {'⎇'} {truncate(project.branch, textWidth - 2)}
          </Text>
        ) : null}
        <Text dimColor={project.changeCount === 0}>
          {project.changeCount === 0
            ? 'clean'
            : `${project.changeCount} changed`}
        </Text>
        {project.changes.map(change => (
          <Text key={change} dimColor>
            {truncate(`· ${change}`, textWidth)}
          </Text>
        ))}
        {project.dirs.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {project.dirs.map(dir => (
              <Text key={dir} dimColor>
                {truncate(dir, textWidth)}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>

      <Box flexDirection="column">
        <PanelTitle count={tasks.length > 0 ? `${openTasks}/${tasks.length}` : undefined}>
          TASKS
        </PanelTitle>
        {tasks.length === 0 ? (
          <Text dimColor>no tasks</Text>
        ) : (
          tasks.slice(0, MAX_TASKS).map(task => {
            const glyph =
              task.status === 'completed'
                ? figures.tick
                : task.status === 'in_progress'
                  ? figures.pointer
                  : '○'
            const color =
              task.status === 'completed'
                ? 'success'
                : task.status === 'in_progress'
                  ? 'warning'
                  : undefined
            return (
              <Box key={task.id} flexDirection="row">
                <Text color={color} dimColor={task.status === 'pending'}>
                  {glyph}{' '}
                </Text>
                <Text color={color} dimColor={task.status === 'pending'} wrap="truncate-end">
                  {truncate(task.subject, textWidth - 2)}
                </Text>
              </Box>
            )
          })
        )}
      </Box>
    </Box>
  )
}
