# S8 — 출시 검증

- 상태: [작업판](../README.md) 참조. 이 파일은 출시 증거와 검증 연결을 관리한다.
- 조사일: 2026-10-06 · baseline: `9610774` (`@nestarc/idempotency` 0.4.0).
- 근거: [안정화 조사](../../1.0.0-stabilization-research.md)의 출시 범위·검증 한계 항목.
- 착수 조건: CI 골격은 병행 개발 가능. 최종 완료는 S1–S7 완료와 통합 검증을 선행 조건으로 한다.

## 목적

소스 테스트 성공에서 끝나지 않고, 소비자가 받을 같은 배포물이 지원 환경에서 동작함을 확인한다.
release 경로에서 실제 DB 검사가 빠지지 않도록 만들고, 검증한 commit·artifact를 추적할 수 있게 한다.
초기 조사 요청은 문서 작성이었다. 2026-10-07 S8 진행 요청에 따라 아래 gate와 CI를 구현한다. 실제 publish, tag 생성, push, 원격 workflow dispatch는 실행하지 않는다.

## 확인된 근거와 재현 절차

조사 당시 CI는 Node 20/22 × Nest 10/11을 검사하며, 실제 Redis smoke와 Postgres 서비스가 이미 있다.
release의 build-and-test 잡은 PG만 제공하므로 `TEST_REDIS_URL` 없는 Redis spec은 skip된다.
release publish 잡은 다른 Node 환경에서 다시 build하므로 앞서 검증한 tarball을 그대로 게시하는 구조가 아니다.
pack dry-run은 파일 구성 점검이며 설치/import/선언 파일 안전성을 입증하지 않는다.
2026-10-06 공식 Node 표는 20을 EOL, 22/24를 LTS로 표시했다. 지원 정책은 구현 전에 확정한다.
조사 baseline은 Node 24.11.1/npm 11.6.2에서 15 suite 통과, 6 skip; 198 test 통과, 39 skip이었다.
skip은 PG 관련 28개·실제 Redis 11개이며 Docker daemon 부재 때문에 실행하지 못했다.

1. 새 checkout에서 `npm ci`를 수행하고 Node/npm/commit을 기록한다. 기존 개발자의 설치 상태에 의존하지 않는다.
2. 환경 변수 없이 DB spec이 skip되는 현재 경로를 확인한다. 실패 재현 결과이지 출시 성공 조건이 아니다.
3. 테스트 전용 PG 16/Redis 7을 준비하고 두 URL을 설정한 전체 suite와 S6 계약 검사를 실행한다.
4. S2가 제공할 저장소 내 consumer fixture와 실행기로 실제 tarball의 설치·타입·부팅을 검사한다.
5. release workflow의 검증 전용 경로에서 DB 누락과 fixture 실패가 출시 게이트를 차단하는지 확인한다.
6. 같은 commit의 tarball checksum과 소비자 검사 결과를 보존하고, 게시 단계가 해당 artifact를 사용하도록 연결한다.

fixture dependency/lockfile/스크립트는 저장소에 선언한다. 조사자의 `/tmp` 파일이나 형제 저장소를 참조하지 않는다.

## 포함·제외 범위

- 포함: 지원 Node/Nest/HTTP adapter matrix, 실DB 검사, tarball 소비자 검사, 필수 검사 skip 감지.
- 포함: 테스트한 commit·artifact와 게시 입력의 일치, 검증 전용 실행 경로, RC 체크리스트와 결과 기록.
- 포함: 기존 Postgres/Redis 서비스 잡을 재사용하거나 공통화하여 tag 검증과 일반 CI의 차이를 줄이기.
- 제외: 이 문서 작업 중 실제 릴리스, registry 인증 변경, npm publish, tag/push, 별도 장기 성능 프로젝트.
- 제외: 실패한 S1–S7을 검증 예외로 승인하거나 skip을 통과로 바꾸는 작업.

## 구현 전 결정

| 미결 사항 | 결정할 내용 |
| --- | --- |
| Node 지원 정책 | 22/24 필수 검사, Node 20 유지 여부, engines/문서/CI의 일치. |
| 지원 matrix | Nest 10/11과 Express/Fastify, 선택 peer 하한·대표 버전 검사의 범위와 비용. |
| artifact 경로 | 한 번 만든 tarball의 검증·보존·게시 방법과 lifecycle script 재실행에 대한 처리. |
| 실패/skip 게이트 | 환경 누락, 연결 실패, 필수 spec 미발견, 실행 수 감소를 검출할 방식. |
| RC 운영 검증 | 실제 참여 팀/환경, 관찰 기간, 통과·보류 기준. 도입팀이 없으면 외부 검증 미실시로 남긴다. |

공통 결정 **D08**에 지원 matrix·artifact 대안·선택 근거를 기록하고 `OPEN`에서 `DECIDED`로 갱신한다.
결정 자체가 별도 사용자 승인을 요구한다는 뜻은 아니다. CI 작성 전에 게시 경로를 변경했다고 간주하지 않는다.

## 작업 체크리스트

- [x] **S8-1** 지원 matrix를 확정하고 package engines·문서·CI의 차이를 정리한다.
- [x] **S8-2** 일반 CI와 release 검증에서 PG/Redis 준비·health check·URL 전달을 일치시킨다.
- [x] **S8-3** DB 서비스/URL 누락과 필수 테스트 skip을 명시적으로 실패시키는 검증을 추가한다.
- [x] **S8-4** S2 consumer fixture를 동일 tarball로 실행하고 설치 목록·컴파일·부팅 결과를 수집한다.
- [x] **S8-5** tarball checksum/commit 기록과 검증 artifact 전달 경로를 구성한다.
- [x] **S8-6** S1–S7 회귀와 문서 recipe 검증을 모두 연결하고 정상·실패 경로를 검증 전용으로 실행한다.
- [x] **S8-7** JSON 단일 사용자 API, multi-tenant API, PG webhook의 RC 시나리오와 검증 기록을 준비한다.
- [x] **S8-8** 미해결 결함/미검증 환경을 정리하고 별도 출시 결정에 사용할 증거를 제출한다.

## 완료 조건

- S1–S7이 작업판의 완료 조건을 충족하고, 최종 commit에서 전체 통합 검증을 수행했다.
- 결정한 지원 matrix에서 Nest 10/11 및 Express/Fastify 경로가 검증된다.
- tag 대상 commit의 검증 경로에서 실제 PG·Redis 필수 검사가 실행되며 skip 수를 명시적으로 확인한다.
- Memory-only/Redis-only/PG-only 소비자가 동일 tarball을 설치하고 import·strict TS·Nest 부팅/종료를 통과한다.
- pack 내용에 필수 SQL/JS/declarations가 있고 검증한 artifact와 게시 입력의 checksum이 연결된다.
- 서비스 누락·소비자 fixture 실패·검증 artifact 누락을 의도적으로 주었을 때 게이트가 실패한다.
- RC/외부 도입 검증은 수행 여부와 한계를 분리 기록하며, 실제 publish 없이도 검증 흐름을 점검할 수 있다.

## 관련 파일

- [CI workflow](../../../.github/workflows/ci.yml), [Release workflow](../../../.github/workflows/release.yml), [package.json](../../../package.json).
- [Jest 설정](../../../jest.config.ts), [PG compose](../../../docker-compose.yml), [Express E2E](../../../test/e2e/idempotency.e2e-spec.ts).
- [Fastify E2E](../../../test/e2e/fastify.e2e-spec.ts), [PG E2E](../../../test/e2e/postgres.e2e-spec.ts), [실제 Redis spec](../../../test/storage/redis.storage.real.spec.ts).
- [S2 소비자 배포물 작업](S2-consumer-package.md), [S6 공통 계약 작업](S6-storage-contract.md). S2 fixture 실행 명령은 `npm run test:consumers -- --tarball <artifact>`이며 S6 변경을 같은 artifact에 반영한다.

## 검증 명령과 환경

저장소 루트에서 `npm ci`, `npm run lint`, `npx tsc --noEmit -p tsconfig.json`, `npm run build`를 실행한다.
테스트 전용 `TEST_DATABASE_URL`, `TEST_REDIS_URL`을 설정한 뒤 `npm run test:all -- --runInBand`를 실행한다.
전체 prepublish 검사는 두 URL이 설정된 환경에서 `npm run prepublishOnly`로 확인할 수 있다. 이 명령 자체는 게시하지 않는다.
`npm pack --json`으로 만든 tarball에 S2 소비자 실행기를 적용하고 실제 명령·checksum을 결과에 기록한다.
PG16/Redis7은 `docker compose up -d --wait`로 함께 준비할 수 있다. 로컬 Docker가 없으면 같은 major의 전용 테스트 서비스를 사용하고 차이를 기록한다.
DB DDL/전용 prefix 정리 권한, registry 접근, 로컬 HTTP 포트가 필요하다. 운영 서비스에 테스트를 실행하지 않는다.
실DB skip, 포트/네트워크 제약, 설치 실패는 원인과 미검증 범위를 기록한다. green exit만으로 완료하지 않는다.
실제 publish/tag/push 및 release workflow dispatch는 이 문서의 검증 명령에 포함하지 않는다.

## 호환성과 다른 작업 인계

S2의 package 경계, S6의 상태 계약, S7의 실행 예제와 마이그레이션 절차를 한 commit에서 검증한다.
지원 버전 축소나 배포 artifact 변경은 S7의 설치·업그레이드 문서와 함께 갱신한다.
검증 기록 형식은 `대상 commit / artifact·checksum / 환경(Node·npm·DB) / 명령 / pass·fail·skip / 제한`으로 통일한다.

## 다음 작업자에게

### S4 관측 검증 인수인계 (2026-10-07)

[D04](../decisions.md#d04--관측-정보-보호-decided)의 공개 event는 namespace/keyHash와
고정 error code/operation만 전달하며 event.scope 및 원본 Error payload를 제거했다.
S2 공통 fixture는 새 root 타입과 제거된 필드의 컴파일 기대 오류를 검사한다.
S4 관측 회귀는 전체 event/logger 인자에 심은 가짜 비밀 값, 각 storage 단계의 동기 throw/rejection,
이벤트 횟수, callback 실패 격리, status header enable/disable과 legacy 저장 헤더의 재생 차단을 다룬다.
검증 명령·실제 pass/fail/skip·artifact는 [S4 작업 기록](S4-observability.md)을 참조한다.
이 인계 자체는 새 실행 증거가 아니며 이전 S2 tarball 결과를 변경된 타입의 검증으로 재사용하지 않는다.

이 S4 인계 당시에는 S5/D05가 미착수/OPEN이었다. 아래 S5 인계에서 D05·D06 수명 계약과 오류·만료 전이를 검증했다. S6-5를 포함한 최종 commit에서는
관측 회귀와 같은 tarball의 소비자 타입 검사를 다시 실행한다. fake storage 장애 결과는
실제 Redis/PG 장애 주입이나 crash/불명 쓰기 복구 증거를 대신하지 않는다.
실제 DB 생략 여부, 최종 지원 matrix, RC/출시 판단은 기존 S8 gate를 따른다.

### S2 인수인계 (2026-10-06)

[소비자 실행기](../../../scripts/consumer-package.mjs)와 [fixture 안내](../../../test/consumers/README.md)를 추가했다.
`npm run test:consumers -- --tarball /absolute/path/package.tgz`로 게시 후보와 같은 artifact를 설치한다.
옵션 없이 실행하면 build/pack까지 수행한다. TEST_REDIS_URL/TEST_DATABASE_URL을 모두 제공해야 실제 DB 필수 검사에 통과한다.
`--skip-services`는 명시적인 부분 검사이며 summary.result가 pass-with-skips다. 출시 gate는 이를 성공으로 인정하지 않는다.
실행은 소스 밖에서 lockfile 생성·npm ci·npm ls·선택 peer 부재·strict 공개 타입·Node import·Nest init/close·DB CRUD를 검사한다.
NODE_PATH/전역 경로·상위 node_modules·symlink 누출을 방지한다.

fixture는 Nest11.1.18, TS5.7.3, @types/node20.19.39, ioredis5.10.1, pg/@types/pg8.20.0으로 직접 의존성을 고정했다.
PG는 @types/pg 미설치 TS7016을 기대된 실패로 검사한 뒤 명시적으로 타입을 설치한다.
TS5.4.5 후보는 현재 pg-protocol1.16.1과의 generic Buffer 선언 호환 문제로 실패하여 D02 하한을5.7.3으로 정했다.
전체 개발 테스트는 실제 Redis7.2.7/PG16.14에서 **26 suite / 351 pass / 0 skip**이다.
최종 소비자 결과와 checksum·실행 로그는 [S2 증거](S2-consumer-package.md#검증-증거--2026-10-06) 및
[보존 JSON](../evidence/S2-validation.json)을 참조한다.

S8에서 각 matrix 셀의 dependency 버전 선택을 연결하고 생성된 소비자 lockfile·npm ls·summary·로그·tarball을 CI artifact로 보존한다.
검증한 SHA-256과 게시할 입력을 일치시킨다. 현재 runner가 자동으로 지원 matrix 전체나 workflow를 변경하지는 않는다.
S1 시점41 skip은 이번 대표 실제 DB 환경에서 해소됐지만 S8의 최종 지원 조합/RC/출시 검증 완료를 뜻하지 않는다.


### S1 인수인계 (2026-10-06)

[S1 검증](S1-response-replay.md#검증-증거-2026-10-06)은 Node24.11.1/Nest11.1.18,
Express adapter11.1.18/Fastify adapter11.1.19 및 class-transformer0.5.1 환경에서
prepublishOnly와 타입 검사 통과다. 전체 **293 pass / 41 skip**(실제 PG29·Redis12).
새 실제 HTTP 회귀28개는 `test/regression/response-replay-http.spec.ts`에 있어 unit project에 포함된다.
형식/완료/boundary 회귀와 opaque body 공통 계약도 전체 pipeline에 포함된다.
Nest10·Node20/22·실제 PG/Redis opaque body 보존·tarball 소비자를 아직 검증하지 않았다.
이제 기존 조사 baseline39 skip 대신 현행41 skip을 기준으로 환경을 복구하고 출시 gate에서 skip을 막는다.
S1 완료는 S8 또는 1.0 출시 승인으로 해석하지 않는다.

- 초기 미착수 기록은 아래 2026-10-07 구현·검증 기록으로 대체한다. S1~S7의 이전 수치를 S8 통합 실행으로 재사용하지 않는다.

### S5 장애·수명 검증 인수인계 (2026-10-07)

[S5 작업 기록](S5-failure-lifecycle.md)과
[장애·복구 안내](../../failure-recovery.md)에 D05 계약과 운영 조정을 정리했다.
새 fixture는 다음과 같다.

- [failure-lifecycle.spec.ts](../../../test/regression/failure-lifecycle.spec.ts):
  storage 동기 throw/rejection, 적용 후 acknowledgment 실패, 취소 뒤 성공/실패/불명,
  create/complete/delete 진행 중 취소, 내부 timeout, 업무 영향 뒤 예외와 token 대체.
- [response-capture-failure.spec.ts](../../../test/regression/response-capture-failure.spec.ts):
  response capture 실패와 상태 헤더 setter 실패가 성공을 handler cleanup으로 보내지 않음.
- [storage-lifecycle-contract.spec.ts](../../../test/regression/storage-lifecycle-contract.spec.ts):
  timer/sweep 이전 논리 만료와 반복 완료, 상태·응답·TTL 보존.
- [failure-lifecycle.real.spec.ts](../../../test/regression/failure-lifecycle.real.spec.ts),
  [child](../../../test/support/failure-lifecycle-child.ts),
  [공유 지원](../../../test/support/failure-lifecycle-real.ts): 실제 Redis/PG 공유 상태에서
  IPC barrier로 순서를 정한 자식 SIGKILL·재시작과 별도 PG 업무 원장 대조.

`npm run test:failure:real`은 `TEST_REDIS_URL`과 `TEST_DATABASE_URL`을 모두 필수로
요구한다(`S5_REQUIRE_REAL_STORAGE=1`). 일반 Jest는 환경 미제공 시 skip하므로
출시 gate에서 이 전용 명령과 전체 skip 집계를 함께 사용한다.
`S5_EVIDENCE_PATH`를 쓰기 가능한 JSON 경로로 지정하면 scenario 증거를 보존한다.
실제 실행 환경과 pass/fail/skip은 S5 검증 기록을 따르며 이 인계 자체는 새 실행 결과가 아니다.

실험은 Redis/PG 각각 업무 commit 전·후와 complete 뒤 crash, complete 쓰기 전 실패와
적용 뒤 acknowledgment 실패를 다룬다. 두 adapter 모두 별도 PG transaction을 원장으로 쓰며
handler 횟수·원장 결과·token/상태·클라이언트 결과를 기록한다. 만료 전 retry를 확인한 후
테스트 namespace의 Redis PEXPIRE/PG expires_at만 단축해 만료 뒤 retry를 관찰한다.
이 강제 만료는 검증 장치이며 운영자 unlock 절차가 아니다.

검증 한계: SIGKILL은 실제 프로세스 종료이나 client 결과는 interceptor 경계이며 TCP HTTP
연결을 끊지 않는다. complete 실패는 adapter 호출 전 또는 성공 응답 뒤 애플리케이션 경계
주입이며 실제 네트워크 단절/DB failover를 재현하지 않는다. provider 조정·복제 durability,
최종 Node/Nest matrix와 같은 tarball의 소비자 검증은 S8 최종 대상에서 따로 확인한다.
S6의 긴 TTL/범위·전체 계약 완료나 S7 전체 recipe 완료를 S5 통과로 대신하지 않는다.

### S6 공통 계약·긴 TTL 인수인계 (2026-10-07)

S6 전체는 [최종 검증 기록](S6-storage-contract.md#2026-10-07-s6-최종-검증-증거)과 [보존 JSON](../evidence/S6-validation.json)으로 완료했다.
Node24.11.1/Nest11, Redis7.2.7/PG16.14에서 전체38 suites/908 pass/0 skip, lint·타입·build를 확인했다.
같은 S6 tarball의 소비자는41 pass/기대된 실패3/0 skip이며 artifact SHA-256과 경로는 보존 JSON을 따른다.
공통 contract가 1초·30일·최대2,147,483,647초, 16종 invalid 값과 상태별 선행 검증을 검사한다.
필수 대상에 `memory-long-ttl.spec.ts`, `storage-ttl-validation.spec.ts`, `ttl-validation.spec.ts`,
`storage-lifecycle-contract.spec.ts`, `postgres-adapter.spec.ts`와 storage 전체를 포함한다.
native Node overflow 회귀와 실제 Redis PTTL 검사는 mock/fake timer로 대체하지 않는다.
두 서비스 URL을 제공하고 전체 JSON의 pending/skip=0을 확인한다. 일반 spec의 환경 누락 skip 경로는 아직 유지되므로 S8 gate에서 반드시 차단한다.
긴 TTL의 실제 수십 년 경과·분산 시계 동기화를 검증한 것으로 표현하지 않는다. S7 전환 예제, 최종 지원 matrix와 동일 artifact 출시 연결은 S8 잔여 범위다.


### S7 도입·전환 인수인계 (2026-10-07)

S7 완료, [D07](../decisions.md#d07--10-전환과-롤백-decided) DECIDED. [실행 예제 목록](../../../test/consumers/README.md),
[업무 recipe](../../adoption-recipes.md), [upgrade/rollback 안내](../../migration-1.0.md)를 출시 대상에 유지한다.
`npm run test:adoption`은 TEST_DATABASE_URL/TEST_REDIS_URL 모두 필수이며 sweep/migration·HTTP recipe·실제 tarball 소비자를 실행한다.
최종 Node24/Nest11 대표 환경에서 전체 **41 suites / 937 pass / 0 skip**, 소비자 **45 pass / 기대된 실패3 / 0 skip**.
[상세 S7 기록](S7-adoption-docs.md#2026-10-07-s7-최종-구현과-검증)과 [보존 JSON](../evidence/S7-validation.json)을 따른다.

sweep은 IDEMPOTENCY_STORAGE를 주입하며 같은 PG adapter/Pool을 사용한다. 수동 class-token DI는 alias 전환이 필요하다.
README quickstart는 tarball 안의 코드와 fixture 동일성 검사 후 실행하므로 둘을 함께 갱신한다.
소비자에 Nest testing11.1.18 및 Memory class-transformer0.5.1이 추가됐다. 실제 연결의 injected/owned shutdown을 모두 검사한다.
S8 matrix를 바꿀 때 consumer Nest testing과 HTTP adapter 버전도 함께 고려한다.

현재 CI/release가 전체 실DB·소비자 gate 및 동일 tarball 게시를 강제하지 않는 점은 CONTRIBUTING에 명시했다.
S8에서 필수 gate와 실제 배포 artifact를 연결한다. 모델0.4 reader와 로컬 provider simulator를 실제 구 binary/외부 결제사/production rollout 검증으로
표현하지 않는다. 두 방향 모두 빈 namespace와 durable 업무 history, writer fencing·불명 결과 조정이 필요하며 SQL schema migration은 추가되지 않았다.


## 2026-10-07 S8 최종 구현과 검증

S8 구현 및 로컬 통합 검증을 완료했다. [D08](../decisions.md#d08--출시-matrix와-동일-artifact-decided)은 DECIDED다.
작업 완료는 npm/RC/1.0 게시 또는 운영 출시 승인을 뜻하지 않는다. package version은 0.4.0이다.

### 지원 정책과 검증 경로

- engines: `^22.0.0 || ^24.0.0`. Node20 지원을 종료하고 README·CONTRIBUTING·전환 문서와 맞췄다.
- Node22/24 × Nest10/11 × optional peer 하한/대표의 **8개 cell**을 필수로 한다. 각 cell 안에서 Express/Fastify를 모두 검사한다.
- Nest common/core/testing/Express/Fastify는 10.4.22 또는 11.1.18로 일치시킨다. 하한은 ioredis5.0.0·pg/@types/pg8.11.0, 대표는 ioredis5.10.1·pg/@types/pg8.20.0이다.
- [공통 workflow](../../../.github/workflows/release-validation.yml)를 일반 CI와 release가 함께 호출한다. PG16/Redis7 health check와 URL을 동일하게 제공하며 compose에도 Redis를 추가했다.
- [gate 실행기](../../../scripts/release-validation.mjs)가 build → validate → verify-matrix를 연결한다. [검사 정책](../../../scripts/release-gates.mjs)은 두 서비스 preflight, 41개 필수 spec과 각 최소 assertion 수, 전체 skip/todo/실패=0, 실제 S5 10개 crash 시나리오, S7 recipe, tarball 소비자 결과를 검사한다.
- 하나의 tarball에 commit·source snapshot·SHA-256을 기록하고 모든 cell이 그 파일을 설치한다. 시작/종료 시 소스와 tarball 불변성을 확인한다. 소비자 lockfile·설치 목록·컴파일/HTTP/DB 로그·summary 및 Jest/crash JSON을 artifact로 보존한다.
- 최종 집계가 8개 cell과 각 하위 증거의 checksum을 재검증한 뒤에만 artifact를 승격한다. publish 잡은 install/build/pack 없이 전달받은 tarball과 commit/version/checksum/전체 matrix를 다시 검증하고 명시적인 tgz를 `npm publish --ignore-scripts --provenance --access public`에 넘긴다.
- `workflow_dispatch`는 항상 검증 전용이다. 실제 publish는 일치하는 tag push에만 연결한다. 이번 작업은 원격 dispatch/tag/push/publish를 실행하지 않았다.

### 하한 검사에서 수정한 결함

ioredis5.0.0은 named `Redis` export를 제공하지 않아 기존 공개 선언 파일이 하한 소비자에서 실패했다.
`src/storage/redis.storage.ts`와 관련 테스트 import를 default Redis import로 바꿨다. 런타임 저장소 계약은 바꾸지 않았다.
PG fixture도 최신 타입에만 있는 비공개 `ended`/`ending` 속성 대신 종료 후 public query 거절을 검사한다.
최초 실패는 `/private/tmp/s8-consumer-nest10-minimum-initial/summary.json`, 수정 뒤 사전 검사는
`/private/tmp/s8-consumer-nest10-minimum-real/summary.json`과 Nest11 대응 경로에 보존했다.
아래 최종 8개 cell은 별도의 최종 tarball로 다시 검사했다.

### 대상과 실행 증거

- 사용자 checkout 기준: `34e54f2891c00d823331347f23ef1dcbf4257d7c` + S8 변경.
- 모든 구현·workflow·fixture를 별도 로컬 clone의 clean 검증 commit **`6f9a35925d3a10eda076450f030c46494357a66a`**로 고정했다. 사용자 저장소에 commit/tag/push를 만들지 않았다.
- source snapshot SHA-256: `ba2c2f223c7bb701cddba22e15fd79bcead598ed6ed1ab0fec132be4de1a34c8`.
- artifact: `/private/tmp/idempotency-s8-run/candidate/nestarc-idempotency-0.4.0.tgz`, **104 files**.
- tarball SHA-256: **`0090b2a1b8c74306accfecbfc23c77f1b3ccdece1a298d8412326b219fc9be17`**.
- 환경: macOS arm64, Node22.23.3/npm10.9.9 및 Node24.11.1/npm11.6.2, PostgreSQL16.14/Redis7.2.7. PG 바이너리는 x86_64 실행 환경이다. Docker daemon은 사용하지 않았다.
- 네 개의 독립 Node/Nest clone에 fresh `npm ci` 후 대표→하한 profile을 설치해 검사했다. 동시 실행 간 간섭을 막기 위해 전용 PG database4개와 Redis database index4개를 분리했다. 소비자 프로젝트는 각 cell마다 새 격리 디렉터리에서 lockfile 생성 후 `npm ci`로 설치했다.

| Node / npm | Nest | peer profile | 전체 Jest | 소비자 pass / 기대 실패 / skip |
| --- | --- | --- | --- | --- |
| 22.23.3 / 10.9.9 | 10.4.22 | representative | 41 suites / 937 pass / 0 skip | 45 / 3 / 0 |
| 22.23.3 / 10.9.9 | 10.4.22 | minimum | 41 suites / 937 pass / 0 skip | 45 / 3 / 0 |
| 22.23.3 / 10.9.9 | 11.1.18 | representative | 41 suites / 937 pass / 0 skip | 45 / 3 / 0 |
| 22.23.3 / 10.9.9 | 11.1.18 | minimum | 41 suites / 937 pass / 0 skip | 45 / 3 / 0 |
| 24.11.1 / 11.6.2 | 10.4.22 | representative | 41 suites / 937 pass / 0 skip | 45 / 3 / 0 |
| 24.11.1 / 11.6.2 | 10.4.22 | minimum | 41 suites / 937 pass / 0 skip | 45 / 3 / 0 |
| 24.11.1 / 11.6.2 | 11.1.18 | representative | 41 suites / 937 pass / 0 skip | 45 / 3 / 0 |
| 24.11.1 / 11.6.2 | 11.1.18 | minimum | 41 suites / 937 pass / 0 skip | 45 / 3 / 0 |

각 cell의 lint와 전체 타입 검사도 통과했다. 소비자의 기대 실패3개는 @types/pg 미설치 상태의
node/node16/nodenext TS7016이며, 실제 타입 설치 후 같은 세 모드가 통과했다. skip으로 처리하지 않았다.
Node24/Nest11/대표 cell에서 기존 coverage80% gate도 유지했다:
statements98.01%, branches93.13%, functions98.33%, lines97.98%.
실행 명령·개별 결과·checksum·로그 경로는 [보존 JSON](../evidence/S8-validation.json)을 따른다.

정상 경로 명령은 clean 검증 clone에서 다음과 같다. cell마다 선택한 Node를 PATH에 지정하고 테스트 전용 URL을 제공했다.

```sh
npm ci
node scripts/release-validation.mjs build --output ../candidate
node scripts/release-matrix.mjs install --nest 11 --peer-profile representative
node scripts/release-validation.mjs validate --artifact ../candidate/artifact.json \
  --output ../evidence/node24-nest11-representative --nest 11 --peer-profile representative
node scripts/release-validation.mjs verify-matrix --artifact ../candidate/artifact.json --evidence ../evidence
```

`test:all`에는 S1~S7 전체 회귀, S5 실제 crash, S6 공통 계약·native timer·실제 Redis PTTL,
S7 sweep/migration/HTTP recipe가 포함된다. wrapper가 S5/S7 실제 서비스 필수 환경과 crash 증거 경로를 설정한다.
consumer는 같은 tarball의 공개 import·strict TS·README quickstart·Nest lifecycle·실DB CRUD·소유권과
Express/Fastify 실제 TCP 최초 요청/replay/422/close를 검사한다.

### 실패 게이트와 artifact 전달

`npm run test:release-gates`는 **45 pass / 0 fail / 0 skip**이다. URL 누락과 실제 접속 실패,
누락/감소한 spec, skip/todo·집계 불일치, 실패/누락/변조된 consumer summary, 잘못된 실제 의존성 버전,
artifact/SQL 누락·tarball 변조·commit/version 불일치, dirty source·source 변경과 matrix 누락을 거절한다.
실패한 셀의 실행기 exit와 결과 JSON을 함께 보존하며, 실패 보고서를 정상 결과로 승격하지 않는다.

최종 tarball과 8개 cell 증거를 `promoted/`로 복사하여 artifact 전달을 재현했다. 별도
`publish-checkout/`에는 node_modules를 설치하지 않은 상태에서 verify-artifact와 verify-matrix를 실행해 통과했다.
그 위치에서 `npm publish ../promoted/nestarc-idempotency-0.4.0.tgz --dry-run --ignore-scripts --access public --json`도 exit0이었고 이후 checksum 재검증이 통과했다. 실제 게시·OIDC/provenance는 실행하지 않았다.
별도 clone에서 Memory runtime에 의도적 throw를 넣자 실제 소비자 runner와 실패 summary 검증이 각각 exit1이었다.
manifest 누락·tarball 누락·변조·commit 불일치도 실제 verify-artifact CLI가 모두 exit1로 거절했다.
명령·로그·실패 summary는 보존 JSON의 negativeIntegration을 따른다.

### 완료 범위와 남은 출시 판단

- [RC 기록](../release-candidate.md)에 JSON 단일 사용자 API, multi-tenant API, PG webhook 시나리오·통과/보류 기준과 도입팀 관찰 양식을 준비했다. 참여 팀이 제공되지 않아 **외부 RC/운영 도입 검증은 미실시**다.
- 최종 구현에 대한 알려진 미해결 검증 실패는 없다. 결과 기록을 추가한 S8 문서/작업판/증거 JSON은 검증 snapshot 이후 갱신했으며 제품 소스·배포 README·workflow·fixture의 bytes는 그대로다.
- GitHub Actions 서버의 실제 실행, Ubuntu Docker 서비스, registry OIDC/provenance 게시와 외부 provider/production 장애·전환·rollback은 이번 로컬 실행의 증거가 아니다. workflow YAML/쉘/구조를 검사했고 동일 CLI와 복사된 artifact 전달 경로를 로컬에서 실행했다.
- 검증한 Nest patch와 optional peer 두 profile 밖의 모든 minor/patch, 모든 전이 의존성 하한, 지원하지 않는 Node/OS를 검증했다고 주장하지 않는다. PG16.14/Redis7.2.7은 CI 이미지 태그가 향후 가져올 patch 전체를 대표하지 않는다.
- 다음 출시 담당자는 별도의 version/changelog/출시 판단 뒤 **실제 tag 대상 clean commit**에서 공통 gate를 다시 실행한다. 로컬 snapshot commit은 원격 release tag가 아니다. 보존된 CI artifact의 보관 기한은14일이며 승인된 증거는 만료 전에 별도 보존한다.


### 2026-10-07 버전 bump 후속 기록

사용자의 버전 bump 요청에 따라 package.json과 package-lock.json의 패키지 버전을
**0.4.0 → 1.0.0**으로 올리고 CHANGELOG의 1.0 변경을 `1.0.0 / 2026-10-07`로 정리했다.
위 S8 검증 commit·tarball·SHA-256과 JSON은 **bump 이전 0.4.0의 역사적 증거**로 그대로 보존한다.
새 버전은 다른 artifact이므로 기존 checksum/8개 cell 결과를 1.0.0 게시 증거로 재사용하지 않는다.
최종 clean commit에서 공통 release gate를 다시 실행한다. 이번 bump에서 tag/push/publish는 수행하지 않았다.

### 2026-10-07 GitHub Actions CI 검증

커밋 `2d0af38bebbb31ba8f0651ce2208625c60e0b346`의
[CI 실행 37633224775](https://github.com/nestarc/idempotency/actions/runs/37633224775)이
`completed / success`로 종료됐다. 빌드 1개, Node22/24 × Nest10/11 ×
minimum/representative 8개 셀, 최종 동일 artifact 검증 1개 등 **10개 작업이 모두 성공**했다.
GitHub의 Ubuntu runner와 PostgreSQL16/Redis7 서비스에서 전체 소스·설치 소비자 검증을
수행하고 `s8-validated-candidate`를 보존했다. 이 기록은 앞선 로컬 검증과 별개의 원격 실행 증거다.

실제 `v1.0.0` 출시는 README 설치 안내와 CHANGELOG를 확정한 태그 커밋에서
Release workflow 전체 검증을 다시 통과해야 한다. CI 성공만으로 npm 게시나
provenance, GitHub Release 생성을 완료한 것으로 보지 않는다.
