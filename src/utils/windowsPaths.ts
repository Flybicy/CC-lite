import memoize from 'lodash-es/memoize.js'
import * as path from 'path'
import * as pathWin32 from 'path/win32'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { execSync_DEPRECATED } from './execSyncWrapper.js'
import { memoizeWithLRU } from './memoize.js'
import { getPlatform } from './platform.js'
import { isEnvTruthy } from './envUtils.js'

/**
 * Check if a file or directory exists on Windows using the dir command
 * @param path - The path to check
 * @returns true if the path exists, false otherwise
 */
function checkPathExists(path: string): boolean {
  try {
    execSync_DEPRECATED(`dir "${path}"`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Find an executable using where.exe on Windows
 * @param executable - The name of the executable to find
 * @returns The path to the executable or null if not found
 */
function findExecutable(executable: string): string | null {
  // For git, check common installation locations first
  if (executable === 'git') {
    const defaultLocations = [
      // check 64 bit before 32 bit
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      // intentionally don't look for C:\Program Files\Git\mingw64\bin\git.exe
      // because that directory is the "raw" tools with no environment setup
    ]

    for (const location of defaultLocations) {
      if (checkPathExists(location)) {
        return location
      }
    }
  }

  // Fall back to where.exe
  try {
    const result = execSync_DEPRECATED(`where.exe ${executable}`, {
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim()

    // SECURITY: Filter out any results from the current directory
    // to prevent executing malicious git.bat/cmd/exe files
    const paths = result.split('\r\n').filter(Boolean)
    const cwd = getCwd().toLowerCase()

    for (const candidatePath of paths) {
      // Normalize and compare paths to ensure we're not in current directory
      const normalizedPath = path.resolve(candidatePath).toLowerCase()
      const pathDir = path.dirname(normalizedPath).toLowerCase()

      // Skip if the executable is in the current working directory
      if (pathDir === cwd || normalizedPath.startsWith(cwd + path.sep)) {
        logForDebugging(
          `Skipping potentially malicious executable in current directory: ${candidatePath}`,
        )
        continue
      }

      // Return the first valid path that's not in the current directory
      return candidatePath
    }

    return null
  } catch {
    return null
  }
}

/**
 * Return likely Niubash Bash paths without touching the filesystem.
 * `env` is injectable so path resolution can be tested without requiring a
 * Niubash installation on the test machine.
 */
export function getNiubashBashCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: string[] = []
  const add = (value: string | undefined) => {
    if (value && !candidates.includes(value)) candidates.push(value)
  }

  add(env.CCLITE_NIUBASH_PATH)
  add(env.CCLITE_BASH_PATH)

  if (env.WINUXCMD_HOME) {
    add(pathWin32.join(env.WINUXCMD_HOME, 'bin', 'bash.exe'))
  }

  for (const shellPath of [env.NIU_SHELL, env.WINUXSH_SHELL, env.BASH]) {
    if (!shellPath) continue
    add(pathWin32.join(pathWin32.dirname(shellPath), 'winuxcmd', 'bin', 'bash.exe'))
  }

  return candidates
}

function shouldPreferNiubash(): boolean {
  if (process.env.CCLITE_USE_NIUBASH !== undefined) {
    return isEnvTruthy(process.env.CCLITE_USE_NIUBASH)
  }

  // When cclite is launched from Niubash, these variables are already
  // exported. Auto-detecting that case preserves the user's active shell
  // without changing the default for ordinary PowerShell/cmd launches.
  return Boolean(
    process.env.NIU_SHELL ||
      process.env.WINUXSH_SHELL ||
      process.env.WINUXCMD_HOME,
  )
}

function findNiubashPath(): string | null {
  for (const candidate of getNiubashBashCandidates()) {
    if (checkPathExists(candidate)) return candidate
  }

  if (shouldPreferNiubash()) {
    const discovered = findExecutable('bash')
    if (discovered && checkPathExists(discovered)) return discovered
  }

  return null
}

/**
 * If Windows, set the SHELL environment variable to a POSIX-compatible Bash path.
 * This is used by BashTool and Shell.ts for user shell commands.
 * COMSPEC is left unchanged for system process execution.
 */
export function setShellIfWindows(): void {
  if (getPlatform() === 'windows') {
    const bashPath = findGitBashPath()
    process.env.SHELL = bashPath
    logForDebugging(`Using bash path: "${bashPath}"`)
  }
}

/**
 * Find the Windows Bash-compatible executable used by BashTool.
 *
 * The historical name is retained because callers and environment variables
 * use the Git Bash terminology. Niubash is compatible with the same `-c`
 * execution contract and can be selected with CCLITE_USE_NIUBASH=1,
 * CCLITE_NIUBASH_PATH, or automatically when launched inside Niubash.
 */
export const findGitBashPath = memoize((): string => {
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    if (checkPathExists(process.env.CLAUDE_CODE_GIT_BASH_PATH)) {
      return process.env.CLAUDE_CODE_GIT_BASH_PATH
    }
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      `CC-lite was unable to find CLAUDE_CODE_GIT_BASH_PATH path "${process.env.CLAUDE_CODE_GIT_BASH_PATH}"`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  if (process.env.CCLITE_BASH_PATH && checkPathExists(process.env.CCLITE_BASH_PATH)) {
    return process.env.CCLITE_BASH_PATH
  }

  if (shouldPreferNiubash()) {
    const niubashPath = findNiubashPath()
    if (niubashPath) return niubashPath
  }

  const gitPath = findExecutable('git')
  if (gitPath) {
    const bashPath = pathWin32.join(gitPath, '..', '..', 'bin', 'bash.exe')
    if (checkPathExists(bashPath)) {
      return bashPath
    }
  }

  // Last resort: accept a Bash executable already exposed on PATH. This also
  // covers portable Bash installations when Git is not installed.
  const bashPath = findExecutable('bash')
  if (bashPath && checkPathExists(bashPath)) return bashPath

  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(
    'CC-lite on Windows requires a POSIX-compatible Bash shell (Git Bash or Niubash). If installed but not in PATH, set CCLITE_BASH_PATH or CLAUDE_CODE_GIT_BASH_PATH to its bash.exe.',
  )
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
})

/** Convert a Windows path to a POSIX path using pure JS. */
export const windowsPathToPosixPath = memoizeWithLRU(
  (windowsPath: string): string => {
    // Handle UNC paths: \\server\share -> //server/share
    if (windowsPath.startsWith('\\\\')) {
      return windowsPath.replace(/\\/g, '/')
    }
    // Handle drive letter paths: C:\Users\foo -> /c/Users/foo
    const match = windowsPath.match(/^([A-Za-z]):[/\\]/)
    if (match) {
      const driveLetter = match[1]!.toLowerCase()
      return '/' + driveLetter + windowsPath.slice(2).replace(/\\/g, '/')
    }
    // Already POSIX or relative — just flip slashes
    return windowsPath.replace(/\\/g, '/')
  },
  (p: string) => p,
  500,
)

/** Convert a POSIX path to a Windows path using pure JS. */
export const posixPathToWindowsPath = memoizeWithLRU(
  (posixPath: string): string => {
    // Handle UNC paths: //server/share -> \\server\share
    if (posixPath.startsWith('//')) {
      return posixPath.replace(/\//g, '\\')
    }
    // Handle /cygdrive/c/... format
    const cygdriveMatch = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/)
    if (cygdriveMatch) {
      const driveLetter = cygdriveMatch[1]!.toUpperCase()
      const rest = posixPath.slice(('/cygdrive/' + cygdriveMatch[1]).length)
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\')
    }
    // Handle /c/... format (MSYS2/Git Bash)
    const driveMatch = posixPath.match(/^\/([A-Za-z])(\/|$)/)
    if (driveMatch) {
      const driveLetter = driveMatch[1]!.toUpperCase()
      const rest = posixPath.slice(2)
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\')
    }
    // Already Windows or relative — just flip slashes
    return posixPath.replace(/\//g, '\\')
  },
  (p: string) => p,
  500,
)
