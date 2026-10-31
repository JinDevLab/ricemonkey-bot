import { generateKeyPairSync, sign } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import * as databaseModule from '../src/db'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { getPlatformProxy } from 'wrangler'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { cancelSplit, createSplit, getSplit, markPurchased, markUploaded, unfinished } from '../src/db'
import { buildSplit } from '../src/input'
import type { APIChatInputApplicationCommandInteraction } from 'discord-api-types/v10'
import { parsePercent, splitErrorMessages } from '../src/input'
import { commands, registrationCommands } from '../src/commands'
import { escapeItemName, listingMoney, money, renderHistory, renderSplit, renderUnfinished } from '../src/render'

const keys = generateKeyPairSync('ed25519')
const publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex')
let platform: Awaited<ReturnType<typeof getPlatformProxy>>
let db: D1Database
const distributor = '100'
const first = '200'
const second = '300'
let background: Promise<unknown>[] = []

beforeAll(async () => {
  platform = await getPlatformProxy({ persist: false, envFiles: ['test/.no-secrets.env'] })
  db = (platform.env as { DB: D1Database }).DB
  for (const migration of ['0001_init.sql', '0002_item_name.sql']) {
    const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8')
    for (const statement of sql.split(';').filter((s) => s.trim())) await db.prepare(statement).run()
    if (migration === '0001_init.sql') {
      const legacy = buildSplit(command() as unknown as APIChatInputApplicationCommandInteraction)
      legacy.split.id = 'legacy'
      legacy.members[0].split_id = 'legacy'
      legacy.members[0].status = 'uploaded'
      await createSplit(db, legacy)
    }
  }
  const migrated = (await getSplit(db, 'legacy', 'guild'))!
  expect(migrated.members[0]).toMatchObject({ status: 'uploaded', item_name: null })
  expect(renderSplit(migrated).embeds![0].description).toContain('아이템 미입력')
}, 60000)
afterAll(async () => { await platform?.dispose() })
beforeEach(async () => {
  await db.batch([db.prepare('DELETE FROM split_members'), db.prepare('DELETE FROM splits')])
  background = []
})
afterEach(async () => { await Promise.all(background); vi.restoreAllMocks(); vi.unstubAllGlobals() })

type Options = Record<string, string | number | undefined>
function command(name = '분배', options: Options = { 총판매금액: 100000000, 수수료: 5, 파티원1: first }, user = distributor, guild = 'guild') {
  const users: Record<string, { id: string; username: string; global_name?: string; bot?: boolean }> = {
    [first]: { id: first, username: '첫째', global_name: '첫 글로벌' },
    [second]: { id: second, username: '둘째' },
    [distributor]: { id: distributor, username: '분배자' },
  }
  return {
    id: 'interaction', application_id: 'app', token: 'fake-token', version: 1, type: 2,
    guild_id: guild, channel_id: 'channel', member: { user: { id: user } },
    data: { name, type: 1, id: 'command',
      options: Object.entries(options).map(([name, value]) => ({ name, value, type: name.includes('퍼센트') ? 3 : name.startsWith('파티원') ? 6 : 4 })),
      resolved: { users, members: { [first]: { nick: '첫 닉네임' } } },
    },
  }
}
function component(action: string, id: string, user = distributor, target?: string, guild = 'guild') {
  return { ...command('unused', {}, user, guild), type: 3, message: { id: 'message' },
    data: { component_type: 2, custom_id: `${action};${id}${target ? `;${target}` : ''}` } }
}
function modal(id: string, value = '장갑', user = first, guild = 'guild') {
  return { ...command('unused', {}, user, guild), type: 5, message: { id: 'message' },
    data: { custom_id: `item;${id}`, components: [{ type: 1, components: [{ type: 4, custom_id: 'item_name', value }] }] } }
}
async function request(payload: unknown, token = false, binding: D1Database | null = db) {
  const body = JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex')
  return app.fetch(new Request('http://localhost/', {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': signature },
  }), { DB: binding ?? undefined, DISCORD_PUBLIC_KEY: publicKey, ...(token ? { DISCORD_TOKEN: 'fake-bot-token' } : {}) }, {
    waitUntil: (promise) => { background.push(promise) }, passThroughOnException() {},
  })
}
async function json(payload: unknown, token = false) { return (await request(payload, token)).json() as Promise<any> }
async function create(options?: Options) {
  const response = await json(command('분배', options))
  expect(response.type).toBe(4)
  expect(response.data.flags).toBeUndefined()
  return response.data.components[0].components[0].custom_id.split(';')[1] as string
}
async function ephemeral(payload: unknown, message?: string) {
  const response = await json(payload)
  expect(response.type).toBe(4)
  expect(response.data.flags).toBe(64)
  if (message) expect(response.data.content).toBe(message)
  expect(response.data.components).toBeUndefined()
  return response.data
}
async function redraw(payload: unknown) {
  const response = await json(payload)
  expect(response.type).toBe(7)
  expect(response.data.flags).toBeUndefined()
  return response.data
}
const defaults = { 총판매금액: 100000000, 수수료: 5, 파티원1: first }

describe('command definitions and percent parser', () => {
  it('omits global-only fields for guild registration without mutating definitions', () => {
    const guild = registrationCommands('guild')
    expect(guild).toHaveLength(3)
    for (const item of guild) {
      expect(item).not.toHaveProperty('contexts')
      expect(item).not.toHaveProperty('integration_types')
    }
    expect(guild[0].options).toEqual(commands[0].options)
    expect(registrationCommands()).toEqual(commands)
    expect(commands[0].contexts).toEqual([0])
  })
  it('reports registration HTTP errors without printing the request token', () => {
    const script = `process.env.DISCORD_APPLICATION_ID='test-app'; process.env.DISCORD_TOKEN='private-register-token';
      process.env.DISCORD_GUILD_ID='test-guild';
      globalThis.fetch=async (_url, init)=>{
        const commands=JSON.parse(init.body);
        if(commands.some(c=>'contexts' in c || 'integration_types' in c)) throw Error('global-only fields');
        return new Response(JSON.stringify({code:50035,message:'invalid private-register-token',errors:{name:{_errors:[{message:'bad name'}]}}}),{status:400});
      }; await import('./scripts/register.ts');`
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('HTTP 400')
    expect(result.stderr).toContain('50035: invalid')
    expect(result.stderr).toContain('name: bad name')
    expect(result.stderr).not.toContain('private-register-token')
  })
  it('uses valid Korean names and guild-only registration', () => {
    const regex = /^[-_ʼ\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u
    for (const command of commands) {
      expect(regex.test(command.name)).toBe(true)
      expect(command.contexts).toEqual([0])
      expect(command.integration_types).toEqual([0])
      for (const option of command.options ?? []) expect(regex.test(option.name)).toBe(true)
    }
    expect(commands[0].options?.filter((o) => o.required).map((o) => o.name)).toEqual(['총판매금액', '수수료', '파티원1'])
    expect(Object.keys(splitErrorMessages)).toHaveLength(7)
  })
  it.each([['0', 0], ['0.01', 1], ['1.1', 110], ['99.99', 9999], ['100.00', 10000], ['000.1', 10], [undefined, undefined]])('parses %s exactly', (value, expected) => {
    expect(parsePercent(value)).toBe(expected)
  })
  it.each(['100.01', '101', '1.001', '-1', '+1', '.1', '1.', ' 1', '1 ', '1e2', '1,0', '１００', '', '0000', 10, null])('rejects percent %s', (value) => {
    expect(() => parsePercent(value)).toThrow('퍼센트')
  })
})

describe('creation and validation against local D1', () => {
  it.each([
    [5, 1, {}, 95000000, 48223350, 46776650, 46776649],
    [3, 1, {}, 97000000, 49238578, 47761422, 47761420],
    [5, 2, {}, 95000000, 31986531, 31026938, 31026935],
    [5, 5, {}, 95000000, 15912897, 15435515, 15435510],
    [5, 3, { 분배자퍼센트: '40' }, 95000000, 19230769, 37307693, 18653845],
    [3, 1, { 분배자퍼센트: '60', 파티원1퍼센트: '40' }, 97000000, 39511201, 57488799, 38325864],
  ])('persists domain example fee=%s members=%s', async (fee, count, percentages, net, listing, final, receipt) => {
    const payload = command('분배', { 총판매금액: 100000000, 수수료: fee, ...percentages })
    for (let i = 1; i <= count; i++) {
      const id = String(1000 + i)
      payload.data.options.push({ name: `파티원${i}`, value: id, type: 6 })
      payload.data.resolved.users[id] = { id, username: `파티원${i}` }
    }
    const result = await json(payload)
    const id = result.data.components[0].components[0].custom_id.split(';')[1]
    const stored = (await getSplit(db, id, 'guild'))!
    expect(stored.split.net_sale).toBe(net)
    expect(stored.split.distributor_final).toBe(final)
    expect(stored.members).toHaveLength(count)
    expect(stored.members.every((m) => m.listing_amount === listing && m.expected_receipt === receipt)).toBe(true)
    expect(stored.split.distributor_percent_hundredths).toBe('분배자퍼센트' in percentages ? Number(percentages.분배자퍼센트) * 100 : null)
    expect(result.data.allowed_mentions.users).toHaveLength(count)
    expect(result.data.embeds[0].description).toContain('1억0000만0000 메소')
  })
  it('keeps skipped member slots in numeric input order and uses display-name fallbacks', async () => {
    const id = await create({ ...defaults, 파티원5: second })
    const stored = (await getSplit(db, id, 'guild'))!
    expect(stored.members.map((m) => [m.user_id, m.display_name, m.position])).toEqual([[first, '첫 닉네임', 0], [second, '둘째', 1]])
    const payload = command()
    delete (payload.data.resolved.members[first] as { nick?: string }).nick
    const response = await json(payload)
    expect(response.data.components[1].components[0].label).toContain('첫 글로벌')
  })
  it('excludes 0% members from mentions, buttons and completion', async () => {
    const id = await create({ ...defaults, 분배자퍼센트: '50', 파티원1퍼센트: '50', 파티원2: second, 파티원2퍼센트: '0' })
    const stored = (await getSplit(db, id, 'guild'))!
    expect(stored.members[1]).toMatchObject({ status: 'excluded', listing_amount: 0, expected_receipt: 0, percent_hundredths: 0 })
    expect(stored.split).toMatchObject({ net_sale: 95000000, distributor_final: 46776650 })
    expect(stored.members[0]).toMatchObject({ listing_amount: 48223350, expected_receipt: 46776649 })
    expect(renderSplit(stored).allowed_mentions?.users).toEqual([first])
    const rendered = renderSplit(stored)
    expect(rendered.content).not.toContain(`<@${second}>`)
    expect(rendered.allowed_mentions?.users).toEqual([first])
    expect(rendered.components?.[1]).toMatchObject({ components: [{ custom_id: `purchased;${id};${first}` }] })
    await ephemeral(component('uploaded', id, second), '분배받는 파티원 본인만 아이템을 등록할 수 있어요.')
    await redraw(component('purchased', id, distributor, second))
    expect((await getSplit(db, id, 'guild'))?.members[1].status).toBe('excluded')
    const result = await json(component('purchased', id, distributor, first))
    expect(result.data.embeds[0].title).toContain('✅')
    expect(result.data.components).toEqual([])
    expect((await getSplit(db, id, 'guild'))?.split.status).toBe('completed')
    await redraw(component('cancel', id))
  })
  it.each([
    { 총판매금액: 0 }, { 총판매금액: -1 }, { 총판매금액: 1.5 }, { 총판매금액: Number.MAX_SAFE_INTEGER + 1 },
    { 총판매금액: '1,000' }, { 수수료: 4 }, { 파티원2: first }, { 파티원1: distributor },
    { 파티원2퍼센트: '10' }, { 분배자퍼센트: '100.001' },
    { 분배자퍼센트: '50', 파티원1퍼센트: '40' }, { 분배자퍼센트: '100' },
    { 분배자퍼센트: '100', 파티원1퍼센트: '0' }, { 총판매금액: 1 },
  ])('rejects invalid input %j without writing', async (changes) => {
    await ephemeral(command('분배', { ...defaults, ...changes }))
    expect((await db.prepare('SELECT COUNT(*) AS n FROM splits').first<{ n: number }>())?.n).toBe(0)
  })
  it('rejects bots, unresolved members, no members and direct messages', async () => {
    const bot = command()
    Object.assign(bot.data.resolved.users[first], { bot: true })
    expect((await ephemeral(bot)).content).toContain('봇')
    const unresolved = command()
    delete unresolved.data.resolved.users[first]
    await ephemeral(unresolved)
    await ephemeral(command('분배', { 총판매금액: 100000000, 수수료: 5 }))
    const dm = command()
    delete (dm as { guild_id?: string }).guild_id
    await ephemeral(dm)
  })
  it('allows a zero-percent distributor when a member receives the split', async () => {
    const id = await create({ ...defaults, 분배자퍼센트: '0', 파티원1퍼센트: '100' })
    const stored = (await getSplit(db, id, 'guild'))!
    expect(stored.split.distributor_final).toBe(0)
    expect(stored.members[0].listing_amount).toBe(95000000)
  })
  it('accepts the safe-integer maximum and stores integer amounts', async () => {
    const id = await create({ ...defaults, 총판매금액: Number.MAX_SAFE_INTEGER })
    const stored = (await getSplit(db, id, 'guild'))!
    expect(stored.split.total_sale).toBe(Number.MAX_SAFE_INTEGER)
    expect(Number.isSafeInteger(stored.members[0].listing_amount)).toBe(true)
  })
  it('rolls back a failed batch creation atomically', async () => {
    const stored = buildSplit(command('분배', { ...defaults, 파티원2: second }) as unknown as APIChatInputApplicationCommandInteraction)
    stored.members[1].listing_amount = -1
    await expect(createSplit(db, stored)).rejects.toThrow()
    expect(await getSplit(db, stored.split.id, 'guild')).toBeNull()
    expect((await db.prepare('SELECT COUNT(*) AS n FROM split_members').first<{ n: number }>())?.n).toBe(0)
  })
})

describe('review regressions', () => {
  it.each(['50%', '50.00%', '0%'])('allows a single trailing percent sign: %s', (value) => {
    expect(parsePercent(value)).toBe(Number(value.slice(0, -1)) * 100)
  })
  it.each(['50%%', '%50', '50% ', '100.01%'])('rejects malformed percent: %s', (value) => {
    expect(() => parsePercent(value)).toThrow('퍼센트')
  })
  it.each(['zz', 'abc', '00', '', 'g'.repeat(128)])('returns 401 for malformed signatures: %s', async (signature) => {
    // Malformed input must be rejected before the library's key import / hex decoder runs.
    for (const key of [publicKey, '']) {
      const response = await app.fetch(new Request('http://localhost/', { method: 'POST', body: '{"type":1}',
        headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': '1' } }), { DISCORD_PUBLIC_KEY: key })
      expect(response.status).toBe(401)
    }
  })
  it('keeps direct stale DB calls from changing terminal splits or crossing authorization', async () => {
    const id = await create({ ...defaults, 파티원2: second })
    expect(await markUploaded(db, id, 'other', first, '장갑')).toBe(false)
    expect(await markPurchased(db, id, 'guild', first, second)).toEqual({ changed: false, completed: false })
    await cancelSplit(db, id, 'guild', distributor)
    const before = await getSplit(db, id, 'guild')
    expect(await markUploaded(db, id, 'guild', first, '장갑')).toBe(false)
    expect(await markPurchased(db, id, 'guild', distributor, second)).toEqual({ changed: false, completed: false })
    expect(await cancelSplit(db, id, 'guild', distributor)).toBe(false)
    expect(await getSplit(db, id, 'guild')).toEqual(before)
    const completedId = await create()
    await markPurchased(db, completedId, 'guild', distributor, first)
    expect(await cancelSplit(db, completedId, 'guild', distributor)).toBe(false)
    expect((await getSplit(db, completedId, 'guild'))?.split.status).toBe('completed')
  })
  it('redraws authorized stale clicks but never edits for unauthorized users, even after completion', async () => {
    const id = await create()
    await json(modal(id))
    expect(await json(component('uploaded', id, first))).toMatchObject({ type: 9, data: { custom_id: `item;${id}` } })
    await json(component('purchased', id, distributor, first))
    const upload = vi.spyOn(databaseModule, 'markUploaded')
    const purchase = vi.spyOn(databaseModule, 'markPurchased')
    const cancel = vi.spyOn(databaseModule, 'cancelSplit')
    for (const payload of [component('uploaded', id, first), component('purchased', id, distributor, first), component('cancel', id)]) {
      expect(await json(payload)).toMatchObject({ type: 7, data: { embeds: [{ title: '✅ 분배 완료' }], components: [] } })
    }
    for (const payload of [component('uploaded', id, second), component('cancel', id, first), component('purchased', id, first, first)]) {
      const result = await ephemeral(payload)
      expect(result.content).toContain(payload.data.custom_id.startsWith('uploaded') ? '파티원 본인만' : '분배자만')
      expect(result.components).toBeUndefined()
    }
    expect(upload.mock.calls.length).toBe(0)
    expect(purchase.mock.calls.length).toBe(0)
    expect(cancel.mock.calls.length).toBe(0)
  })
  it('shows ten oldest unfinished rows with overflow, participants, channel and local Discord dates, never UUIDs', async () => {
    const ids: string[] = []
    for (let i = 0; i < 12; i++) {
      const id = await create()
      ids.push(id)
      await db.prepare('UPDATE splits SET created_at = ?, channel_id = ? WHERE id = ?')
        .bind(`2026-10-${String(i + 1).padStart(2, '0')}T23:30:00Z`, `channel-${i}`, id).run()
    }
    const rows = await unfinished(db, 'guild', first)
    expect(rows.upload).toHaveLength(11)
    expect(rows.upload.map((r) => r.id)).toEqual(ids.slice(0, 11))
    for (const [user, index, mention] of [[first, 0, distributor], [distributor, 1, first]] as const) {
      const result = await ephemeral(command('미완료', {}, user))
      const text = result.embeds[index].description
      expect(text.match(/<#channel-/g)).toHaveLength(10)
      expect(text).toContain('더 있어요')
      expect(text).toContain(`<@${mention}>`)
      expect(text).toContain('경매장 등록가: **4822만3350 메소** (48223350)')
      expect(text).toContain(`<t:${Date.parse('2026-10-01T23:30:00Z') / 1000}:d>`)
      expect(text).not.toContain('<#channel-10>')
      expect(text).not.toContain(ids[0])
      expect(result.embeds[index].title).toBe(index === 0 ? '📦 내가 등록해야 하는 건' : '🛒 내가 구매해야 하는 건')
    }
    const history = await ephemeral(command('내역', {}, first))
    expect(history.embeds[0].description).toContain(`<t:${Date.parse('2026-10-12T23:30:00Z') / 1000}:d>`)
    await db.prepare('DELETE FROM split_members WHERE split_id IN (?, ?)').bind(ids[10], ids[11]).run()
    expect((await ephemeral(command('미완료', {}, first))).embeds[0].description).not.toContain('더 있어요')
  })
  it('only reacts after the last purchase in a two-member split', async () => {
    const id = await create({ ...defaults, 파티원2: second })
    const fetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    await json(component('purchased', id, distributor, first), true)
    await Promise.all(background)
    expect(fetch).not.toHaveBeenCalled()
    await json(component('purchased', id, distributor, second), true)
    await Promise.all(background)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('logs sanitized handler error name and message without either token or request URL', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = { prepare: () => { throw new TypeError('failure fake-token fake-bot-token DISCORD_TOKEN https://private.invalid/secret') } } as unknown as D1Database
    await request(command('미완료', {}), true, broken)
    const text = JSON.stringify(log.mock.calls)
    expect(text).toContain('TypeError')
    expect(text).toContain('failure')
    for (const secret of ['fake-token', 'fake-bot-token', 'DISCORD_TOKEN', 'https://private.invalid/secret']) expect(text).not.toContain(secret)
  })
})

describe('buttons, concurrency and queries', () => {
  it('restricts upload to the member and purchase/cancel to the distributor', async () => {
    const id = await create()
    await ephemeral(component('uploaded', id, distributor), '분배받는 파티원 본인만 아이템을 등록할 수 있어요.')
    await ephemeral(component('uploaded', id, second), '분배받는 파티원 본인만 아이템을 등록할 수 있어요.')
    await ephemeral(component('purchased', id, first, first), '분배자만 이 버튼을 누를 수 있어요.')
    await ephemeral(component('cancel', id, first), '분배자만 이 버튼을 누를 수 있어요.')
    expect((await getSplit(db, id, 'guild'))?.members[0].status).toBe('pending')
    const opened = await json(component('uploaded', id, first))
    expect(opened.type).toBe(9)
    const response = await json(modal(id))
    expect(response.type).toBe(7)
    expect(response.data.embeds[0].description).toContain('등록 완료')
    expect(response.data.allowed_mentions.users).toEqual([first])
    expect((await json(component('uploaded', id, first))).type).toBe(9)
    expect((await getSplit(db, id, 'guild'))?.members[0].uploaded_at).not.toBeNull()
  })
  it('purchases without upload, disables a purchased button and rejects duplicates', async () => {
    const id = await create({ ...defaults, 파티원2: second })
    const response = await json(component('purchased', id, distributor, first))
    expect(response.type).toBe(7)
    expect(response.data.components[1].components[0].disabled).toBe(true)
    await redraw(component('purchased', id, distributor, first))
    const completed = await json(component('purchased', id, distributor, second))
    expect(completed.data.components).toEqual([])
    const stored = (await getSplit(db, id, 'guild'))!
    expect(stored.split.status).toBe('completed')
    expect(stored.split.completed_at).not.toBeNull()
    expect(stored.members.every((m) => m.purchased_at !== null)).toBe(true)
    await redraw(component('cancel', id))
    await redraw(component('uploaded', id, first))
  })
  it('cancels without deleting or reverting prior purchases', async () => {
    const id = await create({ ...defaults, 파티원2: second })
    await json(component('purchased', id, distributor, first))
    const response = await json(component('cancel', id))
    expect(response.data.embeds[0].description).toContain('이미 구매한 건은 봇이 되돌리지 못해요')
    expect(response.data.components).toEqual([])
    const stored = (await getSplit(db, id, 'guild'))!
    expect(stored.split.status).toBe('canceled')
    expect(stored.split.canceled_at).not.toBeNull()
    expect(stored.members[0].status).toBe('purchased')
    await redraw(component('purchased', id, distributor, second))
    await redraw(component('uploaded', id, second))
    await redraw(component('cancel', id))
  })
  it('does not lose changes from concurrent purchases', async () => {
    const id = await create({ ...defaults, 파티원2: second })
    const results = await Promise.all([json(component('purchased', id, distributor, first)), json(component('purchased', id, distributor, second))])
    expect(results.every((r) => r.type === 7)).toBe(true)
    const stored = (await getSplit(db, id, 'guild'))!
    expect(stored.split.status).toBe('completed')
    expect(stored.members.every((m) => m.status === 'purchased')).toBe(true)
  })
  it('handles concurrent duplicate uploads and upload/purchase races', async () => {
    const id = await create()
    const results = await Promise.all([json(modal(id)), json(modal(id))])
    expect(results.map((r) => r.type)).toEqual([7, 7])
    await Promise.all([json(modal(id)), json(component('purchased', id, distributor, first))])
    expect((await getSplit(db, id, 'guild'))?.split.status).toBe('completed')
  })
  it('keeps cancel/purchase races terminal and consistent', async () => {
    const id = await create()
    await Promise.all([json(component('cancel', id)), json(component('purchased', id, distributor, first))])
    const stored = (await getSplit(db, id, 'guild'))!
    expect(['canceled', 'completed']).toContain(stored.split.status)
    if (stored.split.status === 'completed') expect(stored.members[0].status).toBe('purchased')
    await redraw(component('uploaded', id, first))
  })
  it('refuses cross-guild and malformed button references', async () => {
    const id = await create()
    await ephemeral(component('uploaded', id, first, undefined, 'other'))
    await ephemeral(component('purchased', id))
    await ephemeral(component('uploaded', `${id};extra`, first))
    await redraw(component('purchased', id, distributor, 'unknown'))
    expect((await getSplit(db, id, 'guild'))?.split.status).toBe('active')
  })
  it('shows personal pending queues and history shares only in the current guild', async () => {
    const id = await create()
    const memberPending = await ephemeral(command('미완료', {}, first))
    expect(memberPending.embeds[0].description).toContain('**4822만3350 메소** (48223350)')
    expect(memberPending.allowed_mentions).toEqual({ parse: [], users: [] })
    const ownPending = await ephemeral(command('미완료', {}))
    expect(ownPending.embeds[1].description).toContain(`<@${first}>`)
    expect((await ephemeral(command('미완료', {}, first, 'other'))).embeds[0].description).toBe('없어요.')
    expect((await ephemeral(command('내역', {}, first))).embeds[0].description).toContain('4677만6649 메소')
    expect((await ephemeral(command('내역', {}))).embeds[0].description).toContain('4677만6650 메소')
    expect((await ephemeral(command('내역', {}, first, 'other'))).embeds[0].description).toBe('참여한 분배가 없어요.')
    await json(modal(id))
    expect((await ephemeral(command('미완료', {}, first))).embeds[0].description).toBe('없어요.')
    expect((await ephemeral(command('미완료', {}))).embeds[1].description).toContain('등록 완료')
    expect((await ephemeral(command('미완료', {}))).embeds[1].description).toContain('**장갑**')
    await json(component('cancel', id))
    expect((await ephemeral(command('미완료', {}))).embeds[1].description).toBe('없어요.')
    expect((await ephemeral(command('내역', {}))).embeds[0].description).toContain('취소')
  })
  it('limits history to ten recent records and truncates long labels', async () => {
    for (let i = 0; i < 11; i++) {
      const id = await create()
      await db.prepare('UPDATE splits SET created_at = ? WHERE id = ?').bind(`2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`, id).run()
    }
    const response = await ephemeral(command('내역', {}))
    expect(response.embeds[0].description.split('\n\n')).toHaveLength(10)
    expect(response.embeds[0].description).toMatch(new RegExp(`^<t:${Date.parse('2026-10-11T00:00:00Z') / 1000}:d>`))
    expect(response.embeds[0].description).not.toContain(`<t:${Date.parse('2026-10-01T00:00:00Z') / 1000}:d>`)
    const payload = command()
    payload.data.resolved.members[first].nick = '가'.repeat(100)
    const result = await json(payload)
    expect(Array.from(result.data.components[1].components[0].label)).toHaveLength(80)
  })
})

describe('message amount formatting', () => {
  it.each([
    [240000000, '2억4000만0000 메소'],
    [246192893, '2억4619만2893 메소'],
    [240050000, '2억4005만0000 메소'],
    [200050000, '2억0005만0000 메소'],
    [1000000000, '10억0000만0000 메소'],
    [500000000, '5억0000만0000 메소'],
    [40000000, '4000만0000 메소'],
    [12345, '1만2345 메소'], [1234, '1234 메소'], [0, '0 메소'],
    [9007199254740991, '90071992억5474만0991 메소'],
  ])('preserves every digit of %s', (value, expected) => {
    expect(money(value)).toBe(expected)
    expect(listingMoney(value)).toBe(`**${expected}** (${value})`)
    expect(listingMoney(value).match(/\((\d+)\)$/)?.[1]).toBe(String(value))
  })
  it.each(['pending', 'uploaded', 'purchased', 'canceled'] as const)('renders the entire %s description', (state) => {
    const stored = buildSplit(command('분배', { 총판매금액: 500000000, 수수료: 3, 파티원1: first }) as unknown as APIChatInputApplicationCommandInteraction)
    if (state === 'canceled') stored.split.status = 'canceled'
    else stored.members[0].status = state
    if (state === 'uploaded' || state === 'purchased') stored.members[0].item_name = '*장갑*'
    const status = state === 'uploaded' ? '📦 등록 완료' : state === 'purchased' ? '✅ 구매 완료' : '⏳ 대기'
    const description = renderSplit(stored).embeds![0].description!
    expect(description).toBe([
      '아이템 판매액: 5억0000만0000 메소',
      '실수령액: 4억8500만0000 메소',
      '경매장 수수료: 3%', '',
      '분배자 <@100>', '실수령액: 2억3880만7107 메소', '',
      `<@200> · ${status}`,
      ...(state === 'uploaded' || state === 'purchased' ? ['아이템: \\*장갑\\*'] : []),
      '경매장 등록가: **2억4619만2893 메소** (246192893)',
      '실수령액: 2억3880만7106 메소',
      ...(state === 'canceled' ? ['', '이미 구매한 건은 봇이 되돌리지 못해요.'] : []),
    ].join('\n'))
    expect(description.match(/경매장 등록가: \*\*[^\n]+\*\* \((\d+)\)/)?.[1]).toBe(String(stored.members[0].listing_amount))
  })
  it('renders both unfinished queues and history with exact line order', () => {
    const stored = buildSplit(command('분배', { 총판매금액: 500000000, 수수료: 3, 파티원1: first }) as unknown as APIChatInputApplicationCommandInteraction)
    const created_at = '2026-10-01T00:00:00Z'
    const timestamp = `<t:${Date.parse(created_at) / 1000}:d>`
    const pending = { ...stored.members[0], ...stored.split, user_id: first, status: 'uploaded' as const, item_name: '장갑', created_at }
    const queues = renderUnfinished({ upload: [pending], purchase: [pending] })
    expect(queues.embeds![0].description).toBe(`<@100> · 경매장 등록가: **2억4619만2893 메소** (246192893)\n<#channel> · ${timestamp}`)
    expect(queues.embeds![1].description).toBe(`<@200> · 📦 등록 완료\n아이템: **장갑**\n경매장 등록가: **2억4619만2893 메소** (246192893)\n<#channel> · ${timestamp}`)
    for (const embed of queues.embeds!) expect(embed.description!.match(/\((\d+)\)/)?.[1]).toBe(String(pending.listing_amount))
    expect(renderHistory([{ ...stored.split, created_at, my_share: stored.members[0].expected_receipt }]).embeds![0].description)
      .toBe(`${timestamp} · 분배자 <@100>\n아이템 판매액: 5억0000만0000 메소\n내 실수령액: 2억3880만7106 메소 · 🔵 진행 중`)
    expect(splitErrorMessages.AMOUNT_TOO_SMALL).toBe('판매금액이 너무 작아서 받을 몫이 있는 파티원의 경매장 등록가가 0메소예요.')
  })
})

describe('item registration and embed cards', () => {
  it('opens a required short modal, saves normalized input and prefills edits without changing the first timestamp', async () => {
    const id = await create()
    const open = await json(component('uploaded', id, first))
    expect(open).toMatchObject({ type: 9, data: { custom_id: `item;${id}`, title: '아이템 등록', components: [{ type: 1, components: [{ custom_id: 'item_name', label: '등록한 아이템', style: 1, required: true, max_length: 100 }] }] } })
    expect(open.data.components[0].components[0].value).toBeUndefined()
    expect((await getSplit(db, id, 'guild'))!.members[0]).toMatchObject({ status: 'pending', item_name: null })
    const saved = await json(modal(id, '  장갑\r\n이름  '))
    expect(saved.type).toBe(7)
    expect(saved.data.embeds[0].description).toContain('아이템: 장갑 이름')
    const original = (await getSplit(db, id, 'guild'))!.members[0]
    expect(original).toMatchObject({ status: 'uploaded', item_name: '장갑 이름' })
    expect(original.uploaded_at).not.toBeNull()
    const reopened = await json(component('uploaded', id, first))
    expect(reopened.data.components[0].components[0].value).toBe('장갑 이름')
    await db.prepare('UPDATE split_members SET uploaded_at = ? WHERE split_id = ?').bind('2020-01-01T00:00:00Z', id).run()
    await redraw(modal(id, '새 장갑'))
    expect((await getSplit(db, id, 'guild'))!.members[0]).toMatchObject({ item_name: '새 장갑', uploaded_at: '2020-01-01T00:00:00Z' })
  })
  it.each(['', '   ', '\r\n\t', '가'.repeat(101)])('rejects empty or oversized modal input %j', async (value) => {
    const id = await create()
    await ephemeral(modal(id, value), '등록한 아이템을 1~100자로 입력해 주세요.')
    expect((await getSplit(db, id, 'guild'))!.members[0]).toMatchObject({ status: 'pending', item_name: null, uploaded_at: null })
  })
  it('rechecks modal authorization including forged, zero-percent, distributor and cross-guild submissions', async () => {
    const id = await create({ ...defaults, 파티원2: second, 파티원2퍼센트: '0' })
    await json(component('uploaded', id, first))
    for (const user of [second, distributor, '999']) {
      await ephemeral(modal(id, '위조', user), '분배받는 파티원 본인만 아이템을 등록할 수 있어요.')
    }
    await ephemeral(modal(id, '위조', first, 'other'), '분배를 찾을 수 없어요.')
    const noMessage = modal(id)
    delete (noMessage as { message?: unknown }).message
    await ephemeral(noMessage)
    await ephemeral(modal(`${id};extra`))
    expect((await getSplit(db, id, 'guild'))!.members.every((m) => m.item_name === null)).toBe(true)
  })
  it.each(['canceled', 'completed', 'purchased'] as const)('redraws without saving when %s after opening the modal', async (state) => {
    const id = await create({ ...defaults, 파티원2: second })
    await json(component('uploaded', id, first))
    if (state === 'canceled') await cancelSplit(db, id, 'guild', distributor)
    else {
      await markPurchased(db, id, 'guild', distributor, first)
      if (state === 'completed') await markPurchased(db, id, 'guild', distributor, second)
    }
    const before = await getSplit(db, id, 'guild')
    await redraw(modal(id, '늦은 입력'))
    await redraw(component('uploaded', id, first))
    expect(await getSplit(db, id, 'guild')).toEqual(before)
    // The SQL guard must also reject a direct stale write, independently of the handler guard.
    expect(await markUploaded(db, id, 'guild', first, '직접 입력')).toBe(false)
    expect(await getSplit(db, id, 'guild')).toEqual(before)
  })
  it('escapes formatting and mention/link syntax everywhere while preserving the database value', async () => {
    const id = await create()
    const name = '\\ * _ ~ ` | > # - [링크](https://x) <@123> @everyone'
    const escaped = escapeItemName(name)
    for (const char of ['\\', '*', '_', '~', '`', '|', '>', '#', '-', '[', ']', '<', '@']) expect(escapeItemName(char)).toBe(`\\${char}`)
    const response = await redraw(modal(id, name))
    expect(response.embeds[0].description).toContain(`아이템: ${escaped}`)
    expect(response.embeds[0].description).not.toContain('<@123>')
    expect(response.embeds[0].description).toContain('\\@everyone')
    expect(response.allowed_mentions).toEqual({ parse: [], users: [first] })
    expect((await getSplit(db, id, 'guild'))!.members[0].item_name).toBe(name)
    const queue = await ephemeral(command('미완료', {}))
    expect(queue.embeds[1].description).toContain(`**${escaped}**`)
    expect(queue.allowed_mentions).toEqual({ parse: [], users: [] })
  })
  it('renders old uploaded NULL rows and all card statuses with mention-only content', async () => {
    const id = await create()
    await db.prepare("UPDATE split_members SET status = 'uploaded' WHERE split_id = ?").bind(id).run()
    const stored = (await getSplit(db, id, 'guild'))!
    expect(stored.members[0].item_name).toBeNull()
    const active = renderSplit(stored)
    expect(active.content).toBe(`<@${first}>`)
    expect(active.embeds![0]).toMatchObject({ title: '💰 분배 진행 중 (0/1 구매 완료)', color: 0x5865F2 })
    expect(active.embeds![0].description).toContain('아이템 미입력')
    expect((await ephemeral(command('미완료', {}))).embeds[1].description).toContain('아이템 미입력')
    expect(active.components![0]).toMatchObject({ components: [{ label: '아이템 등록', custom_id: `uploaded;${id}` }] })
    for (const [state, title, color] of [['completed', '✅ 분배 완료', 0x57F287], ['canceled', '🚫 분배 취소', 0x99AAB5]] as const) {
      stored.split.status = state
      const card = renderSplit(stored)
      expect(card.embeds![0]).toMatchObject({ title, color })
      expect(card.components).toEqual([])
    }
  })
  it('fits Discord embed limits with five members and ten worst-case escaped item names', () => {
    const stored = buildSplit(command() as unknown as APIChatInputApplicationCommandInteraction)
    stored.members = Array.from({ length: 5 }, (_, i) => ({ ...stored.members[0], user_id: '9'.repeat(19) + i, item_name: '*'.repeat(100), status: 'uploaded' }))
    stored.split.total_sale = Number.MAX_SAFE_INTEGER
    stored.split.net_sale = Number.MAX_SAFE_INTEGER
    stored.split.distributor_final = Number.MAX_SAFE_INTEGER
    for (const member of stored.members) {
      member.listing_amount = Number.MAX_SAFE_INTEGER
      member.expected_receipt = Number.MAX_SAFE_INTEGER
    }
    const pending = Array.from({ length: 11 }, (_, i) => ({ id: String(i), user_id: '9'.repeat(20), distributor_id: '8'.repeat(20), channel_id: '7'.repeat(20), listing_amount: Number.MAX_SAFE_INTEGER, item_name: '*'.repeat(100), status: 'uploaded' as const, created_at: stored.split.created_at }))
    const cards = [renderSplit(stored), renderUnfinished({ upload: pending, purchase: pending })]
    for (const card of cards) {
      let total = 0
      for (const embed of card.embeds!) {
        expect(embed.title!.length).toBeLessThanOrEqual(256)
        expect(embed.description!.length).toBeLessThanOrEqual(4096)
        total += embed.title!.length + embed.description!.length
      }
      expect(total).toBeLessThanOrEqual(6000)
    }
  })
  it('notifies edits with escaped names and only mentions the distributor', async () => {
    const id = await create()
    await json(modal(id))
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { calls.push(JSON.parse(init.body as string)); return new Response('{}') }))
    expect((await request(modal(id, '<@123>'), true)).status).toBe(202)
    await Promise.all(background)
    expect(calls[1]).toEqual({ content: `<@${distributor}> <@${first}>님이 아이템을 **${escapeItemName('<@123>')}**(으)로 수정했어요 · 경매장 등록가: **4822만3350 메소** (48223350)`, allowed_mentions: { parse: [], users: [distributor] } })
  })
})

describe('callback transport and best-effort notifications', () => {
  it('uses type 7 without a token and makes no external request', async () => {
    const id = await create()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect((await json(modal(id))).type).toBe(7)
    expect((await json(component('purchased', id, distributor, first))).data.embeds[0].title).toContain('✅')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('returns empty 202 and sends callback before distributor notification', async () => {
    const id = await create()
    const calls: { url: string; body: any }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) })
      return new Response('{}', { status: 200 })
    }))
    const response = await request(modal(id), true)
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
    await Promise.all(background)
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('/interactions/interaction/fake-token/callback?with_response=true')
    expect(calls[0].body.type).toBe(7)
    expect(calls[1].url).toContain('/webhooks/app/fake-token')
    expect(calls[1].body.allowed_mentions).toEqual({ parse: [], users: [distributor] })
    expect(calls[1].body.content).toBe(`<@${distributor}> <@${first}>님이 **장갑** 등록했어요 · 경매장 등록가: **4822만3350 메소** (48223350)`)
    expect(calls[1].body.content.match(/경매장 등록가: \*\*[^\n]+\*\* \((\d+)\)$/)?.[1])
      .toBe(String((await getSplit(db, id, 'guild'))!.members[0].listing_amount))
    expect(calls[1].body.content).not.toContain(id)
  })
  it.each(['http', 'network'])('preserves upload on followup %s failure', async (failure) => {
    const id = await create()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/callback')) return new Response('{}')
      if (failure === 'network') throw new Error('secret-url')
      return new Response('failure', { status: 500 })
    }))
    expect((await request(modal(id), true)).status).toBe(202)
    await Promise.all(background)
    expect((await getSplit(db, id, 'guild'))?.members[0].status).toBe('uploaded')
    expect(log).toHaveBeenCalledWith('upload notification failed', { action: 'uploaded', status: failure === 'http' ? 500 : null })
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-url')
  })
  it.each(['http', 'network'])('contains callback %s failure without notifying', async (failure) => {
    const id = await create()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetch = vi.fn(async () => {
      if (failure === 'network') throw new Error('fake-token fake-bot-token https://private.invalid/secret')
      return new Response('failure', { status: 500 })
    })
    vi.stubGlobal('fetch', fetch)
    expect((await request(modal(id), true)).status).toBe(202)
    await Promise.all(background)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('interaction callback failed', { action: 'uploaded', status: failure === 'http' ? 500 : null })
    for (const secret of ['fake-token', 'fake-bot-token', 'https://private.invalid/secret']) expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
    expect((await getSplit(db, id, 'guild'))?.members[0].status).toBe('uploaded')
    await markPurchased(db, id, 'guild', distributor, first)
    const repeated = await request(modal(id), true)
    expect((await repeated.json() as any).type).toBe(7)
    await Promise.all(background)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['http', 'network'])('attempts the completion reaction and keeps completion on %s failure', async (failure) => {
    const id = await create()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
      if (failure === 'network') throw new Error('private-url')
      return new Response('forbidden', { status: 403 })
    })
    vi.stubGlobal('fetch', fetch)
    const response = await json(component('purchased', id, distributor, first), true)
    expect(response.data.embeds[0].title).toContain('✅')
    await Promise.all(background)
    expect(fetch.mock.calls[0][0]).toContain('/channels/channel/messages/message/reactions/%E2%9C%85/@me')
    expect(log).toHaveBeenCalledWith('completion reaction failed', { action: 'purchased', status: failure === 'http' ? 403 : null })
    expect((await getSplit(db, id, 'guild'))?.split.status).toBe('completed')
  })
  it('turns handler exceptions into a private Korean error without sensitive logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await (await request(command('미완료', {}), false, null)).json() as any
    expect(response.data.flags).toBe(64)
    expect(response.data.content).toBe('잠시 후 다시 시도해 주세요')
    expect(log).toHaveBeenCalledWith('interaction handler failed', { name: 'Error', message: 'DB unavailable' })
  })
})
