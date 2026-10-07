# 1.0.0 안정화 작업판

이 문서는 `@nestarc/idempotency` 1.0.0 개발을 이어갈 때의 시작점이다. [조사 문서](../1.0.0-stabilization-research.md)는 발견 당시의 근거를 보존하고, 이 작업판과 작업별 문서는 구현 상태와 다음 행동을 관리한다.

작성일: 2026-10-06. 조사 기준은 0.4.0, `9610774a767d152c4cbae49c6276a4f2d76463e4`이다. **S1~S8 구현과 로컬 통합 검증 완료.** 아직 릴리스하지 않았다. S8의 clean snapshot·동일 tarball은 지원 8개 조합을 통과했다. 외부 RC/운영 도입은 미실시이며 실제 출시 tag의 GitHub gate와 게시 판단은 별도다.

## 문서 사용 순서

1. 아래 작업판에서 작업을 선택하고 현재 checkout의 변경 사항을 확인한다. 조사 기준 커밋 이후 변경된 코드는 다시 읽는다.
2. 선택한 작업 문서의 근거, 선행 조건, 작은 작업 체크리스트와 `다음 작업자에게`를 읽는다.
3. [결정 기록](decisions.md)에서 관련 정책을 확인한다. 미결 정책은 근거와 호환성 영향을 검토해 기록한 뒤 해당 구현에 반영한다. 후보 API를 이미 확정된 요구로 취급하지 않는다.
4. 작업 시작 시 이 작업판의 상태·담당·다음 행동을 갱신한다. 중단할 때는 작업 문서에 변경 내용, 검증 결과, 남은 문제와 다음 행동을 남긴다.
5. 완료 조건과 검증 증거가 충족됐을 때만 `DONE`으로 바꾸고 후속 작업에 변경된 계약을 전달한다.

문서별 역할은 다음과 같다.

| 문서 | 관리하는 정보 |
| --- | --- |
| [조사 문서](../1.0.0-stabilization-research.md) | 재현 사실, 사용자 불편 출처, 조사 기준선과 한계 |
| 이 작업판 | 작업 상태·담당·선행 관계·현재 다음 행동의 단일 원본 |
| 작업별 S1~S8 문서 | 수정 범위, 재현 방법, 세부 체크리스트, 완료 증거와 인수인계 |
| [결정 기록](decisions.md) | 공개 API·저장 형식·실패 정책의 미결 사항과 결정 이유 |

## 작업 목록

상태는 `TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE`을 사용한다. 선행 작업을 아직 시작하지 않았다는 이유만으로 `BLOCKED`로 바꾸지 않는다. 실제로 진행이 막힌 경우 이유와 해제 조건을 작업 문서에 기록한다. 필수 범위를 제외하려면 결정 기록과 조사 범위와의 차이를 먼저 남긴다.

| ID | 작업 | 상태 | 담당 | 최종 통합 전 선행 조건 | 다음 행동 |
| --- | --- | --- | --- | --- | --- |
| S1 | [응답 재생 정확성](work-items/S1-response-replay.md) | DONE | Codex | 없음 | D01/지원 표/전환 규칙 인계 완료. S5는 S6 확정 뒤 완료 파이프라인에 통합 |
| S2 | [소비자 설치와 공개 API](work-items/S2-consumer-package.md) | DONE | Codex | 없음 | D02 및 S7/S8 인계 완료. S8에서 동일 tarball 소비자 검사를 최종 matrix에 연결 |
| S3 | [요청 격리와 키 계약](work-items/S3-request-isolation.md) | DONE | Codex | 없음 | D03 확정, 605 pass/0 skip·tarball 소비자 검증. S4 namespace 및 S7/D07 전환 조건 인계 완료 |
| S4 | [관측 정보 보호](work-items/S4-observability.md) | DONE | Codex | S3의 namespace, S5의 실패 경로 | S5/D05 최종 오류·취소 경로 및 기존 payload/callback 회귀 통과, S4-4 완료 |
| S5 | [장애와 요청 수명주기](work-items/S5-failure-lifecycle.md) | DONE | Codex | S1의 응답 완료 경계, S6의 만료/token 수명 계약 | D05/D06 수명 계약, 실제 crash10개 포함768 pass/0 skip, 운영 조정 가이드·S7/S8 인계 완료 |
| S6 | [저장소 공통 계약](work-items/S6-storage-contract.md) | DONE | Codex | 없음 | D06 긴 TTL·직접 호출 선행 검증 완료. 실제 Redis/PG 포함908 pass/0 skip, S7/S8 인계 |
| S7 | [도입 예제와 전환 문서](work-items/S7-adoption-docs.md) | DONE | Codex | S1~S6의 확정 계약 | D07 확정, 전체937 pass/0 skip·소비자45 pass/기대 실패3, 실행 예제·전환 절차를 S8에 인계 |
| S8 | [출시 검증](work-items/S8-release-validation.md) | DONE | Codex | S1~S7 완료 | D08 확정, 8개 cell 각각937 pass/0 skip·동일 tarball 소비자·실패 gate 검증. 실제 tag/외부 RC/출시는 별도 판단 |

선행 조건은 최종 완료를 위한 조건이다. S4의 노출 회귀 테스트, S7의 DI 수정·예제 작성, S8의 CI 준비는 먼저 할 수 있다. S1~S8은 기능 묶음이며 한 커밋의 크기를 강제하지 않는다. 각 문서의 `S번호-번호` 체크리스트를 작은 구현·검증 단위로 사용한다. 더 나눌 필요가 있으면 같은 ID 아래에 추가하고 부모의 완료 조건을 유지한다.

## 순서와 병렬 작업

- 우선 S1의 정보 노출과 S2의 설치 실패를 다룬다. S3·S6은 독립적으로 설계와 회귀 테스트를 시작할 수 있다.
- S1과 S6의 계약을 바탕으로 S5의 실패·취소 동작을 통합한다. S3와 S5가 정해진 뒤 S4의 namespace·오류 이벤트를 마무리한다.
- S7은 확정된 계약을 실제 예제와 업그레이드 절차로 묶고, S8은 동일한 릴리스 대상에 대해 최종 검증한다.
- S1·S3·S4·S5는 같은 인터셉터를 수정한다. 서로 다른 작업자가 같은 파일을 동시에 수정하기 전에 담당 범위와 적용 순서를 기록한다. 테스트 작성·설계 검토는 병렬 진행할 수 있다.
- S2가 확정한 export/타입 경계를 S3·S4의 공개 API 변경에도 적용한다. 최종 조합은 S8에서 다시 검증한다.

## 공통 구현과 검증 규칙

[CONTRIBUTING](../../CONTRIBUTING.md)의 회귀 테스트 규칙을 따른다. 버그 수정에는 수정 전 실패·수정 후 성공하는 `test/regression/` 테스트와 원인 설명을 포함한다. 저장소 계약이나 어댑터를 바꾸면 `test/support/shared-storage-contract.ts`도 함께 갱신한다.

검증은 저장소 루트에서 실행한다. 작업 문서의 관련 테스트를 먼저 실행하고, 통합·릴리스 시 전체 검증을 실행한다. 문서만 변경한 작업에 제품 테스트를 반복할 필요는 없다.

```sh
npm run lint
npx tsc --noEmit --incremental false -p tsconfig.json
npm run build
npm run test:all -- --runInBand
```

실제 저장소 검증에는 테스트 전용 `TEST_DATABASE_URL`과 `TEST_REDIS_URL`이 필요하다. [docker-compose.yml](../../docker-compose.yml)은 PG16/Redis7을 함께 제공한다 (`docker compose up -d --wait`). 연결 문자열의 비밀번호·토큰은 결과 문서에 남기지 않는다. `npm run prepublishOnly` 실행 시에도 실제 DB 환경이 없으면 관련 검사가 skip될 수 있다.

조사 당시 결과는 lint·타입 검사·build·pack dry-run 성공, **198 pass / 39 skip**이었다. skip은 Postgres 28개와 실제 Redis 11개이며 Docker daemon이 없었다. 이 결과는 새 구현이나 출시 대상의 검증을 대신하지 않는다. 임시 probe나 형제 프로젝트의 의존성을 새 검증의 전제로 사용하지 말고, 필요한 fixture·개발 의존성을 이 저장소에서 재현 가능하게 준비한다.

검증마다 아래를 작업 문서에 남긴다. 실행하지 않은 명령은 성공으로 적지 않는다.

| 일시 | 대상 commit 또는 artifact | 환경 | 실행 명령 | 결과와 pass/fail/skip 수 | 증거 위치와 남은 제한 |
| --- | --- | --- | --- | --- | --- |
| 2026-10-06 | `9610774` + S1 작업 트리 | Node24 / Nest11 / 실제 DB 없음 | prepublishOnly 및 개발 타입 검사 | 293 pass / 41 skip, lint/type/build 성공 | [S1 기록](work-items/S1-response-replay.md), 실제 DB·지원 matrix는 S8 |
| 2026-10-06 | `c5dff13` + S2 작업 트리 | Node24.11.1 / Nest11.1.18 / Redis7.2.7 / PG16.14 | clean npm ci, prepublishOnly, 타입 검사, 실제 tarball 소비자 | 351 pass / 0 skip; 소비자41 pass / 기대된 실패3 / 0 skip | [S2 기록](work-items/S2-consumer-package.md), SHA-256·로그 보존; 최종 matrix는 S8 |
| 2026-10-07 | `e2b9cec` + S3 작업 트리 | Node24.11.1 / Nest11 / Redis7.2.7 / PG16.14 | lint/type/build, 전체 테스트, 실제 tarball 소비자 | 605 pass / 0 skip; 소비자41 pass / 기대된 실패3 / 0 skip | [S3 기록](work-items/S3-request-isolation.md), D03 및 S2/S4/S7 인계; 최종 matrix는 S8 |
| 2026-10-07 | `2fc43d7` + S4 작업 트리 | Node24.11.1 / Nest11 / Redis7.2.7 / PG16.14 | prepublishOnly, 개발 타입 검사, 실제 tarball 소비자 | 681 pass / 0 skip; 소비자41 pass / 기대된 실패3 / 0 skip | [S4 기록](work-items/S4-observability.md), D04 및 S2/S5/S7/S8 인계; 당시 S5 최종 통합 미완료 |
| 2026-10-07 | `e13b370` + S5 작업 트리 | Node24.11.1 / Nest11 / Redis7.2.7 / PG16.14 | prepublishOnly, 개발 타입 검사, 실제 crash fixture, tarball 소비자 | 768 pass / 0 skip; 소비자41 pass / 기대된 실패3 / 0 skip | [S5 기록](work-items/S5-failure-lifecycle.md); S4 최종 통합, D06 수명 계약; S6-5/S8 잔여 |
| 2026-10-07 | `2074060` + S6 작업 트리 | Node24.11.1 / Nest11.1.18 / Redis7.2.7 / PG16.14 | lint/type/build, 전체 테스트, 실제 tarball 소비자 | 908 pass / 0 skip; 소비자41 pass / 기대된 실패3 / 0 skip | [S6 기록](work-items/S6-storage-contract.md), D06 전체 완료; S7/S8 잔여 |
| 2026-10-07 | `8e22192` + S7 작업 트리 | Node24.11.1 / Nest11 / Redis7.2.7 / PG16.14 | lint/type, build·adoption gate, 최종 전체 회귀 | 937 pass / 0 skip; 소비자45 pass / 기대된 실패3 / 0 skip | [S7 기록](work-items/S7-adoption-docs.md), D07·예제·전환 인계; S8 잔여 |
| 2026-10-07 | `34e54f2` + S8 변경을 고정한 로컬 clean snapshot `6f9a359` | Node22.23.3/24.11.1 × Nest10.4.22/11.1.18 × optional peer 하한/대표; PG16.14/Redis7.2.7 | 공통 build/validate/verify-matrix, 동일 tarball 전달·게시 dry-run, 실제 실패 주입 | 8개 cell 각각41 suites/937 pass/0 skip, 소비자45 pass/기대 실패3/0 skip; gate45 pass | [S8 기록](work-items/S8-release-validation.md), [증거 JSON](evidence/S8-validation.json); remote CI/외부 RC/게시 미실시 |

S8 최신 증거: Node22/24 × Nest10/11 × optional peer 하한/대표 **8개 cell**에서 전체 검증과 동일 tarball 소비자 검증 완료.
각 cell은 실제 PG/Redis 포함 **937 pass / 0 skip**, 소비자 **45 pass / 기대된 실패3 / 0 skip**이다.
실패 gate **45 pass**, 실제 소비자 fixture 실패 및 artifact 누락/변조/commit 불일치 거절도 확인했다.
Node20 지원 종료, ioredis5.0.0 공개 선언 호환 수정, 공통 CI/release gate·동일 artifact 게시·검증 전용 dispatch를 반영했다.
[상세 S8](work-items/S8-release-validation.md#2026-10-07-s8-최종-구현과-검증), [D08](decisions.md#d08--출시-matrix와-동일-artifact-decided),
[RC 미실시 한계와 시나리오](release-candidate.md)를 따른다. 실제 npm publish/tag/push/remote dispatch는 수행하지 않았다.

S7 최신 증거: sweep DI 수정, 공식 예제와 결제/주문/webhook recipe, D07 전환·rollback 안내 완료.
실제 Redis7.2.7/PG16.14 포함 전체 **41 suites / 937 pass / 0 skip**, lint·타입·build 통과.
실제 tarball 소비자 **45 pass / 기대된 실패3 / 0 skip**, 문서 namespace 코드4개 정상/거절 검증.
[상세 기록](work-items/S7-adoption-docs.md#2026-10-07-s7-최종-구현과-검증)과 [보존 JSON](evidence/S7-validation.json)을 따른다.
S8에 `npm run test:adoption`, 실제 artifact·최종 지원 matrix와 검증 한계를 인계했다.

S6 최신 증거: D06 TTL 1~2,147,483,647초와 Memory 분할 timer, 직접 호출 선행 검증 완료.
실제 Redis7.2.7/PG16.14 포함 전체 **38 suites / 908 pass / 0 skip**, lint·타입·build 통과.
실제 tarball 소비자 **41 pass / 기대된 실패3 / 0 skip**.
[상세 기록](work-items/S6-storage-contract.md#2026-10-07-s6-최종-검증-증거)과
[보존 JSON](evidence/S6-validation.json)을 따른다. 최종 지원 matrix·출시 gate는 S8에 남는다.

S5 최신 증거: D05 오류/취소/crash 정책과 D06 수명 계약 통합, 전체 **768 pass / 0 skip**,
실제 tarball 소비자 **41 pass / 기대된 실패3 / 0 skip**. [검증 JSON](evidence/S5-validation.json)과
[crash 원시 기록](evidence/S5-crash-experiments.json)을 따른다. 실제 Redis/PG child SIGKILL10개,
업무 원장·만료 전후 retry를 검증했다. network outage/서버 failover/HTTP disconnect 실험은 아니다.
S4-4 및 S5 최종 관측 경로 완료 조건도 함께 닫았다. 당시 남았던 S6-5는 위 S6 결과로 완료했고 S8 전체 matrix는 남는다.

S4 기존 증거: S4 자체 구현의 전체681 pass/0 skip 및 소비자41 pass/기대된 실패3.
[보존 JSON](evidence/S4-validation.json)은 당시의 S5 통합 전 기록이며, 후속 통합 결과는 위 S5를 따른다.

S3 최신 증거: lint·개발 타입 검사·build 성공, 실제 Redis/PG 포함 **605 pass / 0 skip**.
실제 tarball 소비자 **41 pass / 기대된 실패3 / 0 skip**. Node24/Nest11 대표 환경이며
[상세 기록](work-items/S3-request-isolation.md#검증-증거--2026-10-07)과
[보존 JSON](evidence/S3-validation.json)을 따른다.

S1 최신 증거: `npm run prepublishOnly`(clean/lint/test/build), 전체 개발 타입 검사 통과.
**293 pass / 41 skip**(실제 PG29·Redis12). Node24.11.1, Nest common/core11.1.18,
Express adapter11.1.18/Fastify adapter11.1.19, class-transformer0.5.1.
세부 재현·검증은 [S1 검증 기록](work-items/S1-response-replay.md#검증-증거-2026-10-06)을 따른다.
이는 S8의 실제 DB·지원 matrix·tarball 출시 검증을 완료한 기록이 아니다.

## 맥락을 넘길 때의 기록

작업 문서의 `다음 작업자에게`에 다음 정보를 갱신한다. 상태 자체는 이 작업판에서만 관리한다.

```text
마지막 갱신:
작업자 / branch 또는 작업 위치:
기준 commit과 현재 변경 파일:
완료한 작은 작업 ID:
채택한 결정 ID와 이유:
검증 명령 / 결과 / skip 이유 / 증거:
남은 문제와 실패한 접근:
다음에 실행할 구체적인 한 단계:
후속 작업에 넘길 API / 저장 키 / schema / 오류 정책 변경:
```

작업 재개 요청 예시:

> docs/1.0.0/README.md와 S1 작업 문서, 관련 decisions를 읽고 S1의 다음 미완료 항목부터 진행합니다. 현재 코드와 선행 조건을 확인하고 필요한 회귀 테스트·수정을 수행합니다. 종료 전에 검증 결과와 다음 행동을 문서에 갱신합니다.

## 출시 준비 완료 조건

- [x] S1~S8의 구현·로컬 완료 기준과 검증 증거가 기록되어 있다.
- [x] 구현에 영향을 주는 미결 결정이 없으며 공개 API·키 형식·schema·실패 정책·런타임 지원 변경을 S7에 반영했다.
- [x] 실제 Redis/Postgres 필수 검사가 skip 없이 통과했고, 실제 tarball의 소비자 설치·strict 타입 검사·실행을 확인했다.
- [x] 로컬 검증 대상 commit/artifact와 게시 입력이 일치하는 전달 경로 및 npm dry-run을 확인했다.
- [ ] 실제 출시 version/tag 대상 clean commit에서 GitHub gate를 다시 실행하고 별도 출시 결정을 기록한다.
- [x] 최초 요청과 replay의 응답·사용자 격리, 장애 후 재시도·기존 레코드 전환 조건을 자동 fixture로 검증했다. 운영 rollout/rollback은 별도다.
- [x] RC 시나리오와 미확인 한계를 기록했다. 외부 도입팀 검증은 미실시이며 완료로 간주하지 않는다.

이 조건의 완료는 출시 준비 완료를 뜻한다. 이 문서 작성 요청 자체가 npm publish·태그 push를 실행하라는 지시는 아니다.

## 유지할 범위 제한

새 어댑터, ORM별 transaction 통합, 자동 lease 연장, wait 모드, 강제 unlock API, 범용 retry 엔진, 광범위한 오류 캐싱, dual ESM/CJS와 Swagger 자동화는 이번 필수 범위에서 제외한다. 필요한 경우 근거와 영향을 결정 기록에 남겨 별도 범위로 다룬다. HTTP 재시도 보호를 업무 transaction 전체의 exactly-once 보장으로 확대하지 않는다.

## 변경 기록

| 날짜 | 변경 |
| --- | --- |
| 2026-10-06 | 조사 S1~S8을 작업 문서로 분리하고 상태·결정·검증·인수인계 방식 정의. 구현 미착수. |
| 2026-10-06 | S1 완료: 최종 직렬화 JSON/Observable 완료 경계, 미지원 응답 정책, legacy409와 opaque body 전환 구현. D01 확정 및 전체 검증/후속 인계 기록. |
| 2026-10-06 | S2 완료: 선택 peer subpath·공개 타입·격리 tarball 실행기, 실제 Redis/PG 검증. D02 확정 및 S7/S8 인계. |
| 2026-10-07 | S3 완료: identity+endpoint 합성, v1 tuple hash, 입력 검증, 양 adapter 인증·서명 replay 검증. D03 확정 및 별도 namespace/업무 중복 방지 전환 조건을 D07/S7에 인계. |
| 2026-10-07 | S4 자체 구현·검증: D04 namespace/안전 오류/고정 로그, sync storage 오류 관측, 상태 헤더 replay 차단, 전체·소비자 검증과 후속 인계. S5 최종 통합 전까지 IN_PROGRESS 유지. |
| 2026-10-07 | S5 완료: handler/capture 경계 분리, 취소·불명 쓰기·실제 child crash10개, 전체768 pass, 소비자 검증·운영 조정 문서. S4 최종 완료, S6 core 통합 및 S6-5 잔여 기록. |
| 2026-10-07 | S6 완료: D06 TTL 범위·직접 호출 검증, Memory deadline 분할 timer, 실제 Redis/PG 공통 계약·전체908 pass/0 skip 및 tarball 소비자 검증. S7/S8 인계. |
| 2026-10-07 | S7 완료: sweep DI 재현·수정, 공개 예제 compile/init/close·업무 recipe·D07 전환/rollback, 전체937 pass/0 skip 및 실제 tarball 소비자45 pass/기대된 실패3. S8 인계. |
| 2026-10-07 | S8 완료: D08 지원8개 조합·실DB skip0·동일 tarball 소비자·45개 실패 gate와 실제 실패 주입, artifact 전달/게시 dry-run, RC 시나리오와 외부 미실시 한계 기록. 실제 출시는 별도. |
| 2026-10-07 | 후속 버전 bump: package/lockfile 1.0.0 및 CHANGELOG 갱신. 기존 S8 증거는 bump 이전 0.4.0으로 보존하며 최종 1.0.0 artifact는 공통 gate에서 재검증한다. 게시/tag/push 미실시. |
