import {
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
  type SessionConfigOption
} from '@agentclientprotocol/sdk'
import { getAuthMethods } from './auth.js'
import { SessionManager, type PiAcpSession } from './session.js'
import { SessionStore } from './session-store.js'
import { AcpBridgeServer } from './bridge.js'
import { PiRpcProcess } from '../pi-rpc/process.js'
import { listPiSessions, findPiSessionFile } from './pi-sessions.js'
import { normalizePiAssistantText, normalizePiMessageText } from './translate/pi-messages.js'
import { toolResultToText } from './translate/pi-tools.js'
import {
  bashCommand,
  bashExitCode,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { promptToPiMessage } from './translate/prompt.js'
import { loadSlashCommands, parseCommandArgs, toAvailableCommands } from './slash-commands.js'
import { getEnableSkillCommands, getQuietStartup } from './pi-settings.js'
import { toAvailableCommandsFromPiGetCommands } from './pi-commands.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { isAbsolute } from 'node:path'
import { existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

type ModelInfo = {
  modelId: string
  name: string
  description?: string | null
}

type ModelState = {
  availableModels: ModelInfo[]
  currentModelId: string
}

type ThinkingState = {
  availableModes: Array<{
    id: string
    name: string
    description?: string | null
  }>
  currentModeId: string
}

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: 'compact',
      description: 'Manually compact the session context',
      input: { hint: 'optional custom instructions' }
    },
    {
      name: 'autocompact',
      description: 'Toggle automatic context compaction',
      input: { hint: 'on|off|toggle' }
    },
    {
      name: 'export',
      description: 'Export session to an HTML file in the session cwd'
    },
    {
      name: 'session',
      description: 'Show session stats (messages, tokens, cost, session file)'
    },
    {
      name: 'usage',
      description: 'Show token usage, context window, remaining context, and cost'
    },
    {
      name: 'plan-test',
      description: 'Show a sample ACP plan in the client UI'
    },
    {
      name: 'name',
      description: 'Set session display name',
      input: { hint: '<name>' }
    },
    {
      name: 'steering',
      description: 'Get/set pi steering message delivery mode (how queued steering messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'follow-up',
      description: 'Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'changelog',
      description: 'Show pi changelog'
    }
  ]
}

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
  // Preserve order, de-dupe by name (first wins).
  const out: AvailableCommand[] = []
  const seen = new Set<string>()

  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c)
  }

  return out
}

function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return '0%'
  return `${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1)}%`
}

function validateAdditionalDirectories(value: unknown, cwd: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value))
    throw RequestError.invalidParams('additionalDirectories must be an array of absolute paths')

  const out: string[] = []
  const seen = new Set<string>([cwd])
  for (const entry of value) {
    if (typeof entry !== 'string') throw RequestError.invalidParams('additionalDirectories entries must be strings')
    if (!entry.trim()) throw RequestError.invalidParams('additionalDirectories entries must not be empty')
    if (!isAbsolute(entry))
      throw RequestError.invalidParams(`additionalDirectories entries must be absolute paths: ${entry}`)
    if (seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

function formatUsageStats(stats: any): string {
  const lines: string[] = ['Usage']

  const contextUsage = stats?.contextUsage
  if (contextUsage && typeof contextUsage === 'object') {
    const tokens = typeof contextUsage.tokens === 'number' ? contextUsage.tokens : null
    const window = typeof contextUsage.contextWindow === 'number' ? contextUsage.contextWindow : null
    const percent =
      typeof contextUsage.percent === 'number'
        ? contextUsage.percent
        : tokens !== null && window && window > 0
          ? (tokens / window) * 100
          : null

    if (tokens !== null && window !== null) {
      const remaining = Math.max(0, window - tokens)
      lines.push(`Context: ${formatCount(tokens)} / ${formatCount(window)} tokens`)
      lines.push(
        `Remaining: ${formatCount(remaining)} tokens${percent !== null ? ` (${formatPercent(100 - percent)} free)` : ''}`
      )
      if (percent !== null) lines.push(`Used: ${formatPercent(percent)}`)
    } else if (tokens !== null) {
      lines.push(`Context tokens: ${formatCount(tokens)}`)
    } else if (window !== null) {
      lines.push(`Context window: ${formatCount(window)} tokens`)
    }
  }

  const t = stats?.tokens
  if (t && typeof t === 'object') {
    const parts: string[] = []
    if (typeof t.input === 'number') parts.push(`input ${formatCount(t.input)}`)
    if (typeof t.output === 'number') parts.push(`output ${formatCount(t.output)}`)
    if (typeof t.cacheRead === 'number') parts.push(`cache read ${formatCount(t.cacheRead)}`)
    if (typeof t.cacheWrite === 'number') parts.push(`cache write ${formatCount(t.cacheWrite)}`)
    if (typeof t.total === 'number') parts.push(`total ${formatCount(t.total)}`)
    if (parts.length) lines.push(`Tokens: ${parts.join(', ')}`)
  }

  if (typeof stats?.cost === 'number') lines.push(`Cost: $${stats.cost.toFixed(4)}`)
  if (typeof stats?.totalMessages === 'number') lines.push(`Messages: ${formatCount(stats.totalMessages)}`)

  return lines.length > 1 ? lines.join('\n') : `Usage stats:\n${JSON.stringify(stats, null, 2)}`
}
import { fileURLToPath } from 'node:url'

const pkg = readNearestPackageJson(import.meta.url)

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection
  private readonly sessions = new SessionManager()
  private readonly store = new SessionStore()
  private readonly bridge: AcpBridgeServer
  private supportsTerminalOutput = false

  dispose(): void {
    this.sessions.disposeAll()
    this.bridge.dispose()
  }

  // Remember recent session cwd and use it as the default filter.
  private lastSessionCwd: string | null = null

  constructor(conn: AgentSideConnection, _config?: unknown) {
    this.conn = conn
    this.bridge = new AcpBridgeServer(conn)
    void _config
  }

  private cleanupFailedNewSession(sessionId: string, state?: any | null): void {
    this.sessions.close(sessionId)

    const sessionFile =
      typeof state?.sessionFile === 'string' && state.sessionFile.trim()
        ? state.sessionFile
        : this.store.get(sessionId)?.sessionFile

    if (typeof sessionFile === 'string' && sessionFile.trim()) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch {
        // ignore cleanup failures; the auth/internal error is the primary result
      }
    }

    this.store.delete(sessionId)
  }

  private getSessionIfPresent(sessionId: string): PiAcpSession | null {
    const maybeGet = (this.sessions as any).maybeGet
    if (typeof maybeGet === 'function')
      return (maybeGet.call(this.sessions, sessionId) as PiAcpSession | undefined) ?? null

    try {
      return this.sessions.get(sessionId)
    } catch {
      return null
    }
  }

  private async spawnPiSession(cwd: string, sessionFile: string, env?: Record<string, string>): Promise<PiRpcProcess> {
    try {
      return await PiRpcProcess.spawn({
        cwd,
        sessionPath: sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND,
        env
      })
    } catch (e: any) {
      if (e?.name === 'PiRpcSpawnError') {
        throw RequestError.internalError({ code: e?.code }, String(e?.message ?? e))
      }
      throw e
    }
  }

  private resolveKnownSession(
    sessionId: string,
    cwdHint?: string
  ): { cwd: string; sessionFile: string; storedAdditionalDirectories: string[] } | null {
    const stored = this.store.get(sessionId)
    if (stored?.sessionFile) {
      const cwd = cwdHint ?? stored.cwd
      if (typeof cwd === 'string' && cwd.trim()) {
        return {
          cwd,
          sessionFile: stored.sessionFile,
          storedAdditionalDirectories: stored.additionalDirectories ?? []
        }
      }
    }

    const sessionFile = findPiSessionFile(sessionId)
    if (!sessionFile) return null

    const piSession = listPiSessions().find(s => s.sessionId === sessionId && s.sessionFile === sessionFile)
    const cwd = cwdHint ?? piSession?.cwd
    if (typeof cwd !== 'string' || !cwd.trim()) return null

    return { cwd, sessionFile, storedAdditionalDirectories: [] }
  }

  private async getOrReviveSession(
    sessionId: string,
    opts: { cwd?: string; mcpServers?: any[]; additionalDirectories?: string[] } = {}
  ): Promise<PiAcpSession> {
    const existing = this.getSessionIfPresent(sessionId)
    if (existing) {
      if (opts.additionalDirectories && typeof (existing as any).setAdditionalDirectories === 'function') {
        existing.setAdditionalDirectories(opts.additionalDirectories)
      }
      return existing
    }

    const known = this.resolveKnownSession(sessionId, opts.cwd)
    if (!known) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    if (!isAbsolute(known.cwd)) throw RequestError.invalidParams(`cwd must be an absolute path: ${known.cwd}`)
    const additionalDirectories = opts.additionalDirectories ?? known.storedAdditionalDirectories

    const bridge = await this.bridge.prepareSession()
    const proc = await this.spawnPiSession(known.cwd, known.sessionFile, bridge.env)
    const session = this.sessions.getOrCreate(sessionId, {
      cwd: known.cwd,
      mcpServers: (opts.mcpServers ?? []) as any,
      conn: this.conn,
      proc,
      fileCommands: loadSlashCommands(known.cwd),
      piCommand: process.env.PI_ACP_PI_COMMAND,
      supportsTerminalOutput: this.supportsTerminalOutput,
      additionalDirectories
    })

    this.bridge.attachSession(bridge.token, {
      sessionId: session.sessionId,
      cwd: known.cwd,
      additionalDirectories
    })
    this.store.upsert({ sessionId, cwd: known.cwd, sessionFile: known.sessionFile, additionalDirectories })
    return session
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.supportsTerminalOutput = (params as any)?.clientCapabilities?._meta?.['terminal_output'] === true

    // We currently only support ACP protocol version 1.
    const supportedVersion = 1
    const requested = params.protocolVersion

    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? 'pi-acp',
        title: 'pi ACP adapter',
        version: pkg.version ?? '0.0.0'
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta: (params as any)?.clientCapabilities?._meta?.['terminal-auth'] === true
      }),
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT !== 'false'
        },
        sessionCapabilities: {
          // **UNSTABLE** ACP capability used by Zed's codex-acp adapter.
          // Enables a native session picker in clients that support it.
          list: {},
          // Enables multi-root Zed workspaces. Zed sends all workspace roots after
          // the first as additionalDirectories when this capability is present.
          additionalDirectories: {}
        }
      }
    }
  }

  async newSession(params: NewSessionRequest) {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    const additionalDirectories = validateAdditionalDirectories((params as any).additionalDirectories, params.cwd)
    this.lastSessionCwd = params.cwd

    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)

    const bridge = await this.bridge.prepareSession()

    // Pi doesn't support mcpServers, but we accept and store.
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      supportsTerminalOutput: this.supportsTerminalOutput,
      bridgeEnv: bridge.env,
      additionalDirectories
    })
    this.bridge.attachSession(bridge.token, {
      sessionId: session.sessionId,
      cwd: params.cwd,
      additionalDirectories
    })

    // Fetch state + models once (parallel) to reduce startup latency.
    let state: any = null
    let availableModels: any = null
    let stateErr: unknown = null
    let availableModelsErr: unknown = null

    await Promise.all([
      session.proc
        .getState()
        .then(s => {
          state = s as any
        })
        .catch(err => {
          stateErr = err
          state = null
        }),
      session.proc
        .getAvailableModels()
        .then(m => {
          availableModels = m as any
        })
        .catch(err => {
          availableModelsErr = err
          availableModels = null
        })
    ])

    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr)

    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw availableModelsAuthErr
    }

    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.internalError({}, String((availableModelsErr as Error)?.message ?? availableModelsErr))
    }

    // If pi has no models available after spawning, it's effectively unauthenticated.
    const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0

    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    if (stateErr && maybeAuthRequiredError(stateErr)) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    const models = await getModelState(session.proc, { state, availableModels })
    const thinking = await getThinkingState(session.proc, { state })

    const quietStartup = getQuietStartup(params.cwd)
    const updateNotice = buildUpdateNotice()

    // If quietStartup is enabled, suppress the full "startup info" prelude, but still surface
    // the "New version available" notice (if any) since it's high-signal and actionable.
    const preludeText = quietStartup
      ? updateNotice
        ? updateNotice + '\n'
        : ''
      : buildStartupInfo({
          cwd: params.cwd,
          fileCommands,
          updateNotice
        })

    if (preludeText) session.setStartupInfo(preludeText)

    const response = {
      sessionId: session.sessionId,
      models,
      modes: thinking,
      configOptions: buildConfigOptions(models, thinking),
      _meta: {
        piAcp: {
          startupInfo: preludeText || null
        }
      }
    }

    // Try to send it immediately after session/new returns; if the client ignores it,
    // it will still be emitted as the first chunk of the first prompt.
    if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0)

    // Advertise slash commands (ACP: available_commands_update)
    // Important: some clients (e.g. Zed) will ignore notifications for an unknown sessionId.
    // So we must send this *after* the session/new response has been delivered.
    setTimeout(() => {
      void (async () => {
        try {
          const pi = (await session.proc.getCommands()) as any
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: false
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          })
          return
        } catch {
          // Fall back to file-based prompt templates (legacy behavior).
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        })
      })()
    }, 0)

    return response
  }

  async authenticate(_params: AuthenticateRequest) {
    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // If the client calls `authenticate` anyway, we can no-op successfully.
    return
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = await this.getOrReviveSession(params.sessionId)

    const { message, images } = promptToPiMessage(params.prompt)

    // Built-in ACP slash command handling (headless-friendly subset).
    // Note: file-based slash commands are expanded inside session.prompt().
    if (images.length === 0 && message.trimStart().startsWith('/')) {
      const trimmed = message.trim()
      const space = trimmed.indexOf(' ')
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)
      const argsString = space === -1 ? '' : trimmed.slice(space + 1)
      const args = parseCommandArgs(argsString)

      if (cmd === 'compact') {
        const customInstructions = args.join(' ').trim() || undefined
        const res = await session.proc.compact(customInstructions)

        const r: any = res && typeof res === 'object' ? (res as any) : null
        const tokensBefore = typeof r?.tokensBefore === 'number' ? r.tokensBefore : null
        const summary = typeof r?.summary === 'string' ? r.summary : null

        const headerLines = [
          `Compaction completed.${customInstructions ? ' (custom instructions applied)' : ''}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
        ].filter(Boolean)

        const text = headerLines.join('\n') + (summary ? `\n\n${summary}` : '')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'usage' || cmd === 'context') {
        const stats = (await session.proc.getSessionStats()) as any
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: formatUsageStats(stats) }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'plan-test') {
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'plan',
            entries: [
              {
                content: 'Inspect Zed ACP plan rendering',
                status: 'completed',
                priority: 'high'
              },
              {
                content: 'Populate a sample plan from `pi-acp`',
                status: 'in_progress',
                priority: 'high'
              },
              {
                content: 'Decide whether to map real Pi progress into this UI',
                status: 'pending',
                priority: 'medium'
              }
            ]
          }
        })
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Sent a sample ACP plan. If Zed renders plans, it should appear in the thread UI.'
            }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'session') {
        const stats = (await session.proc.getSessionStats()) as any

        const lines: string[] = []
        if (stats?.sessionId) lines.push(`Session: ${stats.sessionId}`)
        if (stats?.sessionFile) lines.push(`Session file: ${stats.sessionFile}`)
        if (typeof stats?.totalMessages === 'number') lines.push(`Messages: ${stats.totalMessages}`)

        if (typeof stats?.cost === 'number') lines.push(`Cost: ${stats.cost}`)

        const t = stats?.tokens
        if (t && typeof t === 'object') {
          const parts: string[] = []
          if (typeof t.input === 'number') parts.push(`in ${t.input}`)
          if (typeof t.output === 'number') parts.push(`out ${t.output}`)
          if (typeof t.cacheRead === 'number') parts.push(`cache read ${t.cacheRead}`)
          if (typeof t.cacheWrite === 'number') parts.push(`cache write ${t.cacheWrite}`)
          if (typeof t.total === 'number') parts.push(`total ${t.total}`)
          if (parts.length) lines.push(`Tokens: ${parts.join(', ')}`)
        }

        // Fallback if stats shape changes.
        const text = lines.length ? lines.join('\n') : `Session stats:\n${JSON.stringify(stats, null, 2)}`

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'name') {
        const name = args.join(' ').trim()
        if (!name) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Usage: /name <name>' }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          await session.proc.setSessionName(name)
        } catch (e: any) {
          const msg = String(e?.message ?? e)
          const hint = /set_session_name/i.test(msg)
            ? ' This requires a newer pi version that supports `set_session_name` in RPC mode.'
            : ''

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to set session name: ${msg}${hint}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            title: name,
            updatedAt: new Date().toISOString()
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Session name set: ${name}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'steering') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.steeringMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Steering mode: ${current || 'unknown'}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /steering all | /steering one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setSteeringMode(modeRaw as 'all' | 'one-at-a-time')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Steering mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'follow-up') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.followUpMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Follow-up mode: ${current || 'unknown'}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /follow-up all | /follow-up one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setFollowUpMode(modeRaw as 'all' | 'one-at-a-time')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Follow-up mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'changelog') {
        // Read pi's installed CHANGELOG.md. Adapter-side, no model call.
        const findChangelog = (): string | null => {
          // 1) Locate the installed pi package by resolving the `pi` executable.
          // On Node installs, `pi` typically resolves to .../@earendil-works/pi-coding-agent/dist/cli.js
          try {
            const whichCmd = process.platform === 'win32' ? 'where' : 'which'
            const which = spawnSync(whichCmd, ['pi'], { encoding: 'utf-8' })
            const piPath = String(which.stdout ?? '')
              .split(/\r?\n/)[0]
              ?.trim()

            if (piPath) {
              const resolved = realpathSync(piPath)
              const pkgRoot = dirname(dirname(resolved))
              const p = join(pkgRoot, 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          // 2) Fallback: ask npm where global modules live.
          try {
            const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf-8' })
            const root = String(npmRoot.stdout ?? '').trim()
            if (root) {
              const p = join(root, '@earendil-works', 'pi-coding-agent', 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          return null
        }

        const changelogPath = findChangelog()
        if (!changelogPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: "Changelog not found (couldn't locate pi installation)." }
            }
          })
          return { stopReason: 'end_turn' }
        }

        let text = ''
        try {
          text = readFileSync(changelogPath, 'utf-8')
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to read changelog: ${String(e?.message ?? e)}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        // Keep it reasonably sized in chat.
        const maxChars = 20_000
        if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n...(truncated)...'

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'export') {
        // For now we always export into the session cwd and do not accept a user-provided path.
        // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
        // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
        // (no id), which would otherwise hang our request. So we guard here.
        const state = (await session.proc.getState()) as any
        const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
        const messageCount = typeof state?.messageCount === 'number' ? state.messageCount : 0

        if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Nothing to export yet (no session messages). Send a prompt first.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          const raw = readFileSync(sessionFile, 'utf-8')
          if (raw.trim().length === 0) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'Nothing to export yet (empty session file). Send a prompt first.'
                }
              }
            })
            return { stopReason: 'end_turn' }
          }
        } catch {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: "Couldn't read session file for export. Try sending a prompt first."
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
        const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`)

        let resultPath = ''
        try {
          const result = await session.proc.exportHtml(outputPath)
          resultPath = result.path
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Export failed: ${String(e?.message ?? e)}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (!resultPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Export failed: no output path returned by pi.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const uri = `file://${resultPath}`

        // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
        // assistant message, so this avoids the "link + duplicate plain text" look.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Session exported: '
            }
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'resource_link',
              name: `pi-session-${safeSessionId}.html`,
              uri,
              mimeType: 'text/html',
              title: 'Session exported'
            }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'autocompact') {
        const mode = (args[0] ?? 'toggle').toLowerCase()
        let enabled: boolean | null = null
        if (mode === 'on' || mode === 'true' || mode === 'enable' || mode === 'enabled') enabled = true
        else if (mode === 'off' || mode === 'false' || mode === 'disable' || mode === 'disabled') enabled = false

        if (enabled === null) {
          // toggle: read current state and invert.
          const state = (await session.proc.getState()) as any
          const current = Boolean(state?.autoCompactionEnabled)
          enabled = !current
        }

        await session.proc.setAutoCompaction(enabled)

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `Auto-compaction ${enabled ? 'enabled' : 'disabled'}.`
            }
          }
        })

        return { stopReason: 'end_turn' }
      }
    }

    const result = await session.prompt(message, images)

    // ACP StopReason does not include "error"; if pi fails we map to end_turn for now,
    // unless we know this was a cancellation.
    const stopReason: StopReason =
      result === 'error' ? (session.wasCancelRequested() ? 'cancelled' : 'end_turn') : result

    return { stopReason, usage: session.getLastPromptUsage() ?? null }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = await this.getOrReviveSession(params.sessionId)
    await session.cancel()
  }

  async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // ACP: filter by cwd if provided.
    // Zed currently sends `{}` (no cwd), so we default to the last session cwd to
    // emulate pi's `/resume` picker (project-scoped).
    const all = listPiSessions()

    const effectiveCwd = (params as any).cwd ?? this.lastSessionCwd
    const additionalFilter = (params as any).additionalDirectories
    const expectedAdditional = Array.isArray(additionalFilter)
      ? validateAdditionalDirectories(additionalFilter, effectiveCwd ?? '')
      : null
    const filtered = (effectiveCwd ? all.filter(s => s.cwd === effectiveCwd) : all).filter(s => {
      if (!expectedAdditional?.length) return true
      const actual = this.store.get(s.sessionId)?.additionalDirectories ?? []
      return actual.length === expectedAdditional.length && actual.every((dir, i) => dir === expectedAdditional[i])
    })

    // Cursor-based pagination (opaque cursor). For MVP, we use a simple numeric offset.
    // If cursor is invalid, treat as 0.
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0

    const PAGE_SIZE = 50
    const page = filtered.slice(start, start + PAGE_SIZE)

    const sessions: SessionInfo[] = page.map(s => {
      const additionalDirectories = this.store.get(s.sessionId)?.additionalDirectories ?? []
      return {
        sessionId: s.sessionId,
        cwd: s.cwd,
        ...(additionalDirectories.length ? { additionalDirectories } : {}),
        title: s.title,
        updatedAt: s.updatedAt
      }
    })

    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null

    return { sessions, nextCursor, _meta: {} }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    const additionalDirectories = validateAdditionalDirectories((params as any).additionalDirectories, params.cwd)
    this.lastSessionCwd = params.cwd

    const session = await this.getOrReviveSession(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      additionalDirectories
    })
    const proc = session.proc
    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)

    // Replay full conversation history.
    const data = (await proc.getMessages()) as any
    const messages = Array.isArray(data?.messages) ? data.messages : []

    for (const m of messages) {
      const role = String(m?.role ?? '')

      if (role === 'user') {
        const text = normalizePiMessageText(m?.content)
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text }
            }
          })
        }
      }

      if (role === 'assistant') {
        const text = normalizePiAssistantText(m?.content)
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text }
            }
          })
        }
      }

      if (role === 'toolResult') {
        const toolName = String((m as any)?.toolName ?? 'tool')
        const toolCallId = String((m as any)?.toolCallId ?? crypto.randomUUID())
        const isError = Boolean((m as any)?.isError)

        if (isBashTool(toolName)) {
          const text = bashResultText(m)
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: bashCommand(m) ?? toolName,
              kind: 'execute',
              status: 'completed',
              ...(this.supportsTerminalOutput ? { content: bashTerminalContent(toolCallId) } : {}),
              ...(this.supportsTerminalOutput ? { _meta: bashTerminalInfoMeta(toolCallId, params.cwd) } : {})
            }
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: isError ? 'failed' : 'completed',
              ...(this.supportsTerminalOutput
                ? {
                    _meta: {
                      ...(text ? bashTerminalOutputMeta(toolCallId, text) : {}),
                      ...bashTerminalExitMeta(toolCallId, bashExitCode(m, isError))
                    }
                  }
                : {
                    content: text
                      ? [
                          {
                            type: 'content',
                            content: { type: 'text', text: `\`\`\`console\n${text.trimEnd()}\n\`\`\`` }
                          }
                        ]
                      : undefined
                  })
            }
          })
          continue
        }

        // Create a synthetic ACP tool call to render historic tool usage.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toolName === 'read' ? 'read' : toolName === 'write' || toolName === 'edit' ? 'edit' : 'other',
            status: 'completed',
            rawInput: null,
            rawOutput: m
          }
        })

        const text = toolResultToText(m)
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: isError ? 'failed' : 'completed',
            content: text ? [{ type: 'content', content: { type: 'text', text } }] : null,
            rawOutput: m
          }
        })
      }
    }

    const models = await getModelState(proc)
    const thinking = await getThinkingState(proc)

    const response = {
      models,
      modes: thinking,
      configOptions: buildConfigOptions(models, thinking),
      _meta: {
        piAcp: {
          startupInfo: null
        }
      }
    }

    // Advertise slash commands after the response so the client knows the session exists.
    setTimeout(() => {
      void (async () => {
        try {
          const pi = (await proc.getCommands()) as any
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: false
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          })
          return
        } catch {
          // fall back
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        })
      })()
    }, 0)

    return response
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    const session = await this.getOrReviveSession(params.sessionId)

    // Accept either:
    //  - "provider/model" (preferred, matches how we advertise)
    //  - "model" (fallback, we try to resolve via available models)
    let provider: string | null = null
    let modelId: string | null = null

    if (params.modelId.includes('/')) {
      const [p, ...rest] = params.modelId.split('/')
      provider = p
      modelId = rest.join('/')
    } else {
      modelId = params.modelId
    }

    if (!provider) {
      const data = (await session.proc.getAvailableModels()) as any
      const models: any[] = Array.isArray(data?.models) ? data.models : []
      const found = models.find(m => String(m?.id) === modelId)
      if (found) {
        provider = String(found.provider)
        modelId = String(found.id)
      }
    }

    if (!provider || !modelId) {
      throw RequestError.invalidParams(`Unknown modelId: ${params.modelId}`)
    }

    await session.proc.setModel(provider, modelId)
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const configId = String(params.configId)
    const value = String(params.value)
    const session = await this.getOrReviveSession(params.sessionId)

    if (configId === 'model') {
      await this.unstable_setSessionModel({ sessionId: params.sessionId, modelId: value })
    } else if (configId === 'thinking') {
      if (!isThinkingLevel(value)) throw RequestError.invalidParams(`Unknown thinking level: ${value}`)
      await session.proc.setThinkingLevel(value)
      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: value
        }
      })
    } else {
      throw RequestError.invalidParams(`Unknown configId: ${configId}`)
    }

    const [models, thinking] = await Promise.all([getModelState(session.proc), getThinkingState(session.proc)])
    const configOptions = buildConfigOptions(models, thinking)

    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'config_option_update',
        configOptions
      } as any
    })

    return { configOptions }
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const mode = String(params.modeId)
    if (!isThinkingLevel(mode)) {
      throw RequestError.invalidParams(`Unknown modeId: ${mode}`)
    }

    const session = await this.getOrReviveSession(params.sessionId)

    await session.proc.setThinkingLevel(mode)

    // Let the client know the current mode changed (keeps the dropdown in sync).
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: mode
      }
    })

    return {}
  }
}

function buildConfigOptions(models: ModelState | null, thinking: ThinkingState): SessionConfigOption[] {
  const options: SessionConfigOption[] = [
    {
      id: 'thinking',
      name: 'Thinking',
      description: 'Pi reasoning effort for this session.',
      category: 'thought_level',
      type: 'select',
      currentValue: thinking.currentModeId,
      options: thinking.availableModes.map(mode => ({
        value: mode.id,
        name: mode.name.replace(/^Thinking: /, ''),
        description: mode.description ?? null
      }))
    }
  ]

  if (models && models.availableModels.length) {
    options.unshift({
      id: 'model',
      name: 'Model',
      description: 'Pi model for this session.',
      category: 'model',
      type: 'select',
      currentValue: models.currentModelId,
      options: models.availableModels.map(model => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null
      }))
    })
  }

  return options
}

function isThinkingLevel(x: string): x is ThinkingLevel {
  return x === 'off' || x === 'minimal' || x === 'low' || x === 'medium' || x === 'high' || x === 'xhigh'
}

async function getThinkingState(proc: PiRpcProcess, pre?: { state?: any | null }): Promise<ThinkingState> {
  // Ask pi for current thinking level.
  let current: ThinkingLevel = 'medium'

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any
      } catch {
        return null
      }
    })())

  const tl = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : null
  if (tl && isThinkingLevel(tl)) current = tl

  const available: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

  return {
    currentModeId: current,
    availableModes: available.map(id => ({
      id,
      name: `Thinking: ${id}`,
      description: null
    }))
  }
}

async function getModelState(
  proc: PiRpcProcess,
  pre?: { state?: any | null; availableModels?: any | null }
): Promise<ModelState | null> {
  // Ask pi for available models.
  let availableModels: ModelInfo[] = []

  const data =
    pre?.availableModels ??
    (await (async () => {
      try {
        return (await proc.getAvailableModels()) as any
      } catch {
        return null
      }
    })())

  const models: any[] = Array.isArray(data?.models) ? data.models : []
  availableModels = models
    .map(m => {
      const provider = String(m?.provider ?? '').trim()
      const id = String(m?.id ?? '').trim()
      if (!provider || !id) return null

      const name = String(m?.name ?? id)
      return {
        modelId: `${provider}/${id}`,
        name: `${provider}/${name}`,
        description: null
      } satisfies ModelInfo
    })
    .filter(Boolean) as ModelInfo[]

  // Ask pi what model is currently active.
  let currentModelId: string | null = null

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any
      } catch {
        return null
      }
    })())

  const model = state?.model
  if (model && typeof model === 'object') {
    const provider = String((model as any).provider ?? '').trim()
    const id = String((model as any).id ?? '').trim()
    if (provider && id) currentModelId = `${provider}/${id}`
  }

  if (!availableModels.length && !currentModelId) return null

  // Fallback if current model is unknown: use first in list.
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? 'default'

  return {
    availableModels,
    currentModelId: currentModelId ?? 'default'
  }
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v)
}

function compareSemver(a: string, b: string): number {
  // Very small comparator for x.y.z (ignores pre-release/build beyond making them "not greater" unless base differs)
  const pa = a
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  const pb = b
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

function buildUpdateNotice(): string | null {
  // Best-effort update check against npm registry.
  // Important: keep it fast to not slow down session/new.
  try {
    const piVersion = spawnSync('pi', ['--version'], { encoding: 'utf-8' })
    const installed = (String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()).replace(
      /^v/i,
      ''
    )

    if (!installed || !isSemver(installed)) return null

    const latestRes = spawnSync('npm', ['view', '@earendil-works/pi-coding-agent', 'version'], {
      encoding: 'utf-8',
      timeout: 800
    })
    const latest = String(latestRes.stdout ?? '')
      .trim()
      .replace(/^v/i, '')

    if (!latest || !isSemver(latest)) return null
    if (compareSemver(latest, installed) <= 0) return null

    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``
  } catch {
    return null
  }
}

function buildStartupInfo(opts: {
  cwd: string
  fileCommands: ReturnType<typeof loadSlashCommands>
  updateNotice: string | null
}): string {
  void opts.fileCommands

  const md: string[] = []

  // pi version header
  try {
    const piVersion = spawnSync('pi', ['--version'], { encoding: 'utf-8' })
    const installed = (String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()).replace(
      /^v/i,
      ''
    )
    if (installed) {
      md.push(`pi v${installed}`)
      md.push('---')
      md.push('')
    }
  } catch {
    // ignore
  }

  const contextPath = join(opts.cwd, 'AGENTS.md')
  if (existsSync(contextPath)) {
    md.push('## Context')
    md.push(`- ${contextPath}`)
    md.push('')
  }

  if (opts.updateNotice) {
    md.push('---')
    md.push(opts.updateNotice)
    md.push('')
  }

  return md.join('\n').trim() + '\n'
}

function readNearestPackageJson(metaUrl: string): {
  name?: string
  version?: string
} {
  try {
    let dir = dirname(fileURLToPath(metaUrl))

    // Walk upwards a few levels to find the nearest package.json
    for (let i = 0; i < 6; i++) {
      const p = join(dir, 'package.json')
      if (existsSync(p)) {
        const json = JSON.parse(readFileSync(p, 'utf-8')) as any
        return { name: json?.name, version: json?.version }
      }
      dir = dirname(dir)
    }
  } catch {
    // ignore
  }
  return { name: 'pi-acp', version: '0.0.0' }
}
