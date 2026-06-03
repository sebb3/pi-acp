import test from 'node:test'
import assert from 'node:assert/strict'

import { AcpBridgeServer } from '../../src/acp/bridge.js'

test('AcpBridgeServer: proxies read_text_file to ACP client', async () => {
  const calls: any[] = []
  const bridge = new AcpBridgeServer({
    async readTextFile(params: any) {
      calls.push(params)
      return { content: 'editor buffer content' }
    }
  } as any)

  try {
    const prepared = await bridge.prepareSession()
    bridge.attachSession(prepared.token, { sessionId: 's1', cwd: '/tmp/project' })

    const response = await fetch(`${prepared.env.PI_ACP_BRIDGE_URL}/fs/read_text_file`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pi-acp-bridge-token': prepared.token
      },
      body: JSON.stringify({ path: 'file.txt', line: 2, limit: 3 })
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { content: 'editor buffer content' })
    assert.deepEqual(calls, [{ sessionId: 's1', path: '/tmp/project/file.txt', line: 2, limit: 3 }])
  } finally {
    bridge.dispose()
  }
})

test('AcpBridgeServer: rejects unknown tokens', async () => {
  const bridge = new AcpBridgeServer({} as any)

  try {
    const prepared = await bridge.prepareSession()
    const response = await fetch(`${prepared.env.PI_ACP_BRIDGE_URL}/fs/read_text_file`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pi-acp-bridge-token': 'wrong-token'
      },
      body: JSON.stringify({ path: '/tmp/file.txt' })
    })

    assert.equal(response.status, 401)
  } finally {
    bridge.dispose()
  }
})
