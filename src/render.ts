import type { APIActionRowComponent, APIButtonComponentWithCustomId, APIInteractionResponseCallbackData } from 'discord-api-types/v10'
import type { HistoryRow, MemberRow, PendingRow, StoredSplit } from './db'

export const money = (value: number) => value.toLocaleString('en-US')
const memberStatus: Record<MemberRow['status'], string> = { pending: '대기', uploaded: '올렸어요', purchased: '구매 완료', excluded: '제외' }
const splitStatus = { active: '진행 중', completed: '완료', canceled: '취소' }
const button = (custom_id: string, label: string, style: 1 | 2 | 3 | 4, disabled = false): APIButtonComponentWithCustomId => ({
  type: 2, custom_id, label: Array.from(label).slice(0, 80).join(''), style, disabled,
})
const row = (components: APIButtonComponentWithCustomId[]): APIActionRowComponent<APIButtonComponentWithCustomId> => ({ type: 1, components })

export function renderSplit({ split: s, members }: StoredSplit): APIInteractionResponseCallbackData {
  const visible = members.filter((m) => m.status !== 'excluded')
  const content = [
    `${s.status === 'completed' ? '✅ ' : ''}분배 · ${splitStatus[s.status]}`,
    `총 판매금액: ${money(s.total_sale)}메소`,
    `판매 수수료: ${s.sale_fee_percent}% · 판매 실수령액: ${money(s.net_sale)}메소`,
    `분배자 <@${s.distributor_id}> 최종 금액: ${money(s.distributor_final)}메소`,
    ...visible.map((m) => `<@${m.user_id}> · 올릴 금액 ${money(m.listing_amount)}메소 · 예상 실수령액 ${money(m.expected_receipt)}메소 · ${memberStatus[m.status]}`),
    ...(s.status === 'canceled' ? ['이미 구매한 건은 봇이 되돌리지 못해요.'] : []),
  ].join('\n')
  return {
    content,
    allowed_mentions: { parse: [], users: visible.map((m) => m.user_id) },
    components: s.status === 'active' ? [
      row([button(`uploaded;${s.id}`, '올렸어요', 1)]),
      row(visible.map((m) => button(`purchased;${s.id};${m.user_id}`, `구매 완료 · ${m.display_name}`, 3, m.status === 'purchased'))),
      row([button(`cancel;${s.id}`, '분배 취소', 4)]),
    ] : [],
  }
}

// Embeds avoid the 2,000-character content limit for ten history rows and two queues.
export function renderUnfinished({ upload, purchase }: { upload: PendingRow[]; purchase: PendingRow[] }): APIInteractionResponseCallbackData {
  const lines = (items: PendingRow[]) => items.map((m) => `분배 ${m.id}\n<@${m.user_id}> · ${money(m.listing_amount)}메소 · ${memberStatus[m.status]}`).join('\n') || '없어요.'
  return { allowed_mentions: { parse: [], users: [] }, embeds: [
    { title: '내가 올려야 하는 건 (최근 10건)', description: lines(upload) },
    { title: '내가 구매해야 하는 건 (최근 10건)', description: lines(purchase) },
  ] }
}

export function renderHistory(rows: HistoryRow[]): APIInteractionResponseCallbackData {
  return { allowed_mentions: { parse: [], users: [] }, embeds: [{
    title: '내 분배 내역 · 최근 10건',
    description: rows.map((s) => `${s.created_at.slice(0, 10)} · 분배자 <@${s.distributor_id}>\n총 판매금액 ${money(s.total_sale)}메소 · 내 몫 ${money(s.my_share)}메소 · ${splitStatus[s.status]}`).join('\n\n') || '참여한 분배가 없어요.',
  }] }
}
