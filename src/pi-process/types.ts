export type PiProcessEvent = Record<string, unknown>

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface PiProcessLike {
  readonly backendKind?: 'rpc' | 'agent-session'
  onEvent(handler: (ev: PiProcessEvent) => void): () => void
  dispose(signal?: NodeJS.Signals | number): void
  consumePreludeLines?(): string[]
  prompt(message: string, images?: unknown[]): Promise<void>
  abort(): Promise<void>
  getState(): Promise<unknown>
  getAvailableModels(): Promise<unknown>
  setModel(provider: string, modelId: string): Promise<unknown>
  setThinkingLevel(level: ThinkingLevel): Promise<void>
  setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void>
  setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void>
  compact(customInstructions?: string): Promise<unknown>
  setAutoCompaction(enabled: boolean): Promise<void>
  getSessionStats(): Promise<unknown>
  setSessionName(name: string): Promise<void>
  exportHtml(outputPath?: string): Promise<unknown>
  switchSession(sessionPath: string): Promise<unknown>
  getMessages(): Promise<unknown>
  getLastAssistantText(): Promise<string>
  getCommands(): Promise<unknown>
}
