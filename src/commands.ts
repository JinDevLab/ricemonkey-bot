import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord-api-types/v10'

export function registrationCommands(guild?: string) {
  return guild ? commands.map(({ contexts, integration_types, ...command }) => command) : commands
}

export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  {
    type: 1, name: '분배', description: '보스 리워드 판매금을 분배해요', contexts: [0], integration_types: [0],
  },
  { type: 1, name: '미완료', description: '내가 올릴 건과 구매할 건을 확인해요', contexts: [0], integration_types: [0] },
  { type: 1, name: '내역', description: '이 서버에서 참여한 분배 최근 10건을 확인해요', contexts: [0], integration_types: [0] },
]
