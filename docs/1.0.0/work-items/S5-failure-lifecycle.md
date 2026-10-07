# S5 장애 상태 전이와 수명주기

상태·담당의 단일 원본은 [1.0.0 작업판](../README.md)이다.
조사 기준은 2026-10-06 `9610774`, 구현 기준은 2026-10-07
`e13b3709651b367441d420239e8b91e69d465ea1` + S5 작업 트리다.
관련 결정은 [D05](../decisions.md#d05--장애와-구독-수명-decided),
선행 수명 계약은 [D06](../decisions.md#d06--저장소-공통-계약-decided)이다.

## 목적과 범위

업무 성공과 idempotency 저장 결과를 구분한다. 성공 후 capture/complete 실패가
handler-error cleanup으로 레코드를 삭제하지 않게 하고, 취소·불명 쓰기·crash·늦은 완료의
상태·응답·재시도 조건을 테스트와 운영 절차로 고정한다.

S1 최종 정상 emission/opaque body 경계와 S4 안전 관측 계약을 유지한다.
S5의 선행 조건인 S6 만료·token·반복 완료 계약을 이번 변경에 함께 통합했다.
S6 전체 중 긴 TTL overflow/직접 adapter 입력 정책(S6-5)은 남아 있으며 별도로 추적한다.
새 transaction API, detached runner, 자동 heartbeat/강제 unlock/범용 retry/오류 캐싱,
업무 exactly-once 보장은 범위 밖이다.

## 조사 기준과 수정 전 재현

초기 `9610774`에서는 sync complete throw가 handler 오류로 오분류돼 성공값 대신 오류와
레코드 삭제를 만들었다. async rejection은 성공값+PROCESSING 보존이어서 서로 달랐다.
S4가 storage sync/rejection 경계를 이미 보완했으므로 이 최초 사례는 역사적 baseline이다.

S5 착수 코드에는 response의 `headersSent/sent/raw/statusCode/getHeaders` 조회·호출과
관측 헤더 쓰기 예외가 성공 뒤 cleanup으로 내려가는 문제가 남았다.
신규 [capture 회귀](../../../test/regression/response-capture-failure.spec.ts)는 수정 전
**12 fail / 0 pass**, 수정 뒤 모두 통과했다. handler-error catch를 capture보다 앞에
배치하고 capture 예외는 bypass, 관측 헤더 쓰기는 best-effort로 처리했다.

외부 timeout 10ms/업무30ms였던 초기 취소 실험은 제어 가능한 Promise와 RxJS
VirtualTimeScheduler로 옮겼다. 짧은 실제 시간 경합으로 구독 종료 순서를 추측하지 않는다.

## 확정 상태 전이

같은 scope/key/fingerprint 재시도를 전제로 한다. fingerprint 불일치는422가 우선한다.
원 오류의 HTTP 변환은 애플리케이션 exception filter/adapter가 결정한다.

| 경로 | 업무 결과 | 저장 상태/동작 | 클라이언트/관측 | 재시도 조건 |
| --- | --- | --- | --- | --- |
| get 실패 | 이번 handler 미실행 | 이번 쓰기 없음, 이전 시도 상태 불명 | 원 storage 오류, storage_error/get 1회 | 연결 복구 후 이전 시도 조사 |
| create 실패 | 이번 handler 미실행 | 미반영 또는 응답 유실로 PROCESSING 존재 | 원 storage 오류, storage_error/create 1회 | get·원장 조회, lock 강제 삭제 없음 |
| 경합 race_get 실패 | 패자 미실행, 승자 결과 불명 | 패자 쓰기 없음 | 원 오류, storage_error/race_get 1회 | 승자 상태 조사 |
| handler error/안쪽 timeout | 부작용 전/후 구분 불가 | token 조건부 best-effort delete | 원 handler 오류, 성공 cleanup 이벤트 없음 | 삭제 후 재실행 가능하므로 rollback 확인 또는 durable 업무 dedup 필수 |
| cleanup delete 실패 | 원 handler 실패, 부작용은 불명 | 잔존 또는 삭제 반영 후 응답 유실 | 원 handler 오류 유지, storage_error/delete 1회 | 레코드와 원장 조회, 자동 재삭제 없음 |
| capture 실패/미지원 | handler 정상 완료 | complete/delete 없음, PROCESSING 유지 | 원 성공값, bypassed/response_not_replayable 1회 | lease 동안409, 만료 후에도 원장 조정 필요 |
| complete 실패 | handler 정상 완료 | PROCESSING 또는 쓰기 반영된 COMPLETED, delete 금지 | 원 성공값, complete_error 1회 | 전자는409, 후자는 지원 body replay; 이벤트만으로 저장 상태 판단 금지 |
| complete stale | handler 정상 완료 | 부재/만료/기완료/대체 token 변경 없음 | 원 성공값, stale 1회 | 현재 소유자 보호, 업무 결과 조사 |
| handler 완료 전 외부 취소 | 이후 성공/실패/계속 불명 | 구독 teardown, 이후 complete/delete 안 함 | 취소 구독에 결과/추가 이벤트 없음 | 업무 중단 증거 아님, lease와 무관하게 원장 확인 |
| create 중 외부 취소 | handler 시작 안 함 | 이미 시작한 Promise가 PROCESSING 생성 가능 | 취소 이후 결과 없음 | lease 보존, 조정 전제 동일 |
| complete 중 외부 취소 | 이미 성공 | 이미 시작한 Promise가 COMPLETED 반영 가능 | created/complete_error 누락 가능 | 실제 레코드 및 원장 확인 |
| delete 중 외부 취소 | handler 오류 발생 | 이미 시작한 cleanup Promise가 삭제 가능 | 원 오류/cleanup 오류 이벤트 누락 가능 | 취소가 삭제를 되돌리지 않음 |
| 프로세스 crash | commit 위치에 따라 다름 | shared record 잔존 가능, Memory 소실 | 응답/이벤트 없음 가능 | 업무 원장/provider 대조, 만료만 보고 재실행 금지 |

storage 동기 throw/Promise rejection은 같은 분류·보존 정책이다. 이벤트 횟수는 활성 구독과
onEvent 설정 기준이다. 취소 뒤 Promise side effect가 발생해도 이벤트는 보장하지 않는다.
S4의 namespace/keyHash·패키지 상수 error payload를 유지하고 원본 오류를 로그/이벤트에 넣지 않는다.
상태 헤더가 닫힌 response/getter/setter 때문에 실패해도 성공값·저장 상태·이벤트 분류를 바꾸지 않는다.

## 취소·timeout·lease 정책

- 바깥 timeout/unsubscribe는 구독을 종료하며 독립 background subscription을 만들지 않는다.
  무한 Observable/응답 객체/자원을 별도로 유지하지 않는다. 이후 Promise의 업무 결과를 자동 회수하지 않는다.
- 안쪽 timeout은 handler 오류이므로 기존 token cleanup을 따른다. 취소/rollback을 확인하지 않은
  비동기 업무는 이후에도 commit할 수 있다. 서비스의 durable command ID/inbox/provider dedup이 필요하다.
- 실제 HTTP disconnect가 Nest의 unsubscribe와 동일하다고 가정하지 않는다. 지속 처리가 필요한 업무는
  애플리케이션 durable queue/job·결과 조회로 설계한다. 범용 실행 지속 옵션을 추가하지 않는다.
- D06은 활성 PROCESSING+동일 token만 완료하도록 한다. 만료 후 새 token이 없어도 stale,
  같은 token 반복 complete도 stale이며 최초 응답/TTL/createdAt을 보존한다.
- Memory/PG는 expiresAt<=now가 부재이며 Redis는 서버 TTL이 권위다. token CAS는 새 레코드를 보호하고
  오래된 업무의 side effect를 중단하지 않는다. lease를 짧게 잡는 것만으로 안전해지지 않는다.

## 작은 작업과 완료 조건

- [x] **S5-1 재현 고정:** sync/async complete 비교, capture 예외 red/green, 제어 가능한 외부 취소 회귀.
- [x] **S5-2 전이 표:** 업무 결과·storage 상태·클라이언트 결과·재시도 조건을 D05 및 위 표에 확정.
- [x] **S5-3 오류 경계:** S1 정상 완료 경계와 D06 수명 계약 위에서 source 오류와 후처리를 분리.
- [x] **S5-4 취소 수명:** 외부 취소 후 성공/실패/불명, create/complete/delete 중 취소, 안쪽 timeout 검증.
- [x] **S5-5 장애 실험:** 실제 Redis/PG 공유 storage, 자식 SIGKILL/재시작, 업무 원장·lease 전후 재시도 관찰.
- [x] **S5-6 불명 상태:** [업무 원장 조회·조정 예제](../../failure-recovery.md)와 위험한 재실행 조건을 S7에 인계.
- [x] **S5-7 통합 인계:** S4 관측 재검증, S6 contract, S8 필수 실DB 검증 명령과 증거 연결.

완료 조건별로 같은 storage 실패의 sync/async 분류, 성공 후 cleanup 금지, cleanup 원 오류 보존,
새 token 보호, 취소 상태 및 retry, crash 원장·실행 수·token·응답, 만료 전후·대체 유무가 검증됐다.
운영 문서는 조사 증거와 사람이 결정해야 할 조건을 구분하고 자동 조정을 주장하지 않는다.

## fixture와 실행 방법

| 파일 | 검증 내용 |
| --- | --- |
| [response-capture-failure.spec.ts](../../../test/regression/response-capture-failure.spec.ts) | response 조회 7종, 상태별 header throw 4종, setter getter throw; 12개 |
| [failure-lifecycle.spec.ts](../../../test/regression/failure-lifecycle.spec.ts) | MemoryStorage 실제 상태, sync/async complete·cleanup, 불명 complete, 취소 각 단계·timeout·대체 token; 17개 |
| [failure-lifecycle.real.spec.ts](../../../test/regression/failure-lifecycle.real.spec.ts) | 실제 Redis/PG × crash3/complete실패2 = 10개 |
| [failure-lifecycle-child.ts](../../../test/support/failure-lifecycle-child.ts) / [공유 fixture](../../../test/support/failure-lifecycle-real.ts) | IPC barrier, 실제 SIGKILL, 새 프로세스 재시도, PG 업무 원장 |
| [storage-lifecycle-contract.spec.ts](../../../test/regression/storage-lifecycle-contract.spec.ts) / [공통 contract](../../../test/support/shared-storage-contract.ts) | 정확한 만료 경계, 동시 create/complete, 반복 완료 및 stale token |
| [observability-safety.spec.ts](../../../test/regression/observability-safety.spec.ts) / [헤더·sweep](../../../test/regression/observability-headers-sweep.spec.ts) | S4 전체 payload, 이벤트 횟수, callback 격리 재검증 |

```sh
npm test -- --runInBand test/regression/response-capture-failure.spec.ts test/regression/failure-lifecycle.spec.ts test/regression/complete-failure-cascade.spec.ts test/regression/observability-safety.spec.ts
# 테스트 전용 TEST_REDIS_URL, TEST_DATABASE_URL 둘 다 설정한 환경에서:
npm run test:failure:real
npm run prepublishOnly
npx tsc --noEmit --incremental false -p tsconfig.json
npm run test:consumers
```

실제 fixture는 Node 자식 프로세스/IPC/SIGKILL, Redis prefix 조회·삭제, PG 전용 table 생성·삭제 권한이
필요하다. 두 storage 모두 별도 PG transaction을 업무 원장으로 사용하므로 두 URL이 모두 필요하다.
`npm run test:failure:real`은 환경 누락 시 exit1로 실패한다. 일반 suite는 미설정이면 명시적 skip이므로
그 결과로 실제 검증을 대체하지 않는다. `S5_EVIDENCE_PATH=/absolute/path/result.json`으로 실험 JSON을 보존한다.
추가 의존성 없이 저장소의 ts-node/Jest/RxJS/pg/ioredis 개발 설치본을 사용한다.

## 실제 crash·불명 쓰기 결과

실제 Redis7.2.7/PG16.14 모두 아래 결과가 같았다. 최초 응답은 SIGKILL이면 없음,
complete rejection이면 성공값+complete_error다. 매 재시도는 새 프로세스에서 실행했다.

| 중단/실패 지점 | 직후 handler 수/commit 수 | 직후 record | 만료 전 재시도 | 만료 후 handler 수/commit 수 |
| --- | --- | --- | --- | --- |
| 업무 commit 전 SIGKILL | 1 / 0 | PROCESSING | 409, 수 불변 | 2 / 1 |
| 업무 commit 후 complete 전 SIGKILL | 1 / 1 | PROCESSING | 409, 수 불변 | 2 / 2 |
| complete 후 응답 전 SIGKILL | 1 / 1 | COMPLETED | 201 replay, 수 불변 | 2 / 2 |
| complete 호출 전 rejection | 1 / 1 | PROCESSING | 409, 수 불변 | 2 / 2 |
| complete 반영 뒤 응답 rejection | 1 / 1 | COMPLETED | 201 replay, 수 불변 | 2 / 2 |

만료 후 old token complete는 대체 레코드가 없어도 stale, 재획득 뒤 old complete/delete도 stale이며
새 token/응답/상태는 유지됐다. 원장에는 중복 차단 unique command 제약을 의도적으로 두지 않아
마지막 열의 중복 부작용을 드러냈다. 이를 업무 exactly-once 성공으로 읽으면 안 된다.

실험 경계:

- 실제 child SIGKILL과 Redis/PG 연결을 사용하지만 클라이언트 결과는 interceptor status/body 경계다.
  TCP HTTP 응답 유실 또는 client disconnect 자동 unsubscribe를 증명하는 실험은 아니다.
- complete 실패는 실제 adapter 호출 전/성공 후 애플리케이션 경계에서 rejection을 주입한다.
  실제 네트워크 단절, 저장소 서버 crash/failover, Redis persistence/replication 내구성은 검증하지 않았다.
- IPC가 crash 순서를 제어한다. PROCESSING120초/COMPLETED300초의 lease/retention에 대해 만료 전 검증 후
  테스트 전용 Redis PEXPIRE/PG expires_at을100ms 뒤로 단축하고 실제 adapter의 null을 상한5초 polling으로 확인한다.
  장시간 실제 대기나 자연스러운120/300초 전체 구간을 시험했다고 주장하지 않는다.
- Node24/Nest11 대표 환경이며 지원 버전 전체 matrix·출시 artifact 고정은 S8 작업이다.

## 검증 증거 — 2026-10-07

[검증 JSON](../evidence/S5-validation.json), [crash 원시 기록](../evidence/S5-crash-experiments.json)을 보존한다.
대상은 위 기준 commit + S5 작업 트리이며 commit/publish/version bump는 수행하지 않았다.

| 검증 | 결과 | 증거 |
| --- | --- | --- |
| capture 수정 전 | 12 fail / 0 pass | `/private/tmp/s5-capture-red.log` |
| capture·취소·기존 관측 선별 회귀 | 4 suites / 100 pass / 0 skip | `/private/tmp/s5-capture-green.log` |
| S6 core 실제 저장소 계약 | 8 suites / 143 pass / 0 skip | [S6 검증 기록](S6-storage-contract.md), 실행 tool output 및 최종 전체 suite |
| 필수 실제 장애 fixture | 10 pass / 0 skip; URL 누락 exit1 | `/private/tmp/s5-crash-evidence.json`; 최종 전체 실행에서도10개 통과 |
| prepublishOnly | lint·전체36 suites / 768 pass / 0 skip·build 성공 | `/private/tmp/s5-prepublish.log` |
| 개발 타입 검사 | 성공 | `/private/tmp/s5-typecheck.log` |
| 실제 tarball 소비자 | 41 pass / 기대된 타입 실패3 / 0 skip | `/private/tmp/s5-consumers.log` |

환경은 darwin/arm64, Node24.11.1/npm11.6.2, Nest common/core11.1.18,
Express11.1.18/Fastify11.1.19, TypeScript5.9.3이다. 실제 서비스는 이번 작업 전용 loopback
Redis7.2.7/PG16.14 인스턴스이며 연결 비밀값은 증거에 남기지 않는다.

## 다음 작업자에게

- S5-1~7 및 D05 완료. S1의 final emission/opaque body와 S3 키/namespace, S4 payload 계약 유지.
- S4: handler/capture/storage 경계 최종 통합 및 회귀 재실행으로 S4-4와 남은 완료 조건을 닫는다.
  취소된 구독의 저장 Promise는 적용돼도 이벤트가 없을 수 있다. 관측 헤더 실패는 이벤트 분류를 바꾸지 않는다.
- S6: D06 수명 계약과143개 검증을 인수한다. 긴 TTL overflow/직접 adapter 입력(S6-5)은 다음 작업이다.
  이 미완료를 S5의 실제 crash·상태 전이 증거와 혼동하지 않는다.
- S7: [운영 가이드](../../failure-recovery.md), README/CHANGELOG, D05/D06 custom adapter 차이를 반영해
  실제 도입 예제·전환 절차를 마무리한다. D07 전체는 계속 OPEN이다.
- S8: 두 DB 필수 장애 명령, 위 실험 경계와 원시 JSON, 동일 tarball 소비자 검사를 최종 matrix에 연결한다.
  실제 서버 네트워크 장애/HTTP disconnect/지원 버전 전체를 완료했다고 표기하지 않는다.
- 다음 구체 행동: S6-5의 긴 TTL·입력 범위를 확정하고 Memory timer overflow를 회귀로 수정한다.
