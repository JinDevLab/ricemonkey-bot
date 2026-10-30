export type SaleFeePercent = 3 | 5

export interface SplitParticipant {
  id: string
  percentHundredths?: number
}

export interface SplitInput {
  totalSale: bigint
  saleFeePercent: SaleFeePercent
  distributor: SplitParticipant
  members: SplitParticipant[]
}

export interface MemberShare {
  id: string
  listingAmount: bigint
  expectedReceipt: bigint
}

export interface SplitResult {
  netSale: bigint
  distributorFinal: bigint
  members: MemberShare[]
}

export type SplitErrorCode =
  | 'INVALID_TOTAL'
  | 'INVALID_FEE'
  | 'INVALID_MEMBER_COUNT'
  | 'DUPLICATE_PARTICIPANT'
  | 'INVALID_PERCENT'
  | 'PERCENT_SUM'
  | 'AMOUNT_TOO_SMALL'

export class SplitError extends Error {
  readonly code: SplitErrorCode

  constructor(code: SplitErrorCode) {
    super(code)
    this.name = 'SplitError'
    this.code = code
  }
}

export function calculateSplit(input: SplitInput): SplitResult {
  const { totalSale, saleFeePercent, distributor, members } = input

  if (totalSale <= 0n) throw new SplitError('INVALID_TOTAL')
  if (saleFeePercent !== 3 && saleFeePercent !== 5) throw new SplitError('INVALID_FEE')
  if (members.length < 1 || members.length > 5) throw new SplitError('INVALID_MEMBER_COUNT')

  const participants = [distributor, ...members]
  const ids = new Set(participants.map((participant) => participant.id))
  if (ids.size !== participants.length) throw new SplitError('DUPLICATE_PARTICIPANT')

  for (const [index, participant] of participants.entries()) {
    const percent = participant.percentHundredths
    if (percent !== undefined && (
      !Number.isInteger(percent) || percent < (index === 0 ? 0 : 1) || percent > 10000
    )) throw new SplitError('INVALID_PERCENT')
  }

  const unspecifiedCount = BigInt(participants.filter((participant) => participant.percentHundredths === undefined).length)
  const givenSum = participants.reduce((sum, participant) => sum + BigInt(participant.percentHundredths ?? 0), 0n)
  if (unspecifiedCount === 0n ? givenSum !== 10000n : givenSum >= 10000n) {
    throw new SplitError('PERCENT_SUM')
  }

  const weights = participants.map((participant) => {
    if (participant.percentHundredths === undefined) return 10000n - givenSum
    return BigInt(participant.percentHundredths) * (unspecifiedCount || 1n)
  })
  const totalWeight = 10000n * (unspecifiedCount || 1n)
  const netSale = totalSale * (100n - BigInt(saleFeePercent)) / 100n
  const denominator = 100n * totalWeight - 3n * weights[0]
  const shares = members.map((member, index) => {
    const listingAmount = netSale * 100n * weights[index + 1] / denominator
    if (listingAmount === 0n) throw new SplitError('AMOUNT_TOO_SMALL')
    return {
      id: member.id,
      listingAmount,
      expectedReceipt: listingAmount * 97n / 100n,
    }
  })

  return {
    netSale,
    distributorFinal: netSale - shares.reduce((sum, member) => sum + member.listingAmount, 0n),
    members: shares,
  }
}
