# 아키텍처

조사 기준일은 2026-10-31이다. 무료 조건과 한도는 바뀔 수 있다.

## 1. 결정 사항

| 항목 | 결정 |
|---|---|
| 실행 환경 | Cloudflare Workers 무료 플랜 |
| DB | Cloudflare D1 |
| 디스코드 연동 | HTTP Interactions (Interactions Endpoint URL) |
| 라이브러리 | `discord-hono` (조사 시점 0.23.0) |
| 언어 | TypeScript |
| 테스트 | Vitest |

## 2. 선택 이유
- 봇은 슬래시 명령, 버튼, 모달 제출을 HTTP로 처리하므로 Gateway 상시 연결이 필요 없다. 호출될 때만 실행되어 관리할 서버가 없고 절전 문제도 없다.
- 분배 내역과 미완료 조회에는 DB가 필요하다. 진행 상태도 DB를 기준으로 하고, 디스코드 메시지는 그 상태를 보여주기만 한다.
- 무료 플랜은 한도를 넘으면 자동 청구되지 않고 요청이 실패한다.

## 3. 무료 한도

| 항목 | 한도 |
|---|---|
| Workers 요청 | 하루 100,000건 |
| Workers CPU | HTTP 요청당 10ms (네트워크와 DB 대기 시간 제외) |
| D1 읽기 | 하루 500만 행 (스캔한 행 기준이라 인덱스가 중요하다) |
| D1 쓰기 | 하루 10만 행 |
| D1 저장 | DB당 500MB, 계정 합계 5GB |

D1의 일일 한도는 00:00 UTC에 초기화된다.

## 4. 제외한 선택지

| 선택지 | 제외 이유 |
|---|---|
| Oracle 무료 VM | 서버를 직접 관리해야 하고, 사용량이 적으면 회수될 수 있다. |
| Google e2-micro | 공인 IPv4 비용이 월 약 $3.60 들어 완전 무료가 아니다. |
| Render, Koyeb | 무료 플랜은 트래픽이 없으면 꺼지고 무료 영구 저장이 어렵다. |
| Railway | 월 $1 크레딧 안에서 계속 실행된다고 보장할 수 없다. |
| Fly.io | 지속 무료 플랜이 없다. |
| 개인 PC | PC가 꺼지면 봇도 멈춘다. 테스트 용도로만 쓴다. |

## 5. 구현 제약
- 모든 요청의 서명(`X-Signature-Ed25519`, `X-Signature-Timestamp`)을 변형하지 않은 원문 본문으로 검증하고, 실패하면 401로 응답한다.
- PING(`type: 1`)에는 PONG(`{"type":1}`)으로 응답한다.
- 최초 응답은 3초 안에 해야 한다. interaction token은 15분만 유효하므로 DB에 저장해 두고 쓰지 않는다.
- 버튼은 고정 `custom_id`와 DB 조회로 처리해 재배포 후에도 동작하게 한다.
- 공개 분배의 안내, 상태 변경, 알림은 상호작용 응답으로 처리한다. 비공개 생성·다른 채널에서의 비공개 재게시 카드는 REST로 원래 스레드에만 보내고, 상호작용에는 본인 전용 지연 응답과 링크·실패 안내만 보낸다.
- `split`과 `private-split` 모달은 하나의 필드 정의를 공유한다. 처음 제출할 때는 패널 message가 붙어도 `update(false)`와 EPHEMERAL의 type 4로 새 미리보기를 보내 패널을 갱신하지 않는다. 비공개 확인은 type 6 지연 갱신 뒤 `resDefer`의 waitUntil에서 기존 생성·초대·저장·게시를 순서대로 수행하고 모든 예외를 잡는다. PATCH @original에는 빈 embeds·components를 넣어 금액·버튼을 지운다.
- 0004 `split_drafts`는 id, guild_id, user_id, StoredSplit JSON payload, created_at을 저장한다. payload의 채널 ID는 원래 채널이며 private_thread로 종류를 유지한다. 조회·교체·`DELETE ... RETURNING payload` 소비에 서버와 작성자 조건을 넣는다. custom_id에는 동작 키와 임시 ID만 담는다. 수정은 같은 행의 payload만 바꾸고, 확인은 소비한 최신 payload로 만들며 분배 created_at을 확인 시각으로 바꾼다. 생성 후 24시간보다 오래된 임시 행은 기존 3개월 정리와 같은 batch에서 삭제하고 건수만 추가 기록한다.
- 공개 확인은 createSplit 뒤 type 7 callback으로 미리보기를 완료 안내로 바꾸고 callback 성공 후 웹훅 POST로 공개 카드를 게시한다. 실패하면 동작 이름·status만 로그에 남기고 PATCH @original에 `/미완료` 복구를 안내한다. 토큰이 없으면 type 4 공개 카드를 반환한다. 저장 실패는 새 나만 보기 응답이다.
- discord-hono 0.23.0의 `followup`은 환경의 `DISCORD_APPLICATION_ID`를 요구한다. 현재 바인딩을 늘리지 않고 interaction.application_id를 사용한 원본 응답 PATCH로 동일한 지연 응답 편집을 한다. private 경로 로그에는 동작 이름·status만 남기며 예외 객체나 메시지를 출력하지 않는다.
- 0003 마이그레이션은 `splits.private_thread INTEGER NOT NULL DEFAULT 0`을 추가한다. 공개·기존 행은 0, 비공개는 1과 스레드 channel_id를 저장한다. 모든 사용자 초대 성공 전에는 저장하지 않는다. 카드 POST가 4xx(429 포함)로 거절되면 멤버·분배를 하나의 D1 batch로 삭제하고 삭제도 실패하면 비공개 `/미완료` 재게시를 안내한다. 5xx·네트워크 예외는 게시 결과가 불명확하므로 행을 유지하고 스레드 확인 후 카드가 없으면 `/미완료`로 복구한다. 저장 예외는 커밋 여부가 불명확하므로 삭제를 시도하며 삭제까지 실패하면 `/미완료`에 보이는 경우 재게시하도록 안내한다. 자동 재시도와 공개 fallback은 없다.
- 스레드 생성은 type 12, invitable false, auto_archive_duration 10080이다. 완료 시 잠금·보관과 제외자 추방을 하지 않으며 Manage Threads 없이 동작하도록 구현했다. 다만 `invitable: false` 스레드에 봇이 파티원을 추가할 수 있는지는 실제 Discord에서 아직 확인하지 않았다. 비공개 재게시 실패는 본인 전용 안내로 끝난다. Discord의 메시지 전송에 따른 보관 해제는 실환경 미확인이다.
- 동시 클릭으로 상태가 덮어써지지 않도록 파티원별 상태를 개별 행으로 갱신한다.
- `/분배`는 옵션 없이 Label 모달(`split`)을 열고 제출에는 새 나만 보기 미리보기(type 4 + ephemeral)로 응답한다. `edit-split;<draftId>` 버튼은 금액 value·라디오 옵션 default·사용자 선택 default_values로 미리 채운 창을 열고 제출 시 같은 미리보기를 type 7로 갱신한다. 세 필드는 [공식 컴포넌트 문서](https://docs.discord.com/developers/components/reference)와 설치된 discord-api-types에서 지원을 확인했다. 설치 타입의 User Select 설명에는 메시지 전용이라는 오래된 주석이 있지만 Label union과 공식 문서는 모달을 지원한다. 버튼에서 연 `percent;<id>`·`item;<id>` 모달은 message가 있는 제출에만 type 7을 사용한다. Label 내부의 Text Input·Radio Group은 value, User Select는 values를 `c.get(custom_id)`로 읽는다.
- 비율 변경은 하나의 D1 batch에서 부모·모든 멤버를 함께 저장한다. 모든 UPDATE에 서버·분배자·active·등록/구매자 없음 조건을 걸고 멤버는 pending/excluded만 허용한다. 경매장 등록이 먼저 저장되면 비율은 어느 행도 바뀌지 않는다. 새 마이그레이션은 없다.

## 6. CI/CD
GitHub Actions CI를 `.github/workflows/ci.yml`에 구현했다. 로컬에서도 `npm run typecheck`, `npm test`, `npx wrangler deploy --dry-run`을 실행한다. CI의 실제 원격 실행은 아직 확인하지 않았다. 공개 저장소의 표준 러너는 무료다.

| 단계 | 실행 시점 | 내용 | 상태 |
|---|---|---|---|
| CI | PR, `main`과 `claude/**` 푸시 | Node 24, `npm ci`, 타입 검사, 테스트, `wrangler deploy --dry-run` | 구현, 실행 미확인 |
| CD | 추후 결정 | 현재는 수동 릴리스 | 보류 |

- CI는 배포하지 않으며 비밀값도 쓰지 않는다. `permissions: contents: read`이고 액션은 조회한 커밋 SHA로 고정한다. `pull_request_target`은 쓰지 않는다.
- 검사를 필수로 하려면 ruleset 설정이 필요하며 아직 필수가 아니다.
- 배포·마이그레이션·전역 명령 등록·태그는 [작업 규칙](workflow.md)의 수동 절차를 따른다. 명령 정의를 바꿨다면 Worker를 먼저 배포한다.
- `wrangler rollback`은 코드만 되돌리고 DB는 되돌리지 않는다.
- 매일 `0 18 * * *`(KST 03:00) Cron으로 생성 후 3개월 지난 모든 상태의 분배를 삭제한다. UTC 월말을 보정하고 같은 D1 batch에서 멤버 다음 분배 순서로 삭제한다. 성공은 건수만, 실패는 오류 이름만 기록하고 자동 재시도하지 않는다.

## 7. 미검증 사항
- 나만 보기 메시지 버튼에서 공개 후속 메시지 게시, 같은 미리보기 갱신, 입력창의 금액·수수료·파티원 미리 채움 실제 표시. 공식 필드 지원 확인과 fetch mock 검사는 실환경 확인이 아니다.
- Workers와 D1만 쓸 때 가입에 카드가 필요 없는지는 공식 문서에서 확인하지 못했다.
- 0.4.0은 배포됐고 소유자가 테스트 서버에서 입력·카드·비율·등록·구매를 확인했다. 실제 파티 사용·전역 표시는 1.0 판단에서 확인된 것으로 간주하는 소유자 결정이며 실제 실행 기록이 아니다.
- 소유자가 Metrics에서 호출 72회, 오류 0, CPU 2ms, Wall 201ms를 봤다. 통계 종류는 화면에서 확인하지 못했고 적은 트래픽 관측이므로 CPU 한도 내 동작을 일반적으로 보장하지 않는다.
- callback·후속 알림·완료 리액션에 REST API를 사용한다. Gateway 연결은 코드에 없으며 실제 완료 리액션·권한 부족·스레드·이스케이프 표시의 개별 검증은 미확인이다.
- 이번 자동 삭제 Cron과 카드 재게시·알림 복구의 실환경 동작은 아직 확인하지 않았다.
- "Edit Cloudflare Workers" API 토큰 템플릿에 D1 편집 권한이 포함되는지 확인하지 못했다. CD를 켤 때 확인한다.

## 8. 출처
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/
- https://docs.discord.com/developers/interactions/overview
- https://docs.discord.com/developers/interactions/receiving-and-responding
- https://discord-hono.luis.fun/
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- https://docs.cloud.google.com/free/docs/free-cloud-features
- https://cloud.google.com/vpc/network-pricing
- https://render.com/docs/free
- https://www.koyeb.com/docs/reference/instances
- https://docs.railway.com/reference/pricing/plans
- https://docs.fly.io/about/pricing
- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
