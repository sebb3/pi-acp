import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  async create(_params: any) {
    return this.session
  }
}

test('PiAcpAgent: quietStartup=true disables startup info generation/emission', async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR

  // Force quietStartup in pi settings by pointing PI_CODING_AGENT_DIR at a temp dir.
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-quietstartup-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ quietStartup: true }, null, 2), 'utf-8')
  process.env.PI_CODING_AGENT_DIR = dir

  // Spy on setTimeout calls (agent schedules startup info + available commands)
  const realSetTimeout = globalThis.setTimeout
  const timeouts: Array<unknown> = []
  ;(globalThis as any).setTimeout = (fn: unknown, _ms?: number) => {
    timeouts.push(fn)
    return 0 as any
  }

  try {
    const conn = new FakeAgentSideConnection()

    let setStartupInfoCalled = false
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
        },
        async getState() {
          return {
            thinkingLevel: 'medium',
            model: { provider: 'test', id: 'model' }
          }
        }
      },
      setStartupInfo(_text: string) {
        setStartupInfoCalled = true
      },
      sendStartupInfoIfPending() {
        // may be called when an update notice is available
      }
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const res = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    const startupInfo = res?._meta?.piAcp?.startupInfo ?? null

    // When quietStartup=true the full prelude is suppressed. However, an update notice
    // (if one exists) is still surfaced because it's high-signal and actionable.
    // The test must tolerate both cases since the live npm check may or may not find an update.
    if (startupInfo) {
      assert.match(startupInfo, /New version available/)
      assert.equal(setStartupInfoCalled, true)
      assert.equal(timeouts.length, 2)
    } else {
      assert.equal(setStartupInfoCalled, false)
      assert.equal(timeouts.length, 1)
    }
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})

test('PiAcpAgent: startup info does not advertise discovered skills, prompts, or extensions', async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  const prevHome = process.env.HOME

  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const root = mkdtempSync(join(tmpdir(), 'pi-acp-startupinfo-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(agentDir, 'skills', 'global-skill'), { recursive: true })
  mkdirSync(join(root, '.agents', 'skills', 'legacy-skill'), { recursive: true })
  mkdirSync(join(cwd, '.pi', 'skills', 'project-skill'), { recursive: true })
  mkdirSync(join(root, '.pi', 'agent', 'prompts'), { recursive: true })
  mkdirSync(join(root, '.pi', 'agent', 'extensions'), { recursive: true })

  writeFileSync(join(cwd, 'AGENTS.md'), '# Project context\n', 'utf-8')
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ quietStartup: false }, null, 2), 'utf-8')
  writeFileSync(join(agentDir, 'skills', 'global-skill', 'SKILL.md'), '# Global skill\n', 'utf-8')
  writeFileSync(join(root, '.agents', 'skills', 'legacy-skill', 'SKILL.md'), '# Legacy skill\n', 'utf-8')
  writeFileSync(join(cwd, '.pi', 'skills', 'project-skill', 'SKILL.md'), '# Project skill\n', 'utf-8')
  writeFileSync(join(root, '.pi', 'agent', 'prompts', 'global-prompt.md'), '# Prompt\n', 'utf-8')
  writeFileSync(join(root, '.pi', 'agent', 'extensions', 'global-extension.ts'), 'export default {}\n', 'utf-8')
  writeFileSync(
    join(root, '.pi', 'agent', 'settings.json'),
    JSON.stringify({ packages: ['npm:global-extension'] }),
    'utf-8'
  )

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.HOME = root

  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    let startupInfo = ''
    const session = {
      sessionId: 's1',
      cwd,
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
        },
        async getState() {
          return {
            thinkingLevel: 'medium',
            model: { provider: 'test', id: 'model' }
          }
        }
      },
      setStartupInfo(text: string) {
        startupInfo = text
      },
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const res = await agent.newSession({ cwd, mcpServers: [] } as any)
    startupInfo = startupInfo || res?._meta?.piAcp?.startupInfo || ''

    assert.match(startupInfo, /## Context/)
    assert.doesNotMatch(startupInfo, /## Skills/)
    assert.doesNotMatch(startupInfo, /global-skill|legacy-skill|project-skill/)
    assert.doesNotMatch(startupInfo, /## Prompts|global-prompt/)
    assert.doesNotMatch(startupInfo, /## Extensions|global-extension/)
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
    if (prevHome == null) delete process.env.HOME
    else process.env.HOME = prevHome
  }
})
