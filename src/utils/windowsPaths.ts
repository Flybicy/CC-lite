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

/** Conventional Niubash install roots, most specific first. */
export function getNiubashInstallRoots(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const roots: string[] = []
  const add = (value: string | undefined) => {
    if (value && !roots.includes(value)) roots.push(value)
  }

  const bases = [
    env.LOCALAPPDATA ? pathWin32.join(env.LOCALAPPDATA, 'Programs') : undefined,
    env.APPDATA ? pathWin32.join(env.APPDATA, 'Programs') : undefined,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.USERPROFILE,
  ]

  for (const base of bases) {
    if (base) add(pathWin32.join(base, 'Niubash'))
  }

  return roots
}

/**
 * `C:\Windows\System32\bash.exe` is the WSL launcher stub, not a POSIX
 * shell: it fails whenever no distro is installed. Never accept it.
 */
export function isWslBashStub(candidate: string): boolean {
  const normalized = candidate.replace(/\//g, '\\').toLowerCase()
  return (
    normalized.endsWith('\\windows\\system32\\bash.exe') ||
    normalized.endsWith('\\windows\\sysnative\\bash.exe')
  )
}

/** True when `candidate` lives inside a Niubash / winuxcmd installation. */
export function looksLikeNiubashPath(candidate: string): boolean {
  const normalized = candidate.replace(/\//g, '\\').toLowerCase()
  return (
    normalized.includes('\\winuxcmd\\') ||
    normalized.includes('\\niubash\\') ||
    normalized.endsWith('\\niu-bash.exe')
  )
}

/** Run `where.exe`, returning every match except ones in the current directory. */
function findAllExecutables(executable: string): string[] {
  try {
    const result = execSync_DEPRECATED(`where.exe ${executable}`, {
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim()
    if (!result) return []

    const cwd = getCwd().toLowerCase()
    return result
      .split(/\r?\n/)
      .filter(Boolean)
      .filter(candidatePath => {
        const normalizedPath = path.resolve(candidatePath).toLowerCase()
        const pathDir = path.dirname(normalizedPath).toLowerCase()
        return !(pathDir === cwd || normalizedPath.startsWith(cwd + path.sep))
      })
  } catch {
    return []
  }
}

/**
 * Discover a Niubash installation that was never exported into the
 * environment: `bash.exe` already on PATH, the `niu`/`niubash` launcher, or a
 * conventional install root. Windows-only; other platforms have no use for
 * Niubash and must keep their system shell untouched.
 */
export function discoverNiubashBashPath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (process.platform !== 'win32') return null

  for (const candidate of findAllExecutables('bash')) {
    if (
      !isWslBashStub(candidate) &&
      looksLikeNiubashPath(candidate) &&
      checkPathExists(candidate)
    ) {
      return candidate
    }
  }

  for (const launcher of ['niu', 'niubash']) {
    for (const launcherPath of findAllExecutables(launcher)) {
      const launcherDir = pathWin32.dirname(launcherPath)
      for (const candidate of [
        pathWin32.join(launcherDir, 'winuxcmd', 'bin', 'bash.exe'),
        pathWin32.join(launcherDir, 'bin', 'bash.exe'),
      ]) {
        if (checkPathExists(candidate)) return candidate
      }
    }
  }

  for (const root of getNiubashInstallRoots(env)) {
    const candidate = pathWin32.join(root, 'winuxcmd', 'bin', 'bash.exe')
    if (checkPathExists(candidate)) return candidate
  }

  return null
}

/**
 * Niubash wins whenever it is installed; `CCLITE_USE_NIUBASH=0` forces Git
 * Bash instead. Auto-preferring only when launched from inside Niubash is
 * gone — a normal PowerShell/cmd launch should still pick Niubash when the
 * user has it installed.
 */
export function shouldPreferNiubash(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.CCLITE_USE_NIUBASH !== undefined) {
    return isEnvTruthy(env.CCLITE_USE_NIUBASH)
  }
  return true
}

function findNiubashPath(): string | null {
  if (!shouldPreferNiubash()) return null

  for (const candidate of getNiubashBashCandidates()) {
    if (checkPathExists(candidate)) return candidate
  }

  return discoverNiubashBashPath()
}

/**
 * If Windows, set the SHELL environment variable to a POSIX-compatible Bash path.
 * This is used by BashTool and Shell.ts for user shell commands.
 * COMSPEC is left unchanged for system process execution.
 */
export function setShellIfWindows(): void {
  if (getPlatform() === 'windows') {
    const bashPath = tryFindPosixShell()
    if (!bashPath) {
      // No POSIX shell at all: keep the process alive so the PowerShell tool
      // can take over. BashTool hides itself via hasPosixShell().
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(
        'CC-lite: no POSIX shell found (neither Niubash nor Git Bash). Falling back to the PowerShell tool; Bash commands are unavailable.',
      )
      return
    }
    process.env.SHELL = bashPath
    logForDebugging(`Using bash path: "${bashPath}"`)
  }
}

/**
 * Resolve the POSIX shell used by BashTool, or null when this machine has
 * none. Order: explicit overrides → Niubash → Git Bash → any bash on PATH.
 *
 * Niubash is picked up automatically whenever it is installed (on PATH, via
 * the `niu` launcher, or in a conventional install root), so a plain
 * PowerShell/cmd launch still benefits from it. `CCLITE_USE_NIUBASH=0`
 * forces Git Bash; `CCLITE_NIUBASH_PATH` / `CCLITE_BASH_PATH` /
 * `CLAUDE_CODE_GIT_BASH_PATH` remain explicit overrides. Linux and macOS
 * never reach this code — setShellIfWindows() is Windows-only.
 */
export const tryFindPosixShell = memoize((): string | null => {
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

  const niubashPath = findNiubashPath()
  if (niubashPath) return niubashPath

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
  if (bashPath && !isWslBashStub(bashPath) && checkPathExists(bashPath)) {
    return bashPath
  }

  return null
})

/**
 * Whether a POSIX shell is available on this machine. Non-Windows platforms
 * always use their system shell, so they are never affected.
 */
export function hasPosixShell(): boolean {
  if (process.platform !== 'win32') return true
  return tryFindPosixShell() !== null
}

/**
 * Find the Windows Bash-compatible executable used by BashTool.
 *
 * The historical name is retained because callers and environment variables
 * use the Git Bash terminology. Resolution order lives in tryFindPosixShell();
 * this wrapper keeps the old "throw a loud error when nothing is found"
 * contract for code paths that cannot degrade (e.g. bash hooks).
 */
export const findGitBashPath = memoize((): string => {
  const found = tryFindPosixShell()
  if (found) return found

  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(
    'CC-lite on Windows requires a POSIX-compatible Bash shell (Niubash or Git Bash) for this command. If installed but not in PATH, set CCLITE_NIUBASH_PATH, CCLITE_BASH_PATH or CLAUDE_CODE_GIT_BASH_PATH to its bash.exe.',
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
