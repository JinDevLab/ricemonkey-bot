import { describe, expect, it } from 'vitest'
import { calculateSplit, SplitError } from '../src/split'
import type { SaleFeePercent, SplitErrorCode, SplitInput } from '../src/split'

function inputFor(percents: (number | undefined)[], saleFeePercent: SaleFeePercent = 5, totalSale = 100_000_000n): SplitInput {
  const participants = percents.map((percentHundredths, index) => ({ id: `person-${index}`, percentHundredths }))
  return { totalSale, saleFeePercent, distributor: participants[0], members: participants.slice(1) }
}

const examples = [
  { name: '2-person equal at 5%', percents: [undefined, undefined], fee: 5, netSale: 95_000_000n, listingAmount: 48_223_350n, distributorFinal: 46_776_650n, expectedReceipt: 46_776_649n },
  { name: '2-person equal at 3%', percents: [undefined, undefined], fee: 3, netSale: 97_000_000n, listingAmount: 49_238_578n, distributorFinal: 47_761_422n, expectedReceipt: 47_761_420n },
  { name: '3-person equal at 5%', percents: [undefined, undefined, undefined], fee: 5, netSale: 95_000_000n, listingAmount: 31_986_531n, distributorFinal: 31_026_938n, expectedReceipt: 31_026_935n },
  { name: '6-person equal at 5%', percents: [undefined, undefined, undefined, undefined, undefined, undefined], fee: 5, netSale: 95_000_000n, listingAmount: 15_912_897n, distributorFinal: 15_435_515n, expectedReceipt: 15_435_510n },
  { name: '40/20/20/20 at 5%', percents: [4000, 2000, 2000, 2000], fee: 5, netSale: 95_000_000n, listingAmount: 19_230_769n, distributorFinal: 37_307_693n, expectedReceipt: 18_653_845n },
  { name: '60/40 at 3%', percents: [6000, 4000], fee: 3, netSale: 97_000_000n, listingAmount: 39_511_201n, distributorFinal: 57_488_799n, expectedReceipt: 38_325_864n },
] satisfies {
  name: string
  percents: (number | undefined)[]
  fee: SaleFeePercent
  netSale: bigint
  listingAmount: bigint
  distributorFinal: bigint
  expectedReceipt: bigint
}[]

function expectCode(input: SplitInput, code: SplitErrorCode) {
  expect(() => calculateSplit(input)).toThrowError(SplitError)
  expect(() => calculateSplit(input)).toThrowError(expect.objectContaining({ name: 'SplitError', code }))
}

describe('calculateSplit', () => {
  it.each(examples)('matches domain section 8: $name', (row) => {
    const input = inputFor(row.percents, row.fee)
    expect(calculateSplit(input)).toEqual({
      netSale: row.netSale,
      distributorFinal: row.distributorFinal,
      members: input.members.map((member) => ({
        id: member.id,
        listingAmount: row.listingAmount,
        expectedReceipt: row.expectedReceipt,
      })),
    })
  })

  it('shares the remaining 60% equally after the distributor specifies 40%', () => {
    expect(calculateSplit(inputFor([4000, undefined, undefined, undefined])))
      .toEqual(calculateSplit(inputFor([4000, 2000, 2000, 2000])))
  })

  it('uses exact thirds instead of rounding each person to 33.33%', () => {
    const result = calculateSplit(inputFor([undefined, undefined, undefined]))
    expect(result.distributorFinal).toBe(31_026_938n)
    expect(result.members.map((member) => [member.listingAmount, member.expectedReceipt]))
      .toEqual([[31_986_531n, 31_026_935n], [31_986_531n, 31_026_935n]])
    expectCode(inputFor([3333, 3333, 3333]), 'PERCENT_SUM')
  })

  it.each([2, 3, 4, 5, 6])('conserves equal splits for 5000 seeded totals per fee with %i people', (people) => {
    let state = BigInt(people)
    for (const fee of [3, 5] as const) {
      for (let index = 0; index < 5000; index++) {
        state = (6364136223846793005n * state + 1442695040888963407n) & ((1n << 64n) - 1n)
        const totalSale = 1_000_000n + state % (50_000_000_000n - 1_000_000n + 1n)
        const result = calculateSplit(inputFor(Array(people).fill(undefined), fee, totalSale))
        const listings = result.members.reduce((sum, member) => sum + member.listingAmount, 0n)
        expect(result.distributorFinal + listings).toBe(result.netSale)
        const difference = result.distributorFinal - result.members[0].expectedReceipt
        expect(difference).toBeGreaterThanOrEqual(0n)
        expect(difference).toBeLessThanOrEqual(BigInt(people))
        for (const member of result.members) {
          expect(member.listingAmount).toBe(result.members[0].listingAmount)
          expect(member.expectedReceipt).toBe(result.members[0].expectedReceipt)
        }
      }
    }
  })

  it.each([
    [4000, 2000, 2000, 2000],
    [6000, 4000],
    [1234, 2345, 6421],
    [1, 9999],
    [9999, 1],
    [2500, 1, 1249, 2500, 3750],
  ])('preserves custom percent proportions for %j', (...percents) => {
    for (const fee of [3, 5] as const) {
      const result = calculateSplit(inputFor(percents, fee, 49_999_999_999n))
      for (const [index, member] of result.members.entries()) {
        const distributorPercent = BigInt(percents[0])
        const memberPercent = BigInt(percents[index + 1])
        const error = result.distributorFinal * memberPercent - member.expectedReceipt * distributorPercent
        // Listing floors add < memberCount mesos to the distributor; receipt loss is < 2 mesos.
        const bound = BigInt(result.members.length) * memberPercent + 2n * distributorPercent
        expect(error).toBeGreaterThanOrEqual(0n)
        expect(error).toBeLessThan(bound)
      }
    }
  })

  it('allows the distributor to receive 0%', () => {
    const result = calculateSplit(inputFor([0, 10000]))
    expect(result.members[0].listingAmount).toBe(result.netSale)
    expect(result.distributorFinal).toBe(0n)
  })

  it('conserves totals above Number.MAX_SAFE_INTEGER exactly', () => {
    const totalSale = 90_071_992_547_409_931_234_567n
    const result = calculateSplit(inputFor([undefined, undefined, undefined], 3, totalSale))
    expect(result.netSale).toBe(totalSale * 97n / 100n)
    expect(result.distributorFinal + result.members.reduce((sum, member) => sum + member.listingAmount, 0n))
      .toBe(result.netSale)
  })

  it('preserves member order and leaves the input unchanged', () => {
    const input = inputFor([undefined, 1250, undefined, 2500])
    input.members.reverse()
    const before = structuredClone(input)
    Object.freeze(input.distributor)
    input.members.forEach(Object.freeze)
    Object.freeze(input.members)
    Object.freeze(input)
    expect(calculateSplit(input).members.map((member) => member.id)).toEqual(input.members.map((member) => member.id))
    expect(input).toEqual(before)
  })

  it.each([0n, -1n])('rejects invalid total %s', (totalSale) => {
    expectCode(inputFor([undefined, undefined], 5, totalSale), 'INVALID_TOTAL')
  })

  it.each([0, 4, 100, NaN])('rejects invalid runtime fee %s', (fee) => {
    expectCode(inputFor([undefined, undefined], fee as SaleFeePercent), 'INVALID_FEE')
  })

  it.each([0, 6])('rejects %i members', (count) => {
    expectCode(inputFor(Array(count + 1).fill(undefined)), 'INVALID_MEMBER_COUNT')
  })

  it.each(['distributor', 'member'])('rejects a repeated %s id', (repeated) => {
    const input = inputFor([undefined, undefined, undefined])
    input.members[1].id = repeated === 'distributor' ? input.distributor.id : input.members[0].id
    expectCode(input, 'DUPLICATE_PARTICIPANT')
  })

  it.each([0.5, -1, 10001, NaN, Infinity])('rejects invalid distributor percent %s', (percent) => {
    expectCode(inputFor([percent, undefined]), 'INVALID_PERCENT')
  })

  it.each([0, -1, 0.5, 10001, NaN, Infinity])('rejects invalid member percent %s', (percent) => {
    expectCode(inputFor([undefined, percent]), 'INVALID_PERCENT')
  })

  it.each([
    [5000, 4999],
    [5000, 5001],
    [10000, undefined],
    [undefined, 10000],
    [6000, 5000, undefined],
  ])('rejects an invalid percent sum for %j', (...percents) => {
    expectCode(inputFor(percents), 'PERCENT_SUM')
  })

  it('rejects a total too small to produce a nonzero listing', () => {
    expectCode(inputFor([undefined, undefined], 5, 1n), 'AMOUNT_TOO_SMALL')
  })

  it('rejects an individual zero listing even if other members receive money', () => {
    expectCode(inputFor([0, 1, 9999], 5, 100n), 'AMOUNT_TOO_SMALL')
  })

  it('validates total, fee, member count, ids, percents, sum, then listing amounts', () => {
    const input = inputFor([-1, 10000, undefined], 4 as SaleFeePercent, 0n)
    input.members = Array.from({ length: 6 }, () => ({ id: input.distributor.id, percentHundredths: 10000 }))
    expectCode(input, 'INVALID_TOTAL')
    input.totalSale = 1n
    expectCode(input, 'INVALID_FEE')
    input.saleFeePercent = 5
    expectCode(input, 'INVALID_MEMBER_COUNT')
    input.members = [{ id: input.distributor.id, percentHundredths: 10000 }, { id: 'other' }]
    expectCode(input, 'DUPLICATE_PARTICIPANT')
    input.members[0].id = 'member'
    expectCode(input, 'INVALID_PERCENT')
    input.distributor.percentHundredths = 0
    expectCode(input, 'PERCENT_SUM')
    delete input.members[0].percentHundredths
    expectCode(input, 'AMOUNT_TOO_SMALL')
  })
})
