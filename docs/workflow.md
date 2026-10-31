# 작업 규칙

브랜치, 커밋, 버전, 릴리스 규칙을 정한다.

## 1. 브랜치
- 작은 수정도 최신 `main`에서 `claude/<작업 이름>` 브랜치를 따서 작업한다.
- `main`에 직접 커밋하지 않는다. `develop` 같은 장기 브랜치를 두지 않는다.
- worktree는 동시에 여러 작업을 할 때만 쓴다.
- 외부 기여는 PR로 받는다.

## 2. 커밋
- 한 커밋에는 한 가지 일만 담는다.
- 메시지 첫 줄은 무엇을 바꿨는지 한국어 한 문장으로 쓰고 접두어를 붙이지 않는다. 필요하면 빈 줄 뒤에 이유를 적는다.
- `Co-Authored-By` 공동 저자 줄을 넣지 않는다.

## 3. `main`에 합치기
1. `git fetch origin` 후 `git rebase origin/main`으로 최신 `main` 위에 올린다.
2. `npm run typecheck`, `npm test`, `npx wrangler deploy --dry-run`을 로컬에서 돌려 통과를 확인하고 `git push -u origin HEAD`로 브랜치를 올린다. rebase로 커밋이 바뀌었으면 `--force-with-lease`를 쓴다.
3. `git push origin HEAD:main`으로 합친다. fast-forward만 받아들여지며, 거부되면 1번부터 다시 한다.
4. 원격과 로컬 브랜치를 지운다.

## 4. `main` 보호
GitHub ruleset이 force push, 브랜치 삭제, merge commit을 막는다. CI는 PR과 `main`·`claude/**` 푸시에서 Node 24로 설치·타입 검사·테스트·배포 dry-run을 실행한다. 비밀값을 사용하지 않으며 액션은 커밋 SHA로 고정한다. 검사 필수화는 ruleset 설정이 필요하므로 아직 필수가 아니다. 로컬 검사는 3절 순서대로 지킨다.

## 5. 금지
- `git push --force`, `main`에 들어간 커밋 수정, 배포된 태그 삭제나 이동을 하지 않는다.
- 되돌릴 때는 `git revert`를 쓴다.
- 아직 `main`에 들어가지 않은 자기 작업 브랜치에만 rebase와 `--force-with-lease`를 쓴다.
- 과거 공동 저자 줄 제거를 위한 일회성 히스토리 재작성은 예외였다. 일반 작업에 적용되는 허용이 아니며, 알려지지 않은 세부 경위는 기록하지 않는다.

## 6. 버전
`package.json`의 버전이 기준이고 `MAJOR.MINOR.PATCH`를 쓴다. 마지막 태그 이후의 변경 중 가장 큰 기준에 맞춰 한 자리만 올린다.

| 자리 | 기준 |
|---|---|
| PATCH | 버그 수정, 문구 조정 |
| MINOR | 새 기능, 분배 결과가 달라지는 변경, DB 구조 변경 |
| MAJOR | 구조나 방향이 크게 바뀔 때 (소유자가 결정) |

- 문서, 테스트, CI만 바뀌면 올리지 않는다.
- 첫 배포는 `0.1.0`이다. 1차 범위를 다 만들고 실제 파티에서 써본 뒤 `1.0.0`으로 올린다. 단, 2026-10-31 소유자는 실제 파티 사용과 전역 명령 표시를 1.0 판단에서 확인된 것으로 간주하기로 결정했다. 이는 실제 실행 기록이 아니다.
- 배포된 번호는 다시 쓰지 않는다.

## 7. 수동 릴리스
소유자가 요청할 때만 한다. CD 자동화는 나중 항목으로 남긴다.

1. 작업 브랜치에서 `npm version <major|minor|patch> --no-git-tag-version`으로 버전을 올리고 커밋한다.
2. 3절 순서로 `main`에 합친다.
3. `main`에서 새 D1 마이그레이션이 있으면 `npx wrangler d1 migrations apply ricemonkey-bot --remote`로 적용한다.
4. `npm run deploy`로 Worker를 배포한다.
5. 명령 정의가 바뀌었으면 `npm run register:global`로 전역 등록한다. 새 명령 입력을 옛 Worker가 거부하거나 잘못 해석하지 않도록 코드 배포 뒤에 해야 한다.
6. 배포한 버전 커밋에 `git tag v<버전>`을 붙인다.
7. `git push origin main`과 `git push origin v<버전>`으로 올린다.

명령 등록은 반드시 대상을 고른다. `npm run register:global`은 `DISCORD_GUILD_ID`를 무시한다. `npm run register:guild`는 테스트 서버 ID가 있어야 하며 전역 전용 필드를 뺀다. 서버 지정 등록을 하면 전역 명령과 겹쳐 보일 수 있다. 2026-10-31 Discord 조회로 전역 3개 등록과 테스트 서버 명령이 비어 있음을 확인한 상태다.

실패하면 뒤 단계를 진행하지 않고 원인을 고친다. 태그가 없는 상태를 배포 성공으로 간주하지 않는다.

## 8. 배포 후 문제가 생겼을 때
- 급하면 `npx wrangler rollback`으로 코드부터 복구한다. DB는 되돌아가지 않는다.
- 그다음 문제 커밋을 `git revert`하고 다음 번호로 릴리스한다. 되돌리지 않으면 다음 배포에서 문제가 다시 나온다.
- DB 구조를 바꾼 릴리스는 되돌리지 않고, 새 구조를 읽도록 고친 수정 릴리스를 낸다.
- Worker 버전과 명령 정의가 어긋나면 먼저 배포된 Worker 버전과 해당 커밋을 확인하고, 다음으로 전역·테스트 서버 명령의 실제 등록 범위를 조회한다. 마지막으로 그 커밋의 `src/commands.ts`와 입력 핸들러를 비교한다. Worker 배포를 먼저 맞춘 뒤 필요한 범위만 재등록하며, 전역/서버 중복과 Discord 반영 지연도 구분한다.

## 9. 운영자 삭제 요청 처리
이 절은 운영 절차이며 로컬 검사나 개발 중에는 실행하지 않는다. 공개 이슈에 사용자 ID·서버 ID 외 정보가 적혔다면 더 공개하도록 요구하지 않는다. 요청 대상과 처리 범위를 확인한 뒤, 해당 서버에서 요청자가 분배자 또는 파티원(제외자 포함)으로 참여한 분배 전체를 삭제한다. 같은 분배의 다른 참여자 기록도 함께 지워짐을 안내한다.

1. 아래 SQL의 `SERVER_ID`, `USER_ID`를 요청 범위로 바꾼다. 입력이 Discord 숫자 ID인지 확인하고 SQL에 임의 문자열을 붙이지 않는다.
2. `npx wrangler d1 execute ricemonkey-bot --remote --command "<SQL>"`로 먼저 대상 분배와 멤버 건수를 확인한다. 불필요한 사용자 정보는 조회하지 않는다.

```sql
SELECT COUNT(*) AS splits,
  (SELECT COUNT(*) FROM split_members WHERE split_id IN (
    SELECT s.id FROM splits s WHERE s.guild_id = 'SERVER_ID'
      AND (s.distributor_id = 'USER_ID' OR EXISTS (
        SELECT 1 FROM split_members m WHERE m.split_id = s.id AND m.user_id = 'USER_ID'))
  )) AS members
FROM splits s WHERE s.guild_id = 'SERVER_ID'
  AND (s.distributor_id = 'USER_ID' OR EXISTS (
    SELECT 1 FROM split_members m WHERE m.split_id = s.id AND m.user_id = 'USER_ID'));
```

3. 건수와 범위를 확인한 뒤 같은 조건으로 `SELECT s.id`만 조회하여 대상 분배 ID 목록을 고정한다. 멤버 삭제 후에는 참여 조건으로 다시 찾을 수 없으므로 두 DELETE에 반드시 같은 ID 목록을 쓴다. 아래 `SPLIT_ID`는 고정한 전체 목록으로 바꾸고, 서버 조건도 유지한다. 운영 중 새 참여 기록이 생길 수 있으므로 삭제 후 재조회한다.

```sql
DELETE FROM split_members WHERE split_id IN (
  SELECT id FROM splits WHERE guild_id = 'SERVER_ID' AND id IN ('SPLIT_ID')
);
DELETE FROM splits WHERE guild_id = 'SERVER_ID' AND id IN ('SPLIT_ID');
```

4. 멤버 행을 먼저, 분배 행을 나중에 `wrangler d1 execute --remote`로 실행한다. 실패하면 원인을 확인하고 고정한 목록으로 남은 삭제를 처리한다. 같은 건수 확인을 다시 실행해 0건인지 확인한다. Discord 카드는 별도 삭제가 필요하고 D1 복구 기록에는 [개인정보 안내](privacy.md)의 기간 동안 남을 수 있음을 안내한다.
