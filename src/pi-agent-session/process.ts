import type { AgentSideConnection, ClientCapabilities } from '@agentclientprotocol/sdk'
import type { PiProcessEvent, PiProcessLike, ThinkingLevel } from '../pi-process/types.js'

type PiModelLike = { provider?: string; modelId?: string; id?: string; name?: string }

type AgentToolLike = { name?: string }

type PiModelRegistryLike = {
  getAvailable?: () => PiModelLike[]
  find?: (provider: string, modelId: string) => PiModelLike | undefined
  models?: PiModelLike[]
}

type PiSessionManagerCtorLike = {
  open(path: string, sessionDir?: string, cwdOverride?: string): unknown
}

type AgentSessionLike = {
  subscribe(listener: (event: PiProcessEvent) => void): () => void
  prompt(text: string, options?: { images?: unknown[]; source?: string }): Promise<void>
  abort(): Promise<void>
  dispose(): void
  sessionId?: string
  sessionFile?: string
  sessionName?: string
  model?: PiModelLike
  thinkingLevel?: string
  steeringMode?: 'all' | 'one-at-a-time'
  followUpMode?: 'all' | 'one-at-a-time'
  autoCompactionEnabled?: boolean
  messages?: unknown[]
  state?: unknown
  agent?: { state?: { tools?: AgentToolLike[] } }
  modelRegistry?: PiModelRegistryLike
  setModel?: (model: unknown) => Promise<void>
  setThinkingLevel?: (level: ThinkingLevel) => void
  setFollowUpMode?: (mode: 'all' | 'one-at-a-time') => void
  setSteeringMode?: (mode: 'all' | 'one-at-a-time') => void
  compact?: (customInstructions?: string) => Promise<unknown>
  setAutoCompactionEnabled?: (enabled: boolean) => void
}

type CreateAgentSession = (options: Record<string, unknown>) => Promise<{ session: AgentSessionLike }>

type CreateReadTool = (cwd: string, options?: Record<string, unknown>) => AgentToolLike

type PiSdkModule = {
  createAgentSession?: CreateAgentSession
  createReadTool?: CreateReadTool
  SessionManager?: PiSessionManagerCtorLike
}

type SpawnDeps = {
  createAgentSession?: CreateAgentSession
  createReadTool?: CreateReadTool
}

type SpawnParams = {
  cwd: string
  sessionPath?: string
  conn?: AgentSideConnection
  clientCapabilities?: ClientCapabilities
}

const PI_PACKAGE = '@earendil-works/pi-coding-agent'

export class AgentSessionProcess implements PiProcessLike {
  readonly backendKind = 'agent-session'
  private handlers: Array<(ev: PiProcessEvent) => void> = []
  private unsubscribe: (() => void) | undefined

  constructor(private readonly session: AgentSessionLike) {
    this.unsubscribe = session.subscribe(ev => {
      for (const h of this.handlers) h(ev)
    })
  }

  static async spawn(params: SpawnParams, deps: SpawnDeps = {}): Promise<AgentSessionProcess> {
    const sdk = deps.createAgentSession ? null : await loadPiSdkModule()
    const createAgentSession = deps.createAgentSession ?? sdk!.createAgentSession!
    const createReadTool = deps.createReadTool ?? sdk?.createReadTool
    const sessionManager = params.sessionPath ? sdk?.SessionManager?.open(params.sessionPath, undefined, params.cwd) : undefined
    const result = await createAgentSession({
      cwd: params.cwd,
      ...(sessionManager ? { sessionManager } : {})
    })

    if (createReadTool && shouldUseAcpRead(params)) {
      installAcpReadTool(result.session, {
        cwd: params.cwd,
        conn: params.conn!,
        createReadTool
      })
    }

    return new AgentSessionProcess(result.session)
  }

  onEvent(handler: (ev: PiProcessEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.session.dispose()
  }

  consumePreludeLines(): string[] {
    return []
  }

  async prompt(message: string, images: unknown[] = []): Promise<void> {
    await this.session.prompt(message, { images, source: 'acp' })
  }

  async abort(): Promise<void> {
    await this.session.abort()
  }

  async getState(): Promise<unknown> {
    const model = this.session.model
    return {
      sessionId: this.session.sessionId,
      sessionFile: this.session.sessionFile,
      sessionName: this.session.sessionName,
      model: model
        ? {
            provider: model.provider,
            modelId: model.modelId ?? model.id,
            id: model.id ?? model.modelId,
            name: model.name ?? model.id ?? model.modelId
          }
        : null,
      thinkingLevel: this.session.thinkingLevel,
      steeringMode: this.session.steeringMode,
      followUpMode: this.session.followUpMode,
      autoCompactionEnabled: this.session.autoCompactionEnabled,
      messageCount: Array.isArray(this.session.messages) ? this.session.messages.length : undefined
    }
  }

  async getAvailableModels(): Promise<unknown> {
    const registry = this.session.modelRegistry
    if (typeof registry?.getAvailable === 'function') return { models: registry.getAvailable() }
    if (Array.isArray(registry?.models)) return { models: registry.models }
    const model = this.session.model
    if (!model) return { models: [] }
    return {
      models: [
        {
          provider: model.provider,
          id: model.id ?? model.modelId,
          modelId: model.modelId ?? model.id,
          name: model.name ?? model.id ?? model.modelId
        }
      ]
    }
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const model = this.session.modelRegistry?.find?.(provider, modelId)
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`)
    if (!this.session.setModel) throw new Error('AgentSessionProcess.setModel is not available')
    await this.session.setModel(model)
    return model
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.session.setThinkingLevel?.(level)
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    this.session.setFollowUpMode?.(mode)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    this.session.setSteeringMode?.(mode)
  }

  async compact(customInstructions?: string): Promise<unknown> {
    if (!this.session.compact) throw new Error('AgentSessionProcess.compact is not implemented')
    return this.session.compact(customInstructions)
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    this.session.setAutoCompactionEnabled?.(enabled)
  }

  async getSessionStats(): Promise<unknown> {
    return {
      sessionId: this.session.sessionId,
      sessionFile: this.session.sessionFile,
      totalMessages: Array.isArray(this.session.messages) ? this.session.messages.length : 0
    }
  }

  async setSessionName(_name: string): Promise<void> {
    throw new Error('AgentSessionProcess.setSessionName is not implemented in the skeleton backend')
  }

  async exportHtml(_outputPath?: string): Promise<unknown> {
    throw new Error('AgentSessionProcess.exportHtml is not implemented in the skeleton backend')
  }

  async switchSession(_sessionPath: string): Promise<unknown> {
    throw new Error('AgentSessionProcess.switchSession is not implemented in the skeleton backend')
  }

  async getMessages(): Promise<unknown> {
    return { messages: this.session.messages ?? [] }
  }

  async getLastAssistantText(): Promise<string> {
    const messages = this.session.messages ?? []
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = extractAssistantText(messages[i])
      if (text) return text
    }
    return ''
  }

  async getCommands(): Promise<unknown> {
    return { commands: [] }
  }
}

async function loadPiSdkModule(): Promise<Required<Pick<PiSdkModule, 'createAgentSession'>> & PiSdkModule> {
  let mod: PiSdkModule
  try {
    mod = (await import(PI_PACKAGE)) as PiSdkModule
  } catch (e: any) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        `PI_ACP_BACKEND=agent-session requires ${PI_PACKAGE} to be available to pi-acp. Install pi or package it with the ACP adapter before using this backend.`
      )
    }
    throw e
  }

  if (typeof mod.createAgentSession !== 'function') {
    throw new Error(`${PI_PACKAGE} does not export createAgentSession`)
  }
  return mod as Required<Pick<PiSdkModule, 'createAgentSession'>> & PiSdkModule
}

function shouldUseAcpRead(params: SpawnParams): boolean {
  return Boolean(params.conn && params.clientCapabilities?.fs?.readTextFile)
}

function installAcpReadTool(
  session: AgentSessionLike,
  opts: { cwd: string; conn: AgentSideConnection; createReadTool: CreateReadTool }
): void {
  const tools = session.agent?.state?.tools
  if (!Array.isArray(tools)) return

  const acpReadTool = opts.createReadTool(opts.cwd, {
    operations: {
      access: async (_absolutePath: string) => {
        // ACP read will fail with the client's own error if the file is unavailable.
      },
      readFile: async (absolutePath: string) => {
        const sessionId = session.sessionId ?? ''
        const result = await opts.conn.readTextFile({ sessionId, path: absolutePath })
        return Buffer.from(result.content, 'utf8')
      }
    }
  })

  let replaced = false
  session.agent!.state!.tools = tools.map(tool => {
    if (tool?.name !== 'read') return tool
    replaced = true
    return acpReadTool
  })

  if (!replaced) session.agent!.state!.tools = [acpReadTool, ...tools]
}

function extractAssistantText(message: unknown): string {
  const role = (message as any)?.role
  if (role && role !== 'assistant') return ''
  const content = (message as any)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}
