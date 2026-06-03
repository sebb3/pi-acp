import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isAbsolute, resolve as resolvePath } from 'node:path'

const MAX_BODY_BYTES = 1024 * 1024

type BridgeSession = {
  sessionId: string
  cwd: string
}

type ReadTextFileBody = {
  path?: unknown
  line?: unknown
  limit?: unknown
}

function randomToken(): string {
  return randomUUID()
}

function asOptionalUint(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of req) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    if (body.length > MAX_BODY_BYTES) throw new Error('Request body too large')
  }
  return body ? JSON.parse(body) : null
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

export class AcpBridgeServer {
  private server: Server | null = null
  private url: string | null = null
  private readonly sessions = new Map<string, BridgeSession>()

  constructor(private readonly conn: AgentSideConnection) {}

  async prepareSession(): Promise<{ token: string; env: Record<string, string> }> {
    await this.ensureStarted()
    const token = randomToken()
    return {
      token,
      env: {
        PI_ACP_BRIDGE_URL: this.url!,
        PI_ACP_BRIDGE_TOKEN: token
      }
    }
  }

  attachSession(token: string, session: BridgeSession): void {
    this.sessions.set(token, session)
  }

  forgetSession(token: string): void {
    this.sessions.delete(token)
  }

  dispose(): void {
    this.sessions.clear()
    this.server?.close()
    this.server = null
    this.url = null
  }

  private async ensureStarted(): Promise<void> {
    if (this.server && this.url) return

    const server = createServer((req, res) => {
      void this.handle(req, res).catch(err => {
        sendJson(res, 500, { error: String((err as Error)?.message ?? err) })
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })

    const addr = server.address()
    if (!addr || typeof addr === 'string') {
      server.close()
      throw new Error('Could not determine ACP bridge address')
    }

    server.unref()

    this.server = server
    this.url = `http://127.0.0.1:${addr.port}`
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/fs/read_text_file') {
      sendJson(res, 404, { error: 'not found' })
      return
    }

    const token = String(req.headers['x-pi-acp-bridge-token'] ?? '')
    const session = this.sessions.get(token)
    if (!session) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    const body = (await readBody(req)) as ReadTextFileBody | null
    const rawPath = body?.path
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      sendJson(res, 400, { error: 'path is required' })
      return
    }

    const path = isAbsolute(rawPath) ? rawPath : resolvePath(session.cwd, rawPath)
    const line = asOptionalUint(body?.line)
    const limit = asOptionalUint(body?.limit)
    const result = await this.conn.readTextFile({
      sessionId: session.sessionId,
      path,
      line,
      limit
    })

    sendJson(res, 200, { content: result.content })
  }
}
