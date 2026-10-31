# 프로토타입 다음 할 일

## 1. 배포 상태와 이번 변경 적용 순서
- [x] Cloudflare 계정 인증·D1 생성과 `wrangler.jsonc`의 DB 연결을 완료했다.
- [x] Discord 앱·봇 생성, 비밀값 설정, 테스트 서버 초대, 첫 배포(0.1.0), 명령 등록, Endpoint 등록을 완료했다. 비밀값은 문서나 커밋에 넣지 않는다.
- [ ] 실제 파티에서 생성 → 아이템 등록 → 분배자 알림 → 구매 완료 → 내역, 취소, 권한 거부 흐름을 확인 중이다.
- [ ] 이번 0.2.0 변경을 배포하기 전에 `npm run typecheck`, `npm test`, `npx wrangler deploy --dry-run`을 확인한다.
- [ ] **코드 배포 전에** `npx wrangler d1 migrations apply ricemonkey-bot --remote`로 0002를 적용한다. 0001은 수정하지 않는다. 새 코드는 `item_name` 열을 조회하므로 순서를 뒤집으면 안 된다.
- [ ] DB 적용 후 `npm run deploy`로 코드를 배포한다. 이번 작업에서는 원격 마이그레이션·배포·명령 등록을 실행하지 않았다.
- [ ] 실제 Discord에서 모달 표시(필수 한 줄·100자·기존 이름 미리 채움), 모달 제출 후 원본 메시지 갱신, 임베드 멘션 표시와 알림, 아이템 이름의 마크다운·멘션 이스케이프 표시를 확인한다.
- [ ] 실제 Discord에서 등록·수정 알림, 구매 후 재등록 차단, 모달을 연 뒤 취소·완료된 경우 저장되지 않는지 확인한다.
- 장애를 확인할 때는 `npx wrangler tail`로 실시간 로그를 보거나 Cloudflare 대시보드의 Workers Logs를 확인한다. action과 HTTP status를 확인하며 네트워크 예외의 status는 null이다. 예외 객체·요청 URL은 기록하지 않고, 핸들러 오류의 이름·메시지는 토큰을 치환한다.

## 2. 실제 환경에서만 확인할 항목
- [ ] 서명 검증·D1 처리가 Workers 무료 CPU 10ms 안에 들어오는지 첫 배포에서 측정한다.
- [ ] Gateway 연결 없이 봇 토큰으로 완료 리액션 PUT이 되는지 확인한다. 실패해도 메시지의 ✅는 표시된다.
- [ ] callback 모드의 빈 HTTP 202 응답과 callback API 처리 뒤 분배자 후속 알림이 실제 Discord에서도 동작하는지 확인한다.
- [ ] 메시지 수정 응답의 `allowed_mentions.users`에 표시 대상 파티원을 유지했을 때 기존 멘션 강조가 유지되는지 확인한다. 분배자는 목록에 넣지 않는다. 실제 알림 발생 여부도 확인한다.
- [ ] 판매 실수령액 끝수 처리를 게임에서 확인한다. 코드는 내림이고 `docs/domain.md`는 판매 실수령액의 끝수 규칙을 명시하지 않는다. 실제 게임 처리와 1메소 이내 차이가 날 가능성이 있으며 미확인이다.
- [ ] 한글 명령·옵션 표시와 입력을 실제 Discord에서 확인한다. 공식 이름 정규식은 Unicode 문자를 허용하며 코드 정의도 그 정규식 검사를 통과했다.
- [ ] [아키텍처 7절](architecture.md#7-미검증-사항)의 카드 요구 여부, 실제 전체 연동, 향후 CD용 API 토큰의 D1 편집 권한을 확인한다.

## 3. 구현 중 막힌 것
- [x] 아이템 등록·임베드 변경에서 타입 검사, 162개 테스트, 배포 dry-run을 통과했다. 제출 권한 검사 제거·SQL status 조건 제거·이스케이프 제거의 직접 변이 3종은 각각 테스트 실패를 확인하고 복원했다. 0001의 기존 uploaded 행에 0002를 적용한 뒤 NULL 이름 표시도 검증한다.
- [x] `.dev.vars` 없는 임시 복사본과 node_modules junction, 임시 Ed25519 공개 키 `--var`만으로 로컬 마이그레이션 2개와 서명 HTTP 스모크를 실행했다. `/분배` → 버튼 type 9 → 모달 type 7·이스케이프된 이름 → `/미완료` 이름 → 구매 완료 → `/내역`이 통과했다. 프로세스 트리 종료·포트 닫힘·임시 복사본 삭제를 확인했다. 긴 Windows 임시 경로에서는 workerd 내부 오류가 나서 짧은 물리 임시 경로로 재실행했다.
- [x] 기존 테스트의 getPlatformProxy가 `.dev.vars`를 자동 로드하는 것을 실행 로그에서 발견했다. 값은 열거나 출력하지 않았고 Discord 요청은 가짜 토큰과 fetch mock만 사용했다. 빈 envFiles 배열로는 차단되지 않아 명시적인 존재하지 않는 테스트 환경 파일 경로로 수정한 뒤 비밀값 로드 로그가 사라진 것을 확인했다.
- [x] 이번 수정에서도 로컬 D1 마이그레이션·실제 엔진 테스트와 Wrangler HTTP 스모크를 실행했다. 타입 검사, 149개 테스트, 배포 dry-run이 통과했다. 12종 직접 변이(DB 가드 3종, 조기 완료, 비원자적 생성, 알림 멘션, 권한 2종, active 사전 검사, 조회 제한, 로그 치환, 서명 검사)를 넣어 실패를 확인하고 모두 복원했다. 최종 스모크의 PING, 잘못된 형식·틀린 서명 401, 분배 생성, 미완료, 구매 완료, 완료 후 분배자 재클릭 type 7, 내역이 통과했고 서버 프로세스 트리를 종료해 포트가 닫힌 것을 확인했다. 공개 키는 임시 생성해 `--var`로 전달했고 `.dev.vars`나 토큰은 쓰지 않았다.
- [x] 다른 모델 계열(Claude 계열)의 독립 리뷰를 수행했고 차단 등급은 없었다. 지적을 이번 수정에 반영했다. 실제 Discord·원격 D1은 그 리뷰에서도 실행하지 않았다.
- [ ] 원격 계정·배포·명령 등록·실제 Discord API 호출은 작업 범위상 실행하지 않았다. 위 실환경 항목은 미검증이다.

## 4. 구현 중 내린 결정
- [x] 모든 파티원의 몫이 0%인 분배는 받을 사람이 없으므로 거부한다.
- [x] 안내 메시지 바로가기 링크는 저장하거나 제공하지 않는다. 미완료에는 UUID 대신 상대방, 금액, 채널, 생성일을 표시하고 구매할 건에는 상태도 표시한다.
- [x] 내역은 최근 10건이고 페이지 넘김은 없다. 조회는 현재 서버로 한정한다. 날짜는 Discord 타임스탬프로 표시해 보는 사람의 현지 날짜를 쓴다.
- [x] 미완료는 오래된 건이 숨지 않도록 오래된 순으로 각각 11행을 조회해 10행만 보여 주고, 11번째가 있으면 “더 있어요”를 표시한다. 구매할 건은 파티원별 한 행이다. 페이지 넘김은 없다.
- [x] 총 판매금액은 쉼표 없는 양의 정수이며 `Number.MAX_SAFE_INTEGER`를 넘으면 거부한다. 퍼센트는 문자열을 정수 hundredths로 바꾸며 셋째 소수자리부터 거부한다. 끝의 `%` 하나는 허용한다.
- [x] 동시 클릭에서 DB 상태는 조건부 UPDATE로 보존한다. 늦게 도착한 응답 때문에 메시지가 이전 상태로 보일 수 있고, 권한 있는 사람이 다시 누르면 DB 최신 상태로 다시 그려진다. 권한 없는 사람은 상태와 무관하게 비공개 거절만 받는다. 별도 자동 동기화 작업은 없다.
- [x] 토큰이 없으면 일반 type 7 응답으로 상태만 갱신하고 알림·리액션을 건너뛴다. 후속 알림·리액션 실패는 로그만 남기며 DB를 되돌리거나 자동 재시도하지 않는다.
- [x] 아이템 등록 callback 전송 자체가 실패해도 DB는 `uploaded`와 입력 이름을 유지한다. 자동 재시도는 없고, 구매 전에는 버튼을 다시 눌러 모달을 제출하면 수정 알림을 보낼 수 있다. 화면은 갱신되지 않을 수 있으며 분배자는 `/미완료`로 이름을 확인할 수 있다. `DISCORD_TOKEN`이 틀리면 callback까지 실패할 수 있다(라이브러리가 Bot Authorization을 사용하므로 생기는 추정이며 실제 Discord에서는 미확인).
- [x] 버튼의 `uploaded;<splitId>`와 DB의 `uploaded` 상태는 호환성을 위해 유지하고 화면에는 `아이템 등록`·`등록 완료`로 표시한다. 모달 ID는 `item;<splitId>`다. 저장은 active 분배의 pending/uploaded 행에만 적용하며 첫 등록 시각은 수정해도 유지한다.
- [x] 모달은 버튼에서 열고 원본 메시지가 있는 제출에만 type 7을 사용한다. 메시지가 없는 제출은 비공개 안내로 거절한다. 제출 시 권한·상태를 다시 검사하고, 구매·종료 후 제출과 권한 있는 버튼 클릭은 최신 상태를 다시 그린다.
- [x] 테스트 D1 초기화에는 명시적인 비밀값 없는 환경 파일 경로를 지정한다. Wrangler는 `envFiles: []`만으로는 `.dev.vars` 로드를 막지 않으므로 빈 배열은 쓰지 않는다.
- [x] 등록 스크립트는 Node 24의 타입 제거와 `--env-file-if-exists=.dev.vars`를 쓴다. 파일이 없어도 누락된 필수 변수 안내를 출력하고 API 호출 없이 종료하기 위해 `--env-file` 대신 선택했다. 길드 등록에서는 전역 전용 필드 `contexts`, `integration_types`를 제거한다.
- [x] 새 의존성 없이 Wrangler `getPlatformProxy({ persist: false })`의 실제 로컬 D1을 테스트한다. 기존 계산 모듈과 서명 테스트 파일은 변경하지 않았다.
- [x] Workers Logs는 Free에도 포함되어 `observability.enabled`를 켰다. 2026-10-31 확인 기준 무료는 하루 200,000 events, 보관 3일이며 무료 초과 과금 항목은 없다. Paid는 월 20,000,000 events 초과분에 $0.60/백만 events가 붙으므로 유료 전환 전 재검토한다. 2026-12-01부터 Observability 요금제로 전환되며 Free는 하루 0.5GB 수집·7일 보관, 초과 시 수집 중지 후 00:00 UTC에 재개한다. 무료 플랜에 자동 초과 과금은 없다.
- [x] Node 24 테스트에서는 `zz`, `abc`, `00` 서명도 라이브러리가 401을 반환하지만, 실제 Wrangler 로컬 런타임에서 형식 검사 래퍼를 우회하면 `zz`가 hex 변환 예외로 500을 반환하는 것을 재현했다. 래퍼 복원 후 401을 확인했다. 런타임별 `Uint8Array.fromHex` 차이가 원인이다.

## 5. 기존 미결정
- [ ] 라이선스가 아직 없고 `LICENSE` 파일도 없다.
- [ ] `docs/workflow.md` 금지 항목에 과거 강제 푸시 예외 경위는 적혀 있지 않다. 이번 작업에서는 강제 명령이나 푸시를 하지 않았다.
- [ ] CI/CD는 프로토타입 이후로 보류한다.

## 6. 사용자가 결정할 것
- [ ] 안내 메시지가 지워지면 버튼이 사라져 그 분배를 취소·구매 처리할 수 없고 `/미완료`에 계속 남는다. 대안은 `/미완료`에 버튼을 붙이거나 취소 명령을 추가하는 것이다.
- [ ] 구매 완료 오클릭은 되돌릴 수 없다. 마지막 오클릭은 즉시 분배 완료 처리된다. 되돌리기 기능이 필요한지 결정한다.
- [ ] 취소 버튼에는 확인 단계가 없다. 추가 확인이 필요한지 결정한다.

## 확인에 사용한 공식 문서
- 명령·옵션 이름과 전역 전용 필드, 길드 등록 권한: https://docs.discord.com/developers/interactions/application-commands
- HTTP 202·callback·최초 응답 3초·type 7은 MODAL_SUBMIT/컴포넌트에 허용·컴포넌트에서 연 모달의 message 필드: https://docs.discord.com/developers/interactions/receiving-and-responding
- 임베드 제한(제목 256·설명 4096·메시지 전체 임베드 6000자): https://docs.discord.com/developers/resources/message#embed-object-embed-limits
- discord-hono 0.23.0 설치 소스: `node_modules/discord-hono/dist/index.d.mts`의 ModalContext는 update를 제외하지 않으며, `index.mjs`의 update는 interaction type 3과 5를 허용한다.
- Ed25519 헤더와 서명 실패 401: https://docs.discord.com/developers/interactions/overview
- Workers Logs 설정·무료 한도: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- Workers 요금: https://developers.cloudflare.com/workers/platform/pricing/
- 2026-12-01 적용 Observability 요금·무료 초과 시 중지: https://developers.cloudflare.com/observability/pricing/
