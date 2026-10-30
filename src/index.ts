import { DiscordHono, $webhooks$_$_, $channels$_$messages$_$reactions$_$me } from 'discord-hono'
import type { CommandContext, ComponentContext } from 'discord-hono'
import type { APIChatInputApplicationCommandInteraction } from 'discord-api-types/v10'
import { cancelSplit, createSplit, getSplit, history, markPurchased, markUploaded, unfinished } from './db'
import { buildSplit, InputError } from './input'
import { renderHistory, renderSplit, renderUnfinished } from './render'

export interface Bindings {
  DB?: D1Database
  DISCORD_PUBLIC_KEY: string
  DISCORD_TOKEN?: string
  DISCORD_APPLICATION_ID?: string
}
type Env = { Bindings: Bindings }
type Context = CommandContext<Env> | ComponentContext<Env>
const app = new DiscordHono<Env>()

function reject(c: Context, content: string) {
  if (c.interaction.type === 3) (c as ComponentContext<Env>).update(false)
  return c.flags('EPHEMERAL').res({ content, allowed_mentions: { parse: [], users: [] } })
}

function errorDetails(error: unknown, c: Context) {
  const redact = (value: string) => {
    for (const secret of [c.interaction.token, c.env.DISCORD_TOKEN, 'DISCORD_TOKEN']) {
      if (secret) value = value.split(secret).join('[redacted]')
    }
    return value.replace(/https?:\/\/\S+/gi, '[url]')
  }
  return error instanceof Error
    ? { name: redact(error.name), message: redact(error.message) }
    : { name: 'UnknownError', message: 'Unknown failure' }
}

function guarded<C extends Context>(handler: (c: C) => Promise<Response>) {
  return async (c: C) => {
    try {
      return await handler(c)
    } catch (error) {
      if (error instanceof InputError) return reject(c, error.message)
      // Do not log exception objects: upstream errors can contain interaction tokens or SQL bindings.
      console.error('interaction handler failed', errorDetails(error, c))
      return reject(c, '잠시 후 다시 시도해 주세요')
    }
  }
}

function database(c: Context) {
  if (!c.env.DB) throw new Error('DB unavailable')
  return c.env.DB
}

app.command('분배', guarded<CommandContext<Env>>(async (c) => {
  const stored = buildSplit(c.interaction as APIChatInputApplicationCommandInteraction)
  await createSplit(database(c), stored)
  return c.res(renderSplit(stored, true))
}))

for (const name of ['미완료', '내역']) {
  app.command(name, guarded<CommandContext<Env>>(async (c) => {
    const guild = c.interaction.guild_id
    const user = c.interaction.member?.user.id
    if (!guild || !user) return reject(c, '서버 안에서 사용해 주세요.')
    const data = name === '미완료'
      ? renderUnfinished(await unfinished(database(c), guild, user))
      : renderHistory(await history(database(c), guild, user))
    return c.flags('EPHEMERAL').res(data)
  }))
}

for (const action of ['uploaded', 'purchased', 'cancel'] as const) {
  app.component(action, guarded<ComponentContext<Env>>(async (c) => {
    const guild = c.interaction.guild_id
    const user = c.interaction.member?.user.id
    if (!guild || !user) return reject(c, '서버 안에서 사용해 주세요.')
    const parts = (c.ref.custom_value ?? '').split(';')
    const [id, target] = parts
    if (!id || parts.length !== (action === 'purchased' ? 2 : 1) || (action === 'purchased' && !target)) {
      return reject(c, '잘못된 분배 버튼이에요.')
    }
    const db = database(c)
    const stored = await getSplit(db, id, guild)
    if (!stored) return reject(c, '분배를 찾을 수 없어요.')
    const member = stored.members.find((m) => m.user_id === user)
    if (action === 'uploaded') {
      if (!member || member.status === 'excluded') return reject(c, '분배받는 파티원 본인만 올렸어요를 누를 수 있어요.')
    } else if (stored.split.distributor_id !== user) return reject(c, '분배자만 이 버튼을 누를 수 있어요.')
    if (stored.split.status !== 'active') return c.update().res(renderSplit(stored))
    let completed = false
    let changed = false
    if (action === 'uploaded') {
      changed = await markUploaded(db, id, guild, user)
    } else {
      if (action === 'cancel') changed = await cancelSplit(db, id, guild, user)
      else {
        const result = await markPurchased(db, id, guild, user, target)
        changed = result.changed
        completed = result.completed
      }
    }
    const latest = await getSplit(db, id, guild)
    if (!latest) throw new Error('Split disappeared')
    const data = renderSplit(latest)
    if (!changed) return c.update().res(data)
    if (completed && c.env.DISCORD_TOKEN) {
      c.executionCtx.waitUntil((async () => {
        try {
          const response = await c.rest('PUT', $channels$_$messages$_$reactions$_$me,
            [stored.split.channel_id, c.interaction.message.id, encodeURIComponent('✅')])
          if (!response.ok) console.error('completion reaction failed', { action: 'purchased', status: response.status })
        } catch {
          console.error('completion reaction failed', { action: 'purchased', status: null })
        }
      })())
    }
    if (action === 'uploaded' && c.env.DISCORD_TOKEN) {
      // discord-hono schedules this callback request with waitUntil and returns an empty HTTP 202.
      return c.update().res(data, undefined, async (response) => {
        if (!response.ok) {
          console.error('interaction callback failed', { action, status: response.status })
          return
        }
        try {
          const notification = await c.rest('POST', $webhooks$_$_,
            [c.interaction.application_id, c.interaction.token], {
              content: `<@${stored.split.distributor_id}> 파티원이 물건을 올렸어요. 분배 ${id}`,
              allowed_mentions: { parse: [], users: [stored.split.distributor_id] },
            })
          if (!notification.ok) console.error('upload notification failed', { action, status: notification.status })
        } catch {
          console.error('upload notification failed', { action, status: null })
        }
      })
    }
    return c.update().res(data)
  }))
}

// The library's callback transport has no rejection branch. Keep background failures contained
// without logging REST error objects (which can expose tokens).
const fetchInteraction = app.fetch
app.fetch = (request, env, executionCtx, option) => fetchInteraction(request, env, executionCtx ? {
  waitUntil: (promise: Promise<unknown>) => executionCtx.waitUntil(promise.catch(() => {
    console.error('background interaction request failed')
  })),
  passThroughOnException: () => executionCtx.passThroughOnException(),
} : undefined, option)

export default app
