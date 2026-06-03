import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: /plan-test emits a sample ACP plan', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).getOrReviveSession = async () => ({ sessionId: 's1' })

  const response = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/plan-test' }]
  } as any)

  assert.deepEqual(response, { stopReason: 'end_turn' })
  assert.equal(conn.updates.length, 2)
  assert.deepEqual(conn.updates[0]!.update, {
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
  })
  assert.equal(conn.updates[1]!.update.sessionUpdate, 'agent_message_chunk')
})
