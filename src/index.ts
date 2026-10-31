import { DiscordHono, $webhooks$_$_, $webhooks$_$_$messages$original, $channels$_$threads, $channels$_$threadmembers$_, $channels$_$messages, $channels$_$messages$_$reactions$_$me } from 'discord-hono'
import type { CommandContext, ComponentContext, ModalContext } from 'discord-hono'
import { PermissionFlagsBits, SelectMenuDefaultValueType } from 'discord-api-types/v10'
import type { APILabelComponent, APIModalInteractionResponseCallbackData } from 'discord-api-types/v10'
import { cancelSplit, consumeDraft, createSplit, deleteSplit, getDraft, getSplit, history, markPurchased, markUploaded, purgeExpired, replaceDraft, saveDraft, savePercent, unfinished } from './db'
import type { StoredSplit } from './db'
import { adjustPercent, buildSplit, InputError } from './input'
import { cardShowsMember, escapeItemName, listingMoney, money, renderHistory, renderSplit, renderUnfinished } from './render'

export interface Bindings {
  DB?: D1Database
  DISCORD_PUBLIC_KEY: string
  DISCORD_TOKEN?: string
}
type Env = { Bindings: Bindings; Variables: Record<string, unknown> }
type Context = CommandContext<Env> | ComponentContext<Env> | ModalContext<Env>
const app = new DiscordHono<Env>()

app.cron('0 18 * * *', async (c) => {
  try {
    if (!c.env.DB) throw new Error('DB unavailable')
    console.info('retention purge', await purgeExpired(c.env.DB, new Date()))
  } catch (error) {
    console.error('retention purge failed', errorDetails(error, [c.env.DISCORD_TOKEN, 'DISCORD_TOKEN']))
    throw error
  }
})

function reject(c: Context, content: string) {
  if (c.interaction.type === 3 || c.interaction.type === 5) (c as ComponentContext<Env> | ModalContext<Env>).update(false)
  return c.flags('EPHEMERAL').res({ content, allowed_mentions: { parse: [], users: [] } })
}

function errorDetails(error: unknown, secrets: (string | undefined)[]) {
  const redact = (value: string) => {
    for (const secret of secrets) {
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
      console.error('interaction handler failed', errorDetails(error, [c.interaction.token, c.env.DISCORD_TOKEN, 'DISCORD_TOKEN']))
      return reject(c, '잠시 후 다시 시도해 주세요')
    }
  }
}

function database(c: Context) {
  if (!c.env.DB) throw new Error('DB unavailable')
  return c.env.DB
}

function updateWithNotification(
  c: ComponentContext<Env> | ModalContext<Env>,
  data: ReturnType<typeof renderSplit>,
  action: 'uploaded' | 'purchased' | 'percent',
  content: string,
  recipients: string[],
) {
  if (!c.env.DISCORD_TOKEN) return c.update().res(data)
  return c.update().res(data, undefined, async (response) => {
    if (!response.ok) {
      console.error('interaction callback failed', { action, status: response.status })
      return
    }
    try {
      const notification = await c.rest('POST', $webhooks$_$_, [c.interaction.application_id, c.interaction.token], {
        content, allowed_mentions: { parse: [], users: recipients },
      })
      if (!notification.ok) console.error(`${action === 'uploaded' ? 'upload' : action === 'purchased' ? 'purchase' : 'percent'} notification failed`, { action, status: notification.status })
    } catch {
      console.error(`${action === 'uploaded' ? 'upload' : action === 'purchased' ? 'purchase' : 'percent'} notification failed`, { action, status: null })
    }
  })
}

function splitModal(custom_id: string, title: string, stored?: StoredSplit): APIModalInteractionResponseCallbackData {
  return { custom_id, title, components: [
    { type: 18, label: '총판매금액', description: '수수료를 빼기 전 금액', component: {
      type: 4, style: 1, custom_id: 'total', required: true, max_length: 21,
      ...(stored ? { value: String(stored.split.total_sale) } : {}),
    } },
    { type: 18, label: '수수료', component: { type: 21, custom_id: 'fee', required: true,
      options: ([3, 5] as const).map((fee) => ({ label: `${fee}%`, value: String(fee),
        ...(stored ? { default: stored.split.sale_fee_percent === fee } : {}) })) } },
    { type: 18, label: '파티원', description: '1~5명, 본인 제외', component: {
      type: 5, custom_id: 'members', min_values: 1, max_values: 5,
      ...(stored ? { default_values: stored.members.map((m) => ({ id: m.user_id, type: SelectMenuDefaultValueType.User })) } : {}),
    } },
  ] }
}

app.command('분배', guarded<CommandContext<Env>>(async (c) => c.resModal(splitModal('split', '분배'))))

const publicSplitNotice = '패널 버튼으로 다시 만들어 주세요. /분배를 쓰면 채널에 공개돼요.'
const privateFailure = `비공개 분배 스레드를 만들지 못했어요. 봇 권한을 확인해 주세요. ${publicSplitNotice}`
const threadPermissions = [
  [PermissionFlagsBits.ViewChannel, '채널 보기'],
  [PermissionFlagsBits.CreatePrivateThreads, '비공개 스레드 만들기'],
  [PermissionFlagsBits.SendMessagesInThreads, '스레드와 포럼에서 메시지 보내기'],
  [PermissionFlagsBits.EmbedLinks, '링크 첨부'],
  [PermissionFlagsBits.ReadMessageHistory, '메시지 기록 보기'],
  [PermissionFlagsBits.AddReactions, '반응 추가'],
] as const

function checkPrivateChannel(c: Context) {
  // Advisory only: REST failures enforce access, with no public fallback.
  if (c.interaction.channel?.type !== undefined && c.interaction.channel.type !== 0) throw new InputError('일반 텍스트 채널에서만 비공개 분배를 만들 수 있어요.')
  if (c.interaction.app_permissions === undefined) return
  const permissions = BigInt(c.interaction.app_permissions)
  const missing = threadPermissions.filter(([bit]) => (permissions & bit) === 0n).map(([, name]) => name)
  if (missing.length) throw new InputError(`봇 권한이 부족해요: ${missing.join(', ')}. 채널 권한을 확인해 주세요.`)
}

app.command('분배패널', guarded<CommandContext<Env>>(async (c) => {
  checkPrivateChannel(c)
  return c.res({
    content: '버튼을 누르면 입력 창이 열려요. 제출 뒤 나만 보기 금액 안내에서 확인을 누르면 선택한 파티원과의 비공개 스레드가 열려요.\n스레드 관리 권한자는 초대 없이 볼 수 있어요. /분배는 채널에 공개돼요.',
    allowed_mentions: { parse: [], users: [] },
    components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'private-split', label: '비공개 분배 만들기' }] }],
  })
}))

app.component('private-split', guarded<ComponentContext<Env>>(async (c) => {
  checkPrivateChannel(c)
  return c.resModal(splitModal('private-split', '비공개 분배'))
}))

// Edit the original response with status only, clearing preview amounts and buttons; never include a private card.
async function replyOriginal(c: ComponentContext<Env> | ModalContext<Env>, content: string) {
  try {
    const response = await c.rest('PATCH', $webhooks$_$_$messages$original,
      [c.interaction.application_id, c.interaction.token], { content, embeds: [], components: [], allowed_mentions: { parse: [], users: [] } })
    if (!response.ok) console.error('response edit failed', { status: response.status })
  } catch {
    console.error('response edit failed', { status: null })
  }
}

const expiredDraft = '이미 처리했거나 만료된 확인이에요. /미완료를 먼저 확인하고, 없으면 다시 만들어 주세요.'

async function draftContext(c: ComponentContext<Env> | ModalContext<Env>) {
  const guild = c.interaction.guild_id
  const user = c.interaction.member?.user.id
  if (!guild || !user) throw new InputError('서버 안에서 사용해 주세요.')
  const id = c.ref.custom_value
  if (!id || id.includes(';')) throw new InputError(expiredDraft)
  const db = database(c)
  const stored = await getDraft(db, id, guild, user)
  if (!stored) throw new InputError(expiredDraft)
  if (stored.split.channel_id !== c.interaction.channel_id) throw new InputError(expiredDraft)
  return { db, id, guild, user, stored }
}

function privatePreflight(c: Context) {
  if (!c.env.DISCORD_TOKEN) throw new InputError(`${privateFailure} 봇 토큰 설정이 필요해요.`)
  checkPrivateChannel(c)
  database(c)
}

function preview(stored: StoredSplit, id: string) {
  return {
    content: [`총판매금액: ${money(stored.split.total_sale)} (${stored.split.total_sale})`,
      `수수료: ${stored.split.sale_fee_percent}%`,
      `파티원: ${stored.members.map((m) => `<@${m.user_id}>`).join(' ')}`,
      `게시 위치: ${stored.split.private_thread ? '비공개 스레드' : '이 채널에 공개'}`,
      '금액을 확인한 뒤 확인을 눌러 주세요.'].join('\n'),
    embeds: [], allowed_mentions: { parse: [], users: [] },
    components: [{ type: 1 as const, components: [
      { type: 2 as const, style: 3 as const, custom_id: `confirm-split;${id}`, label: '확인' },
      { type: 2 as const, style: 2 as const, custom_id: `edit-split;${id}`, label: '다시 입력' },
    ] }],
  }
}

for (const key of ['split', 'private-split', 'edit-split'] as const) {
  app.modal(key, guarded<ModalContext<Env>>(async (c) => {
    const previous = key === 'edit-split' ? await draftContext(c) : undefined
    if (previous && !c.interaction.message) throw new InputError(expiredDraft)
    const stored = buildSplit(c.interaction, { total: c.get('total'), fee: c.get('fee'), members: c.get('members') })
    stored.split.private_thread = previous?.stored.split.private_thread ?? (key === 'private-split' ? 1 : 0)
    if (stored.split.private_thread) {
      privatePreflight(c)
      for (const member of stored.members) {
        const permissions = c.interaction.data.resolved?.members?.[member.user_id]?.permissions
        if (permissions !== undefined && (BigInt(permissions) & PermissionFlagsBits.ViewChannel) === 0n) {
          throw new InputError(`<@${member.user_id}>님에게 이 채널을 볼 권한이 없어요.`)
        }
      }
    }
    const db = database(c)
    if (previous) {
      if (!await replaceDraft(db, previous.id, previous.guild, previous.user, stored)) throw new InputError(expiredDraft)
      return c.update().res(preview(stored, previous.id))
    }
    await saveDraft(db, stored)
    // A panel-origin modal carries the public panel message. Never update that message.
    return c.update(false).flags('EPHEMERAL').res(preview(stored, stored.split.id))
  }))
}

app.component('edit-split', guarded<ComponentContext<Env>>(async (c) => {
  const { stored, id } = await draftContext(c)
  return c.resModal(splitModal(`edit-split;${id}`, stored.split.private_thread ? '비공개 분배' : '분배', stored))
}))

app.component('confirm-split', guarded<ComponentContext<Env>>(async (c) => {
  const { db, id, guild, user, stored: pending } = await draftContext(c)
  if (pending.split.private_thread) privatePreflight(c)
  const stored = await consumeDraft(db, id, guild, user)
  if (!stored) throw new InputError(expiredDraft)
  stored.split.created_at = new Date().toISOString()
  if (!stored.split.private_thread) {
    try {
      await createSplit(db, stored)
    } catch {
      console.error('public split save', { status: null })
      try {
        await deleteSplit(db, stored.split.id, stored.split.guild_id)
      } catch {
        console.error('public split delete', { status: null })
        return reject(c, '저장 결과를 확인하지 못했어요. /미완료를 먼저 확인하고, 없으면 다시 만들어 주세요.')
      }
      return reject(c, '분배를 저장하지 못했어요. 다시 만들어 주세요.')
    }
    if (!c.env.DISCORD_TOKEN) return c.update(false).res(renderSplit(stored))
    return c.update().res({ content: '카드를 올렸어요', embeds: [], components: [], allowed_mentions: { parse: [], users: [] } }, undefined, async (response) => {
      if (!response.ok) {
        console.error('public split callback', { status: response.status })
        return
      }
      let status: number | null = null
      try {
        const card = await c.rest('POST', $webhooks$_$_, [c.interaction.application_id, c.interaction.token], renderSplit(stored))
        if (card.ok) return
        status = card.status
      } catch {}
      console.error('public card post', { status })
      await replyOriginal(c, status !== null && status >= 400 && status < 500
        ? '카드를 올리지 못했어요. /미완료로 다시 올려 주세요. 다시 올린 카드는 알림이 가지 않으니 파티원에게 직접 알려 주세요.'
        : '게시 결과를 확인하지 못했어요. 채널에 카드가 없으면 /미완료로 다시 올리고, 알림이 가지 않으니 파티원에게 직접 알려 주세요.')
    })
  }
  return c.update().resDefer(async () => {
    let action = 'private thread create'
    let status: number | null = null
    let failure = privateFailure
    try {
      const user = c.interaction.member!
      const name = user.nick ?? user.user.global_name ?? user.user.username
      const response = await c.rest('POST', $channels$_$threads, [stored.split.channel_id], {
        name: `분배 · ${name}`.slice(0, 100), type: 12, invitable: false, auto_archive_duration: 10080,
      })
      if (!response.ok) {
        console.error(action, { status: response.status })
        return await replyOriginal(c, failure)
      }
      const thread = await response.json()
      if (thread.type !== 12 || typeof thread.id !== 'string' || !/^\d+$/.test(thread.id)) throw new Error('Invalid private thread')
      stored.split.channel_id = thread.id
      stored.split.private_thread = 1
      for (const id of [stored.split.distributor_id, ...stored.members.map((m) => m.user_id)]) {
        action = 'private thread member add'
        failure = `<@${id}>님을 추가하지 못해 분배를 만들지 않았어요. 빈 스레드가 남을 수 있어요. ${publicSplitNotice}`
        const added = await c.rest('PUT', $channels$_$threadmembers$_, [thread.id, id])
        if (!added.ok) {
          console.error(action, { status: added.status })
          return await replyOriginal(c, failure)
        }
      }
      action = 'private split save'
      failure = `분배를 저장하지 못했어요. 빈 스레드가 남을 수 있어요. ${publicSplitNotice}`
      await createSplit(db, stored)
      action = 'private card post'
      failure = `게시 결과를 확인하지 못했어요. <#${thread.id}>를 확인하고 카드가 없으면 /미완료로 스레드에 다시 올려 주세요.`
      const card = await c.rest('POST', $channels$_$messages, [thread.id], renderSplit(stored))
      if (!card.ok) {
        status = card.status
        throw new Error('Card post failed')
      }
      await replyOriginal(c, `<#${thread.id}>에 비공개 분배를 만들었어요.`)
    } catch {
      console.error(action, { status })
      // A save exception may have committed; only definite card rejection permits cleanup.
      if (action === 'private split save' || (action === 'private card post' && status !== null && status >= 400 && status < 500)) {
        if (action === 'private card post') failure = `카드를 올리지 못해 분배를 만들지 않았어요. 빈 스레드가 남을 수 있어요. ${publicSplitNotice}`
        try {
          await deleteSplit(db, stored.split.id, stored.split.guild_id)
        } catch {
          console.error('private split delete', { status: null })
          failure = action === 'private split save'
            ? '저장 결과를 확인하지 못했어요. /미완료에 보이면 스레드에 카드를 다시 올려 주세요.'
            : '카드를 올리지 못했지만 기록이 남아 있어요. /미완료로 스레드에 카드를 다시 올릴 수 있어요.'
        }
      }
      await replyOriginal(c, failure)
    }
  })
}))

const percentLocked = '이미 경매장 등록을 한 파티원이 있어서 비율을 바꿀 수 없어요.'
async function percentSplit(c: ComponentContext<Env> | ModalContext<Env>) {
  const guild = c.interaction.guild_id
  const user = c.interaction.member?.user.id
  if (!guild || !user) throw new InputError('서버 안에서 사용해 주세요.')
  const id = c.ref.custom_value
  if (!id || id.includes(';')) throw new InputError('잘못된 분배 입력창이에요.')
  const stored = await getSplit(database(c), id, guild)
  if (!stored) throw new InputError('분배를 찾을 수 없어요.')
  if (stored.split.distributor_id !== user) throw new InputError('분배자만 이 버튼을 누를 수 있어요.')
  if (stored.split.status === 'active' && stored.members.some((m) => m.status === 'uploaded' || m.status === 'purchased')) {
    throw new InputError(percentLocked)
  }
  return { stored, guild, user }
}

app.component('percent', guarded<ComponentContext<Env>>(async (c) => {
  const { stored } = await percentSplit(c)
  if (stored.split.status !== 'active') return c.update().res(renderSplit(stored))
  const fields = [
    ...(stored.members.length < 5 ? [{ id: 'distributor', name: '분배자', percent: stored.split.distributor_percent_hundredths }] : []),
    ...stored.members.map((m) => ({ id: m.user_id, name: m.display_name, percent: m.percent_hundredths })),
  ]
  const components: APILabelComponent[] = fields.map((field) => ({
    type: 18, label: Array.from(field.name).slice(0, 45).join(''), description: '비우면 남은 퍼센트를 나눠요',
    component: { type: 4, style: 1, custom_id: field.id, required: false, max_length: 7,
      ...(field.percent !== null ? { value: String(field.percent / 100) } : {}) },
  }))
  return c.resModal({ custom_id: `percent;${stored.split.id}`,
    title: stored.members.length === 5 ? '비율 조정 (분배자는 빈 칸처럼 계산)' : '비율 조정', components })
}))

app.modal('percent', guarded<ModalContext<Env>>(async (c) => {
  if (!c.interaction.message) return reject(c, '안내 메시지의 비율 조정 버튼을 다시 눌러 주세요.')
  const { stored, guild, user } = await percentSplit(c)
  if (stored.split.status !== 'active') return c.update().res(renderSplit(stored))
  const values = Object.fromEntries(['distributor', ...stored.members.map((m) => m.user_id)].map((key) => [key, c.get(key)]))
  const adjusted = adjustPercent(stored, values)
  if (!await savePercent(database(c), adjusted, guild, user)) {
    const latest = await getSplit(database(c), stored.split.id, guild)
    if (!latest) throw new Error('Split disappeared')
    return latest.split.status !== 'active' ? c.update().res(renderSplit(latest)) : reject(c, percentLocked)
  }
  const latest = await getSplit(database(c), stored.split.id, guild)
  if (!latest) throw new Error('Split disappeared')
  const description = c.interaction.message.embeds?.[0]?.description
  const changed = latest.members.filter((m, i) => m.listing_amount !== stored.members[i].listing_amount
    || (typeof description === 'string' && !cardShowsMember(description, m)))
  if (!changed.length) return c.update().res(renderSplit(latest))
  const included = changed.filter((m) => m.listing_amount > 0)
  const excluded = changed.filter((m) => m.listing_amount === 0)
  const mentions = (members: typeof changed) => members.map((m) => `<@${m.user_id}>`).join(' ')
  const content = [
    ...(included.length ? [`${mentions(included)} <@${user}>님이 비율을 바꿨어요. 경매장 등록가를 다시 확인해 주세요.`] : []),
    ...(excluded.length ? [`${mentions(excluded)} <@${user}>님이 비율을 바꿔서 이번 분배에서 제외됐어요. 이미 올렸다면 내려 주세요.`] : []),
  ].join('\n')
  return updateWithNotification(c, renderSplit(latest), 'percent', content, changed.map((m) => m.user_id))
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

app.component('repost', guarded<ComponentContext<Env>>(async (c) => {
  const guild = c.interaction.guild_id
  const user = c.interaction.member?.user.id
  if (!guild || !user) return reject(c, '서버 안에서 사용해 주세요.')
  const id = c.interaction.data.component_type === 3 ? c.interaction.data.values[0] : undefined
  const stored = id ? await getSplit(database(c), id, guild) : null
  if (!stored) return reject(c, '분배를 찾을 수 없어요.')
  if (stored.split.distributor_id !== user && !stored.members.some((m) => m.user_id === user && m.status !== 'excluded')) {
    return reject(c, '이 분배의 참여자만 카드를 다시 올릴 수 있어요.')
  }
  if (stored.split.status !== 'active') return reject(c, '이미 끝난 분배예요.')
  if (stored.split.private_thread === 1 && c.interaction.channel_id !== stored.split.channel_id) {
    if (!c.env.DISCORD_TOKEN) return reject(c, '비공개 스레드에 카드를 다시 올리지 못했어요. 봇 토큰 설정이 필요해요.')
    return c.update(false).flags('EPHEMERAL').resDefer(async () => {
      try {
        const response = await c.rest('POST', $channels$_$messages, [stored.split.channel_id], {
          ...renderSplit(stored), allowed_mentions: { parse: [], users: [] },
        })
        if (!response.ok) {
          console.error('private card repost', { status: response.status })
          return await replyOriginal(c, '비공개 스레드에 카드를 다시 올리지 못했어요.')
        }
        await replyOriginal(c, `<#${stored.split.channel_id}>에 카드를 다시 올렸어요.`)
      } catch {
        console.error('private card repost', { status: null })
        await replyOriginal(c, '비공개 스레드에 카드를 다시 올리지 못했어요.')
      }
    })
  }
  if (c.interaction.channel_id !== stored.split.channel_id) {
    return reject(c, `이 카드는 <#${stored.split.channel_id}> 채널에서만 다시 올릴 수 있어요. 그 채널에서 /미완료를 실행해 주세요.`)
  }
  return c.update(false).res({ ...renderSplit(stored), allowed_mentions: { parse: [], users: [] } })
}))

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
      if (!member || member.status === 'excluded') return reject(c, '분배받는 파티원 본인만 경매장 등록을 할 수 있어요.')
    } else if (stored.split.distributor_id !== user) return reject(c, '분배자만 이 버튼을 누를 수 있어요.')
    if (stored.split.status !== 'active') return c.update().res(renderSplit(stored))
    if (action === 'purchased' && stored.members.find((m) => m.user_id === target)?.status === 'pending') {
      return reject(c, '파티원이 아직 경매장 등록을 하지 않았어요.')
    }
    let completed = false
    let changed = false
    if (action === 'uploaded') {
      if (member!.status === 'purchased') return c.update().res(renderSplit(stored))
      return c.resModal({ custom_id: `item;${id};${member!.listing_amount}`, title: '경매장 등록', components: [{
        type: 18, label: '등록한 아이템', description: `${money(member!.listing_amount)} (${member!.listing_amount})로 올렸는지 확인해 주세요`, component: { type: 4, custom_id: 'item_name', style: 1,
          required: true, max_length: 100, ...(member!.item_name ? { value: member!.item_name } : {}) },
      }] })
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
            [c.interaction.channel_id, c.interaction.message.id, encodeURIComponent('✅')])
          if (!response.ok) console.error('completion reaction failed', { action: 'purchased', status: response.status })
        } catch {
          console.error('completion reaction failed', { action: 'purchased', status: null })
        }
      })())
    }
    if (action === 'purchased') {
      const purchased = latest.members.find((m) => m.user_id === target)!
      const text = purchased.item_name === null ? '등록한 아이템을 구매했어요' : `**${escapeItemName(purchased.item_name)}** 구매했어요`
      return updateWithNotification(c, data, action,
        `<@${target}> <@${user}>님이 ${text} · 실수령액: ${money(purchased.expected_receipt)}`, [target])
    }
    return c.update().res(data)
  }))
}

app.modal('item', guarded<ModalContext<Env>>(async (c) => {
  const guild = c.interaction.guild_id
  const user = c.interaction.member?.user.id
  if (!guild || !user) return reject(c, '서버 안에서 사용해 주세요.')
  const parts = (c.ref.custom_value ?? '').split(';')
  const [id, rawAmount] = parts
  if (!id || parts.length !== 2 || !/^\d+$/.test(rawAmount)) {
    return reject(c, '안내 메시지의 경매장 등록 버튼을 다시 눌러 주세요.')
  }
  const amount = Number(rawAmount)
  // Type 7 is only usable for a modal opened from a message component.
  if (!c.interaction.message) return reject(c, '안내 메시지의 경매장 등록 버튼을 다시 눌러 주세요.')
  const db = database(c)
  const stored = await getSplit(db, id, guild)
  if (!stored) return reject(c, '분배를 찾을 수 없어요.')
  const member = stored.members.find((m) => m.user_id === user)
  if (!member || member.status === 'excluded') return reject(c, '분배받는 파티원 본인만 경매장 등록을 할 수 있어요.')
  if (stored.split.status !== 'active' || member.status === 'purchased') return c.update().res(renderSplit(stored))
  const changedAmount = (value: number) => `분배자가 비율을 바꿔서 경매장 등록가가 ${listingMoney(value)}로 바뀌었어요. 게임에 올린 금액을 확인하고 버튼을 다시 눌러 주세요.`
  if (member.listing_amount !== amount) return reject(c, changedAmount(member.listing_amount))
  const raw = c.get('item_name')
  const itemName = typeof raw === 'string' ? raw.replace(/[\r\n]+/g, ' ').trim() : ''
  if (!itemName || itemName.length > 100) return reject(c, '등록한 아이템을 1~100자로 입력해 주세요.')
  const changed = await markUploaded(db, id, guild, user, itemName, amount)
  const latest = await getSplit(db, id, guild)
  if (!latest) throw new Error('Split disappeared')
  const uploaded = latest.members.find((m) => m.user_id === user)!
  if (!changed && uploaded.listing_amount !== amount) {
    return reject(c, uploaded.status === 'excluded'
      ? '분배받는 파티원 본인만 경매장 등록을 할 수 있어요.' : changedAmount(uploaded.listing_amount))
  }
  const data = renderSplit(latest)
  if (!changed || !c.env.DISCORD_TOKEN) return c.update().res(data)
  const name = escapeItemName(itemName)
  const text = member.status === 'pending' ? `**${name}** 등록했어요` : `아이템을 **${name}**(으)로 수정했어요`
  return updateWithNotification(c, data, 'uploaded',
    `<@${stored.split.distributor_id}> <@${user}>님이 ${text} · 경매장 등록가: ${listingMoney(uploaded.listing_amount)}`,
    [stored.split.distributor_id])
}))

// The library's callback transport has no rejection branch. Keep background failures contained
// without logging REST error objects (which can expose tokens).
const fetchInteraction = app.fetch
app.fetch = (request, env, executionCtx, option) => {
  const signature = request.headers.get('x-signature-ed25519')
  if (request.method === 'POST' && signature !== null && !/^[\da-f]{128}$/i.test(signature)) {
    return Promise.resolve(new Response('Bad Request', { status: 401 }))
  }
  return fetchInteraction(request, env, executionCtx ? {
    waitUntil: (promise: Promise<unknown>) => executionCtx.waitUntil(promise.catch(() => {
      console.error('interaction callback failed', { status: null })
    })),
    passThroughOnException: () => executionCtx.passThroughOnException(),
  } : undefined, option)
}

export default app
