# 프로토타입 다음 할 일

## 1. 사용자가 직접 해야 하는 일
- [ ] Cloudflare 계정을 만들고 프로젝트 루트에서 `npx wrangler login`으로 인증한다. Workers·D1만 사용할 때 카드 없이 가입 가능한지는 미확인이다.
- [ ] `npx wrangler d1 create ricemonkey-bot`을 실행하고 출력된 ID로 `wrangler.jsonc`의 `database_id` 자리표시자를 교체한다.
- [ ] Discord Developer Portal에서 앱과 봇을 만들고 Application ID, Public Key, Bot Token을 확인한다. 비밀값은 커밋하지 않는다.
- [ ] `Copy-Item .dev.vars.example .dev.vars` 후 `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_TOKEN`을 채운다. 테스트 서버만 등록하려면 `DISCORD_GUILD_ID`도 채운다.
- [ ] `npx wrangler d1 migrations apply ricemonkey-bot --local` 후 `npm run dev`로 로컬 준비를 확인한다.
- [ ] `npx wrangler secret put DISCORD_PUBLIC_KEY`, `npx wrangler secret put DISCORD_APPLICATION_ID`, `npx wrangler secret put DISCORD_TOKEN`을 각각 실행한다.
- [ ] `npm run typecheck`, `npm test`, `npx wrangler deploy --dry-run`을 통과시킨다.
- [ ] `npx wrangler d1 migrations apply ricemonkey-bot --remote`로 실제 DB에 적용한 뒤 `npm run deploy`로 첫 배포한다. 이번 구현에서는 원격 적용·배포를 하지 않았다.
- [ ] `npm run register`로 명령을 등록한다. `DISCORD_GUILD_ID`가 비어 있으면 전역 명령을 덮어쓰므로 등록 범위를 먼저 확인한다. 이번 구현에서는 실제 등록하지 않았다.
- [ ] Developer Portal의 Interactions Endpoint URL에 배포된 Worker의 `/` URL을 등록한다.
- [ ] Developer Portal의 Guild Install에 `bot`, `applications.commands`를 설정해 서버에 초대한다. 사용할 채널의 View Channel, Send Messages, Embed Links, Read Message History, Add Reactions 권한을 확인한다.
- [ ] 실제 파티에서 생성 → 올렸어요 → 분배자 알림 → 구매 완료 → 내역, 취소, 권한 거부 흐름을 확인한다.

## 2. 실제 환경에서만 확인할 항목
- [ ] 서명 검증·D1 처리가 Workers 무료 CPU 10ms 안에 들어오는지 첫 배포에서 측정한다.
- [ ] Gateway 연결 없이 봇 토큰으로 완료 리액션 PUT이 되는지 확인한다. 실패해도 메시지의 ✅는 표시된다.
- [ ] callback 모드의 빈 HTTP 202 응답과 callback API 처리 뒤 분배자 후속 알림이 실제 Discord에서도 동작하는지 확인한다.
- [ ] 한글 명령·옵션 표시와 입력을 실제 Discord에서 확인한다. 공식 이름 정규식은 Unicode 문자를 허용하며 코드 정의도 그 정규식 검사를 통과했다.
- [ ] [아키텍처 7절](architecture.md#7-미검증-사항)의 카드 요구 여부, 실제 전체 연동, 향후 CD용 API 토큰의 D1 편집 권한을 확인한다.

## 3. 구현 중 막힌 것
- [x] 로컬 D1 마이그레이션·실제 엔진 테스트와 Wrangler HTTP 스모크는 실행했다. 스모크의 PING, 분배 생성, 구매 완료, 미완료, 내역이 통과했고 서버 프로세스 트리를 종료했다.
- [ ] 다른 모델 계열의 독립 리뷰는 실행하지 않았다. 이 실행 환경의 상위 지시가 다른 에이전트로 넘기는 것을 금지한다. 현재 검토는 구현자의 diff 검토와 로컬 검사다.
- [ ] 원격 계정·배포·명령 등록·실제 Discord API 호출은 작업 범위상 실행하지 않았다. 위 실환경 항목은 미검증이다.

## 4. 구현 중 내린 결정
- [x] 모든 파티원의 몫이 0%인 분배는 받을 사람이 없으므로 거부한다.
- [x] 취소 버튼에 추가 확인 단계는 두지 않는다. 구매 완료를 되돌리는 기능도 없다.
- [x] 안내 메시지 바로가기 링크는 저장하거나 제공하지 않는다. 미완료에는 분배 ID를 표시한다.
- [x] 내역은 최근 10건이고 페이지 넘김은 없다. 조회는 현재 서버로 한정한다.
- [x] 미완료도 Discord 응답 크기를 제한하려고 올릴 건·구매할 건 각각 최근 10행만 보여 주며 제목에 한도를 표시한다. 구매할 건은 파티원별 한 행이다. 페이지 넘김은 없다.
- [x] 총 판매금액은 쉼표 없는 양의 정수이며 `Number.MAX_SAFE_INTEGER`를 넘으면 거부한다. 퍼센트는 문자열을 정수 hundredths로 바꾸며 셋째 소수자리부터 거부한다.
- [x] 동시 클릭에서 DB 상태는 조건부 UPDATE로 보존한다. 메시지 응답 도착 순서 때문에 화면이 잠깐 이전 상태일 수 있으며, 별도 메시지 동기화 작업은 없다.
- [x] 토큰이 없으면 일반 type 7 응답으로 상태만 갱신하고 알림·리액션을 건너뛴다. 후속 알림·리액션 실패는 로그만 남기며 DB를 되돌리거나 자동 재시도하지 않는다.
- [x] callback 전송 자체가 실패해도 DB는 유지된다. 화면이 갱신되지 않을 수 있으며, 미완료·내역은 DB 상태를 보여 준다.
- [x] 등록 스크립트는 Node 24의 타입 제거와 `--env-file-if-exists=.dev.vars`를 쓴다. 파일이 없어도 누락된 필수 변수 안내를 출력하고 API 호출 없이 종료하기 위해 `--env-file` 대신 선택했다.
- [x] 새 의존성 없이 Wrangler `getPlatformProxy({ persist: false })`의 실제 로컬 D1을 테스트한다. 기존 계산 모듈과 서명 테스트는 변경하지 않았다.

## 5. 기존 미결정
- [ ] 라이선스가 아직 없고 `LICENSE` 파일도 없다.
- [ ] `docs/workflow.md` 금지 항목에 과거 강제 푸시 예외 경위는 적혀 있지 않다. 이번 작업에서는 강제 명령이나 푸시를 하지 않았다.
- [ ] CI/CD는 프로토타입 이후로 보류한다.

## 확인에 사용한 공식 문서
- 명령·옵션 이름: https://docs.discord.com/developers/interactions/application-commands (Application Command Naming, Unicode `\p{L}` 허용).
- HTTP 202·callback·최초 응답 3초: https://docs.discord.com/developers/interactions/receiving-and-responding (Interaction Callback).
