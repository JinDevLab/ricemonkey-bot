import { register } from 'discord-hono'
import { commands } from '../src/commands.ts'

const { DISCORD_APPLICATION_ID, DISCORD_TOKEN, DISCORD_GUILD_ID } = process.env
if (!DISCORD_APPLICATION_ID || !DISCORD_TOKEN) {
  console.error('DISCORD_APPLICATION_ID와 DISCORD_TOKEN을 .dev.vars에 설정해 주세요. 명령을 등록하지 않았어요.')
  process.exitCode = 1
} else {
  try {
    const response = await register(commands, DISCORD_APPLICATION_ID, DISCORD_TOKEN, DISCORD_GUILD_ID || undefined, { silent: true })
    if (!response.ok) {
      console.error(`명령 등록 실패 (HTTP ${response.status})`)
      process.exitCode = 1
    } else console.info('명령 등록을 완료했어요.')
  } catch {
    console.error('명령 등록 요청에 실패했어요. 연결과 설정을 확인해 주세요.')
    process.exitCode = 1
  }
}
