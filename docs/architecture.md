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
- 봇은 슬래시 명령과 버튼만 쓰므로 Gateway 상시 연결이 필요 없다. 호출될 때만 실행되어 관리할 서버가 없고 절전 문제도 없다.
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
- 안내, 상태 변경, 알림은 상호작용 응답으로 처리한다.
- 동시 클릭으로 상태가 덮어써지지 않도록 파티원별 상태를 개별 행으로 갱신한다.

## 6. CI/CD
GitHub Actions 워크플로로 검사와 배포를 처리한다. 공개 저장소의 표준 러너는 무료다.

| 단계 | 실행 시점 | 내용 | 상태 |
|---|---|---|---|
| CI | PR, `main`과 `claude/**` 푸시 | `npm ci`, 타입 검사, 테스트, `wrangler deploy --dry-run` | 구현 |
| CD | `main` 푸시 중 `v<버전>` 태그가 없을 때 | 검사, D1 마이그레이션 적용, Worker 배포, 슬래시 명령 등록, 태그, GitHub 릴리스 | 미구현 |

- 버전이 바뀐 푸시만 배포한다. 아직 내보내지 않을 기능을 `main`에 넣어도 실행 중인 봇은 바뀌지 않는다. 규칙은 [작업 규칙](workflow.md)을 따른다.
- 배포 단계에서 앞 단계가 실패하면 뒤 단계를 실행하지 않고 태그도 남기지 않는다. 고친 커밋을 합치면 같은 번호로 다시 돈다.
- 설정을 저장소에서 관리하려고 Workers Builds 대신 GitHub Actions를 쓴다. Workers Builds도 무료 플랜에 월 3,000분이 포함되어 있다.
- 배포는 lockfile에 고정된 버전의 `npx wrangler`로 실행한다.
- 비밀값은 `main` 푸시의 배포 단계에서만 쓴다. 외부 PR에는 비밀값이 전달되지 않게 하고 `pull_request_target`은 쓰지 않는다. 액션은 커밋 SHA로 고정한다.
- `wrangler rollback`은 코드만 되돌리고 DB는 되돌리지 않는다. 자동 배포에는 테이블이나 컬럼을 추가하는 마이그레이션만 태우고 삭제는 따로 처리한다.

## 7. 미검증 사항
- Workers와 D1만 쓸 때 가입에 카드가 필요 없는지는 공식 문서에서 확인하지 못했다.
- 서명 검증과 DB 처리가 CPU 10ms 안에 들어오는지는 첫 배포 때 확인한다.
- 봇 토큰으로 일반 API를 호출하기 전에 Gateway 접속이 필요한지는 확정하지 못했다. 완료 이모지만 일반 API가 필요하며, 안 되면 메시지에 ✅를 넣는 것으로 대체한다.
- 아키텍처 전체를 실제로 배포해 보지 않았다.
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
