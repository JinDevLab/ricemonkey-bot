import type { APIActionRowComponent, APIButtonComponentWithCustomId, APIInteractionResponseCallbackData } from 'discord-api-types/v10'
import type { HistoryRow, MemberRow, PendingRow, StoredSplit } from './db'

export const money = (value: number) => value.toLocaleString('en-US')
// Escape formatting, links and mention syntax only at the output boundary; store the original text.
export const escapeItemName = (value: string) => value.replace(/[\\*_~`|>#\-\[\]<@!():/]/g, '\\$&')
const date = (value: string) => `<t:${Math.floor(Date.parse(value) / 1000)}:d>`
const memberStatus: Record<MemberRow['status'], string> = { pending: '⏳ 대기', uploaded: '📦 등록 완료', purchased: '✅ 구매 완료', excluded: '제외' }
const splitStatus = { active: '🔵 진행 중', completed: '✅ 완료', canceled: '🚫 취소' }
const colors = { active: 0x5865F2, completed: 0x57F287, canceled: 0x99AAB5 }
const button = (custom_id: string, label: string, style: 1 | 2 | 3 | 4, disabled = false): APIButtonComponentWithCustomId => ({
  type: 2, custom_id, label: Array.from(label).slice(0, 80).join(''), style, disabled,
})
const row = (components: APIButtonComponentWithCustomId[]): APIActionRowComponent<APIButtonComponentWithCustomId> => ({ type: 1, components })
const item = (m: Pick<MemberRow, 'item_name' | 'status'>) => m.item_name ? escapeItemName(m.item_name) : m.status === 'pending' ? '대기' : '아이템 미입력'

export function renderSplit({ split: s, members }: StoredSplit): APIInteractionResponseCallbackData {
  const visible = members.filter((m) => m.status !== 'excluded')
  const purchased = visible.filter((m) => m.status === 'purchased').length
  const description = [
    ...visible.map((m) => [
      `<@${m.user_id}> · 올릴 금액`, `**${money(m.listing_amount)}메소**`,
      `실수령 ${money(m.expected_receipt)}메소 · ${memberStatus[m.status]}`,
      ...(m.item_name || m.status === 'uploaded' ? [`아이템: ${item(m)}`] : []),
    ].join('\n')),
    [`분배자 <@${s.distributor_id}> · 최종 ${money(s.distributor_final)}메소`,
      `총 판매금액 ${money(s.total_sale)}메소 · 수수료 ${s.sale_fee_percent}%`,
      `판매 실수령액 ${money(s.net_sale)}메소`].join('\n'),
    ...(s.status === 'canceled' ? ['이미 구매한 건은 봇이 되돌리지 못해요.'] : []),
  ].join('\n\n')
  return {
    content: visible.map((m) => `<@${m.user_id}>`).join(' '),
    embeds: [{ title: s.status === 'active' ? `💰 분배 진행 중 (${purchased}/${visible.length} 구매 완료)` : s.status === 'completed' ? '✅ 분배 완료' : '🚫 분배 취소', color: colors[s.status], description }],
    allowed_mentions: { parse: [], users: visible.map((m) => m.user_id) },
    components: s.status === 'active' ? [
      row([button(`uploaded;${s.id}`, '아이템 등록', 1)]),
      row(visible.map((m) => button(`purchased;${s.id};${m.user_id}`, `구매 완료 · ${m.display_name}`, 3, m.status === 'purchased'))),
      row([button(`cancel;${s.id}`, '분배 취소', 4)]),
    ] : [],
  }
}

export function renderUnfinished({ upload, purchase }: { upload: PendingRow[]; purchase: PendingRow[] }): APIInteractionResponseCallbackData {
  const lines = (items: PendingRow[], uploading: boolean) => [
    ...items.slice(0, 10).map((m) => `<@${uploading ? m.distributor_id : m.user_id}> · ${money(m.listing_amount)}메소${uploading ? '' : ` · ${memberStatus[m.status]}\n아이템: **${item(m)}**`}\n<#${m.channel_id}> · ${date(m.created_at)}`),
    ...(items.length > 10 ? ['더 있어요. 먼저 오래된 건부터 처리해 주세요.'] : []),
  ].join('\n\n') || '없어요.'
  return { allowed_mentions: { parse: [], users: [] }, embeds: [
    { title: '📦 내가 등록해야 하는 건', color: colors.active, description: lines(upload, true) },
    { title: '🛒 내가 구매해야 하는 건', color: colors.active, description: lines(purchase, false) },
  ] }
}

export function renderHistory(rows: HistoryRow[]): APIInteractionResponseCallbackData {
  return { allowed_mentions: { parse: [], users: [] }, embeds: [{
    title: '📚 내 분배 내역 · 최근 10건', color: colors.active,
    description: rows.map((s) => `${date(s.created_at)} · 분배자 <@${s.distributor_id}>\n총 판매금액 ${money(s.total_sale)}메소 · 내 몫 ${money(s.my_share)}메소 · ${splitStatus[s.status]}`).join('\n\n') || '참여한 분배가 없어요.',
  }] }
}
