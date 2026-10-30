import type { APIChatInputApplicationCommandInteraction } from 'discord-api-types/v10'
import { calculateSplit, SplitError } from './split'
import type { SplitErrorCode } from './split'
import type { StoredSplit } from './db'

export class InputError extends Error {}

export const splitErrorMessages: Record<SplitErrorCode, string> = {
  INVALID_TOTAL: '총 판매금액은 1메소 이상이어야 해요.',
  INVALID_FEE: '판매 수수료는 3% 또는 5%만 선택할 수 있어요.',
  INVALID_MEMBER_COUNT: '파티원은 1명부터 5명까지 선택해 주세요.',
  DUPLICATE_PARTICIPANT: '파티원을 중복 선택하거나 분배자 본인을 넣을 수 없어요.',
  INVALID_PERCENT: '퍼센트는 0~100 사이, 소수점 둘째 자리까지 입력해 주세요. 끝에 % 하나를 붙여도 돼요.',
  PERCENT_SUM: '퍼센트 합계를 확인해 주세요. 모두 지정하면 100%, 일부만 지정하면 나머지 인원이 나눌 몫이 남아야 해요.',
  AMOUNT_TOO_SMALL: '판매금액이 너무 작아서 받을 몫이 있는 파티원의 올릴 금액이 0메소예요.',
}

export function parsePercent(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,2})?%?$/.test(value)) {
    throw new InputError(splitErrorMessages.INVALID_PERCENT)
  }
  const [whole, fraction = ''] = value.replace(/%$/, '').split('.')
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (result > 10000) throw new InputError(splitErrorMessages.INVALID_PERCENT)
  return result
}

export function buildSplit(interaction: APIChatInputApplicationCommandInteraction): StoredSplit {
  const guild = interaction.guild_id
  const distributor = interaction.member?.user.id
  if (!guild || !distributor || !interaction.channel_id) throw new InputError('서버 안에서 사용해 주세요.')
  const values = new Map(interaction.data.options?.map((o) => [o.name, 'value' in o ? o.value : undefined]))
  const total = values.get('총판매금액')
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total <= 0) {
    throw new InputError('총 판매금액은 1 이상인 안전한 정수로 입력해 주세요. 쉼표는 넣을 수 없어요.')
  }
  const fee = values.get('수수료')
  if (fee !== 3 && fee !== 5) throw new InputError(splitErrorMessages.INVALID_FEE)
  const distributorPercent = parsePercent(values.get('분배자퍼센트'))
  const members: { id: string; percentHundredths: number | undefined; displayName: string }[] = []
  const seen = new Set([distributor])
  for (let i = 1; i <= 5; i++) {
    const id = values.get(`파티원${i}`)
    const percent = parsePercent(values.get(`파티원${i}퍼센트`))
    if (id === undefined) {
      if (percent !== undefined) throw new InputError(`파티원${i}을 선택한 뒤 퍼센트를 입력해 주세요.`)
      continue
    }
    if (typeof id !== 'string') throw new InputError('파티원을 다시 선택해 주세요.')
    if (seen.has(id)) throw new InputError(splitErrorMessages.DUPLICATE_PARTICIPANT)
    seen.add(id)
    const user = interaction.data.resolved?.users?.[id]
    if (!user) throw new InputError('파티원 정보를 확인할 수 없어요. 다시 선택해 주세요.')
    if (user.bot) throw new InputError('봇 계정은 파티원으로 선택할 수 없어요.')
    const displayName = interaction.data.resolved?.members?.[id]?.nick ?? user.global_name ?? user.username
    members.push({ id, percentHundredths: percent, displayName })
  }
  let result
  try {
    result = calculateSplit({ totalSale: BigInt(total), saleFeePercent: fee, distributor: { id: distributor, percentHundredths: distributorPercent }, members })
  } catch (error) {
    if (error instanceof SplitError) throw new InputError(splitErrorMessages[error.code])
    throw error
  }
  if (result.members.every((m) => m.listingAmount === 0n)) {
    throw new InputError('분배받을 파티원이 한 명 이상 있어야 해요. 모든 파티원을 0%로 지정할 수 없어요.')
  }
  const id = crypto.randomUUID()
  return {
    split: {
      id, guild_id: guild, channel_id: interaction.channel_id, distributor_id: distributor,
      total_sale: total, sale_fee_percent: fee, net_sale: Number(result.netSale),
      distributor_percent_hundredths: distributorPercent ?? null, distributor_final: Number(result.distributorFinal),
      status: 'active', created_at: new Date().toISOString(), completed_at: null, canceled_at: null,
    },
    members: result.members.map((share, position) => ({
      split_id: id, user_id: share.id, display_name: members[position].displayName, position,
      percent_hundredths: members[position].percentHundredths ?? null,
      listing_amount: Number(share.listingAmount), expected_receipt: Number(share.expectedReceipt),
      status: share.listingAmount === 0n ? 'excluded' : 'pending', uploaded_at: null, purchased_at: null,
    })),
  }
}
