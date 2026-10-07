# S6 — 저장소 공통 계약

- 상태: [작업판](../README.md) 참조. 이 파일은 어댑터 동작과 검증 범위를 관리한다.
- 조사일: 2026-10-06 · baseline: `9610774` (`@nestarc/idempotency` 0.4.0).
- 근거: [안정화 조사](../../1.0.0-stabilization-research.md)의 장애·저장소 계약 항목.
- 착수 조건: 독립적으로 계약을 확정한 뒤 S5의 장애 상태 전이와 통합 검증한다.

## 목적

Memory에서 확인한 API 동작이 실제 Redis·Postgres로 바뀌어도 같은 의미를 갖도록 한다.
특히 TTL 만료, 반복 완료, 오래된 token의 권한과 반환값을 명확하게 정의한다.
저장소 CAS가 업무 실행 취소나 업무 DB와의 원자적 commit을 보장한다는 의미로 확대하지 않는다.

## 확인된 근거와 재현 절차

Memory의 get은 만료를 검사하지만 create/complete는 timer가 제거하지 않은 레코드를 유효하게 취급한다.
timer 실행 전 시계만 lease 이후로 이동하면 create는 거절되고 기존 token complete는 성공했다.
Memory의 `setTimeout(ttlSeconds * 1000)`은 30일 입력에서 범위를 넘는다.
실제 Node probe에서는 `TimeoutOverflowWarning` 이후 20ms 관찰 시점에 레코드가 사라졌다.
PG complete는 `status = 'PROCESSING'`을 요구하지만 `expires_at`을 검사하지 않는다.
Memory/Redis mock에서 같은 token으로 반복 complete하면 두 번째 body로 덮어썼다.
PG의 반복·만료 동작은 SQL 확인에 근거하며 실제 DB 재현은 아직 수행하지 않았다.

1. `npm ci`로 기존 Jest/ts-jest와 pg/ioredis 개발 의존성을 준비한다. 외부 임시 probe는 필요하지 않다.
2. Memory spec에서 Jest fake timer로 create 후 `jest.setSystemTime()`만 lease 이후로 이동한다.
3. get이나 timer 실행으로 먼저 정리하지 말고 create/complete를 각각 독립 테스트에서 호출한다.
4. 30일 TTL은 실제 Node 동작 회귀 검사와 fake timer 기반 시간 경계 검사를 구분한다.
5. 실제 PG 테스트에서는 전용 테스트 테이블의 PROCESSING 행을 SQL로 만료시킨 뒤 대체 create 없이 complete한다.
6. 실제 Redis 테스트에서는 전용 prefix를 쓰고 서버 TTL 만료를 관찰한 뒤 같은 token으로 complete한다.
7. 각 어댑터에서 동일 token으로 서로 다른 응답을 두 번 complete하여 반환값과 최종 저장 값을 비교한다.

테스트 fixture는 저장소의 storage spec/공통 harness로 남긴다. 조사 당시 임시 경로나 다른 저장소는 사용하지 않는다.
실서비스 clock 검사는 polling 상한과 오차 허용치를 선언하고, 고정된 짧은 sleep만으로 성공을 판정하지 않는다.

## 포함·제외 범위

- 포함: NX 원자성, 만료 전후 get/create/complete/delete, token 소유권, 반복 complete, TTL 갱신, createdAt 보존.
- 포함: 긴 TTL 지원 또는 일관된 명시적 상한, 공통 contract suite, 실제 Redis/PG 검증.
- 포함: 대체 요청이 없는 만료와 새 token으로 교체된 만료를 서로 다른 상태로 검증.
- 제외: 자동 lease 연장, ORM transaction 통합, 새 어댑터, Redis Cluster 신규 API, 대규모 성능 최적화.
- 제외: sweep 운용 기능 확장. 기존 sweep/수명주기 회귀가 발견되면 별도 기록하고 담당 범위를 합의한다.

## 구현 전 결정과 S5 선행 계약 확정

| 미결 사항 | 반드시 정의할 결과 |
| --- | --- |
| 반복 complete | 동일 token의 두 번째 호출 반환값, 응답 덮어쓰기 허용 여부, TTL 갱신 여부. |
| 만료 후 complete | 새 token이 없어도 만료 lease를 stale로 볼지; v0.4 명세의 stale 요구와 조정. |
| 정확한 만료 경계 | `expiresAt == now`에서 get/create/complete/delete가 각각 어떤 결과를 내는지. |
| TTL 범위 | 긴 TTL 지원 방식 또는 최대값, 안전 정수/직접 adapter 호출 입력 검증 책임. |
| 삭제의 의미 | 논리적으로 만료됐지만 물리적으로 남은 행에 대한 delete 반환값과 소유권 검사. |

공통 결정 **D06**에 상태표·대안·선택 근거를 기록하고 `OPEN`에서 `DECIDED`로 갱신한다.
새 상태/반환값은 여기서 확정하지 않으며, 결정 자체가 별도 사용자 승인을 요구한다는 뜻은 아니다.

2026-10-07 S5 통합에 필요한 만료·token·반복 완료 계약을 [D06](../decisions.md#d06--저장소-공통-계약-decided)으로 확정했다.
긴 TTL과 직접 adapter 입력 검증 책임은 S6-5 후속 범위로 남는다. 아래 완료 표시는 해당 핵심 계약에 한정되며 S6 전체 완료를 뜻하지 않는다.

| 저장소 상태 | get | create | complete | delete |
| --- | --- | --- | --- | --- |
| 없음 / 만료됨 | `null` | 새 token으로 획득 | token과 대체 요청 유무에 관계없이 `stale` | token과 관계없이 `ok` |
| 유효한 PROCESSING, 같은 token | 현재 기록 | 획득 거절 | `ok`, 응답 저장·완료 TTL 적용 | `ok`, 삭제 |
| 유효한 COMPLETED, 같은 token | 현재 기록 | 획득 거절 | `stale`, 기존 응답·TTL 유지 | `ok`, 삭제 |
| 유효한 기록, 다른 token | 현재 기록 | 획득 거절 | `stale`, 변경 없음 | `stale`, 변경 없음 |

Memory/PG는 `expiresAt <= now`를 만료로 해석한다. Redis의 권한 시계는 서버 TTL이며 JSON의 `expiresAt`은 클라이언트가 기록한 표시 시각이다.
서로 다른 서버/클라이언트 시계의 동기화나 metadata와 서버 deadline의 밀리초 단위 일치는 보장하지 않는다.
논리적 만료는 timer/sweep 실행 여부와 분리한다. PG의 만료 행은 delete가 `ok`를 반환해도 물리적으로 남을 수 있다.
완료는 유효한 PROCESSING에서 한 번만 허용하며, 동시 완료의 단일 승자가 응답과 TTL을 결정한다. `createdAt`은 보존한다.
이 계약은 만료 후 업무 중단이나 업무 DB와 원자적인 저장을 뜻하지 않는다.

## 작업 체크리스트

- [x] **S6-1** 상태×token×시간의 기대 결과 표를 만들고 S5와 충돌하는 가정을 표시한다.
- [x] **S6-2** 공통 harness에 만료 제어·실서비스 cleanup 방법을 정의하고 baseline 차이를 재현한다.
- [x] **S6-3** 대체 요청 없는 만료와 정확한 경계에서 create/complete/delete 일관성을 구현한다. Memory/PG 정확한 경계, Redis 서버 TTL 만료 관찰 기준.
- [x] **S6-4** 반복 complete 정책을 세 어댑터에 적용하고 응답/TTL/createdAt 결과를 검증한다.
- [ ] **S6-5** Memory 긴 TTL과 timer 지연을 처리하고 직접 adapter 입력 검증 책임을 반영한다.
- [x] **S6-6** 동시 create의 단일 승자, 새 token 교체 후 옛 complete/delete 무효화를 실제 서비스에서 검증한다.
- [x] **S6-7** S5의 늦은 완료·실패·재시도 시나리오에 확정 계약을 연결하고 문서/타입을 동기화한다. 실제 S5 통합 증거는 S5 문서에서 관리한다.

## 완료 조건

- 하나의 기대 결과를 공유하는 contract suite가 Memory·실제 Redis·실제 PG에서 통과한다.
- 대체 요청 없는 만료, 새 token 교체, 반복 완료, 경계 시각, 긴 TTL을 모두 다룬다.
- 늦은 token은 새 소유자의 상태·응답·TTL·createdAt을 변경하지 않는다.
- 동시 create는 단일 승자이며, 정상 완료는 원래 createdAt을 보존하고 합의한 TTL을 적용한다.
- Memory의 timer 정수 범위 초과가 즉시 만료로 이어지지 않는다. 상한 정책이면 명시적 실패로 검증한다.
- 실제 DB 시간의 허용 오차, 테스트별 key/table 격리와 정리가 문서화돼 있다.
- S5가 사용할 확정 상태표·어댑터 검증 증거와 S7에 넘길 계약/호환성 설명이 준비돼 있다. S5 자체의 통합 완료를 S6 완료 조건으로 요구하지 않는다.

## 관련 파일

- [스토리지 인터페이스](../../../src/interfaces/idempotency-storage.interface.ts), [레코드 인터페이스](../../../src/interfaces/idempotency-record.interface.ts).
- [Memory](../../../src/storage/memory.storage.ts), [Redis](../../../src/storage/redis.storage.ts), [Postgres](../../../src/storage/postgres.storage.ts).
- [공통 계약](../../../test/support/shared-storage-contract.ts), [Memory spec](../../../test/storage/memory.storage.spec.ts), [실제 Redis spec](../../../test/storage/redis.storage.real.spec.ts).
- [PG spec](../../../test/storage/postgres.storage.spec.ts), [PG 경합 회귀](../../../test/regression/postgres-adapter.spec.ts), [TTL 입력 회귀](../../../test/regression/ttl-validation.spec.ts).
- [S5/S6 상태 전이 회귀](../../../test/regression/storage-lifecycle-contract.spec.ts): Memory timer 지연, PG 정확한 만료 경계, Redis 동시 완료.
- [0.4 처리 lease 명세](../../superpowers/specs/2026-06-16-v0-4-0-scope-spec.md), [테스트 DB 구성](../../../docker-compose.yml).

## 검증 명령과 환경

루트에서 `npm ci` 후 `npm run test -- --runInBand test/storage test/regression/ttl-validation.spec.ts test/regression/postgres-adapter.spec.ts`를 실행한다.
실제 PG 16과 Redis 7 테스트 인스턴스를 준비하고 `TEST_DATABASE_URL`, `TEST_REDIS_URL`을 설정해야 한다.
PG는 기존 `docker compose up -d postgres`와 `postgresql://test:test@localhost:5432/idempotency_test`를 사용할 수 있다.
현재 compose에는 Redis 서비스가 없다. 기존 CI의 Redis 7 구성을 참조하여 테스트 전용 서비스를 별도 준비한다.
Postgres spec은 전용 table 생성/삭제 권한, Redis spec은 전용 prefix 조회/삭제 권한이 필요하다. 운영 DB는 사용하지 않는다.
전체 회귀는 두 URL을 설정한 뒤 `npm run test:all -- --runInBand`로 확인한다.
DB 환경이 없으면 결과는 미검증/skip이다. Redis mock 성공이나 SQL 검토를 실제 어댑터 통과로 기록하지 않는다.

## 호환성과 다른 작업 인계

0.4 대비 반복 complete·만료 반환값·TTL 범위를 바꾸면 custom adapter 작성자에게도 영향이 있다.
S2에는 공개 타입 변경을, S5에는 확정 상태표를, S7에는 마이그레이션과 보장 한계를 전달한다. S5 통합은 S1·S6 이후 진행한다.
[S8](S8-release-validation.md)에는 실제 서비스 필수 검사 목록과 skip 감지 조건을 인계한다.

## 다음 작업자에게

- 마지막 갱신: 2026-10-07. S5 선행 계약 구현 완료, S6-5 미완료.
- 다음 행동: 긴 TTL 지원/명시적 상한, 안전 정수와 직접 adapter 입력 검증 정책을 결정하고 Memory timer overflow를 해결한다.
- 남은 한계: 30일 Memory TTL 문제는 이번 S5 선행 변경에서 해결하지 않았다. Redis의 표시 expiresAt과 서버 TTL 사이 시계 차이도 새 보장으로 추가하지 않았다.
- S7 호환성 인계: custom adapter는 만료된 lease의 complete를 대체 요청 없이도 stale 처리하고, 같은 token의 반복 완료가 응답이나 TTL을 변경하지 않도록 해야 한다.

### 2026-10-07 검증 증거

- 대상: `e13b370` 기반 작업 트리. 별도 배포 artifact 없음.
- red: 신규 회귀와 공통 harness를 제품 변경 전에 실행하여 Memory 만료 시 create 거절/complete 성공/다른 token delete stale, Memory·Redis 반복 완료 overwrite, PG 정확한 경계 create 거절/만료 complete 성공/만료 행 delete stale를 재현했다. 실제 Redis의 반복 완료도 실패했다.
- green 명령: `TEST_REDIS_URL=redis://127.0.0.1:16382 TEST_DATABASE_URL=postgresql://test@127.0.0.1:15435/idempotency_test npm test -- --runInBand test/storage test/regression/storage-lifecycle-contract.spec.ts test/regression/postgres-adapter.spec.ts`.
- 결과: **8 suites / 143 tests pass / 0 fail / 0 skip**. 저장소와 수정 fixture에 대한 targeted ESLint 통과. 전체 회귀·lint·build는 S5 통합 검증 결과를 참조한다.
- Memory 공통 harness는 살아 있는 record의 만료 시각을 현재로 설정하며, 경계 회귀는 timer 실행 없이 `jest.setSystemTime()`으로 -1/0/+1ms를 검사한다.
- PG 공통 harness는 전용 table의 만료 시각을 서버 `now()`로 설정한다. 정확한 equality 회귀는 별도 table과 transaction 내부의 고정된 `now()`를 사용하고 매회 rollback한다. malformed UUID는 이 transaction fixture에서 제외하고 일반 공통 suite에서 검증한다.
- Redis 공통 harness는 전용 UUID prefix와 `PEXPIRE 0`으로 서버 만료를 제어한다. 별도 실제 서버 테스트는 1초 lease 후 `PTTL == -2`를 20ms 간격, 최대 3초 내 관찰한 뒤 late complete를 검사한다. 고정 sleep만으로 만료를 판단하지 않는다.
- Redis 반복 완료는 표시 expiresAt 보존 외에 실제 PTTL이 증가하지 않는지도 검사한다. 공통 TTL 표시 시각 검사는 기존 ±1초 허용치를 사용하며, 외부 서비스 시계가 이 범위를 넘는 환경에서는 먼저 시간 동기화를 확인한다.
- 정리: Memory timer 해제; Redis 각 prefix의 key 삭제 후 client quit; PG spec별 table 격리·truncate/drop 및 pool 종료. 실제 DB가 없는 실행은 skip이므로 성공 증거로 대체하지 않는다.
