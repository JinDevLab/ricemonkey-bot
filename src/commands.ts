import type { RESTPostAPIChatInputApplicationCommandsJSONBody, APIApplicationCommandBasicOption } from 'discord-api-types/v10'

const memberOptions: APIApplicationCommandBasicOption[] = Array.from({ length: 5 }, (_, i) => ({
  type: 6, name: `파티원${i + 1}`, description: `분배받을 파티원 ${i + 1}`, required: i === 0,
}))
const percentOptions: APIApplicationCommandBasicOption[] = ['분배자', ...Array.from({ length: 5 }, (_, i) => `파티원${i + 1}`)].map((name) => ({
  type: 3, name: `${name}퍼센트`, description: `${name} 몫 (0~100, 소수점 둘째 자리까지)`,
}))

export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  {
    type: 1, name: '분배', description: '보스 리워드 판매금을 분배해요', contexts: [0], integration_types: [0],
    options: [
      { type: 4, name: '총판매금액', description: '수수료를 빼기 전 총 판매금액 (쉼표 없이)', required: true, min_value: 1, max_value: Number.MAX_SAFE_INTEGER },
      { type: 4, name: '수수료', description: '판매 수수료', required: true, choices: [{ name: '3%', value: 3 }, { name: '5%', value: 5 }] },
      ...memberOptions, ...percentOptions,
    ],
  },
  { type: 1, name: '미완료', description: '내가 올릴 건과 구매할 건을 확인해요', contexts: [0], integration_types: [0] },
  { type: 1, name: '내역', description: '이 서버에서 참여한 분배 최근 10건을 확인해요', contexts: [0], integration_types: [0] },
]
