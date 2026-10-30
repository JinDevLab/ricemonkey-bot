import { generateKeyPairSync, sign } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'

// Whitespace is intentional: verification must use the original body, not reserialized JSON.
const body = '{ "type": 1 }\n'
let publicKey: string
let signature: string
let timestamp: string

beforeAll(() => {
  const keys = generateKeyPairSync('ed25519')
  publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex')
  timestamp = Math.floor(Date.now() / 1000).toString()
  signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex')
})

function ping(headers: Record<string, string> = {}, requestBody = body) {
  return app.fetch(
    new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: requestBody,
    }),
    { DISCORD_PUBLIC_KEY: publicKey },
  )
}

describe('Discord HTTP interactions', () => {
  it('returns PONG for a PING signed with the generated Ed25519 key', async () => {
    const response = await ping({
      'X-Signature-Ed25519': signature,
      'X-Signature-Timestamp': timestamp,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ type: 1 })
  })

  it('rejects a bad signature', async () => {
    const badSignature = (signature.startsWith('00') ? '01' : '00') + signature.slice(2)
    const response = await ping({
      'X-Signature-Ed25519': badSignature,
      'X-Signature-Timestamp': timestamp,
    })

    expect(response.status).toBe(401)
  })

  it.each(['both', 'signature', 'timestamp'])('rejects missing %s headers', async (missing) => {
    const headers: Record<string, string> = {}
    if (missing === 'timestamp') headers['X-Signature-Ed25519'] = signature
    if (missing === 'signature') headers['X-Signature-Timestamp'] = timestamp

    expect((await ping(headers)).status).toBe(401)
  })

  it('rejects a body changed after signing, even when the JSON is equivalent', async () => {
    const response = await ping({
      'X-Signature-Ed25519': signature,
      'X-Signature-Timestamp': timestamp,
    }, JSON.stringify({ type: 1 }))

    expect(response.status).toBe(401)
  })
})
