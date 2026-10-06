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

## 구현 전 결정

| 미결 사항 | 반드시 정의할 결과 |
| --- | --- |
| 반복 complete | 동일 token의 두 번째 호출 반환값, 응답 덮어쓰기 허용 여부, TTL 갱신 여부. |
| 만료 후 complete | 새 token이 없어도 만료 lease를 stale로 볼지; v0.4 명세의 stale 요구와 조정. |
| 정확한 만료 경계 | `expiresAt == now`에서 get/create/complete/delete가 각각 어떤 결과를 내는지. |
| TTL 범위 | 긴 TTL 지원 방식 또는 최대값, 안전 정수/직접 adapter 호출 입력 검증 책임. |
| 삭제의 의미 | 논리적으로 만료됐지만 물리적으로 남은 행에 대한 delete 반환값과 소유권 검사. |

공통 결정 **D06**에 상태표·대안·선택 근거를 기록하고 `OPEN`에서 `DECIDED`로 갱신한다.
새 상태/반환값은 여기서 확정하지 않으며, 결정 자체가 별도 사용자 승인을 요구한다는 뜻은 아니다.

## 작업 체크리스트

- [ ] **S6-1** 상태×token×시간의 기대 결과 표를 만들고 S5와 충돌하는 가정을 표시한다.
- [ ] **S6-2** 공통 harness에 만료 제어·실서비스 cleanup 방법을 정의하고 baseline 차이를 재현한다.
- [ ] **S6-3** 대체 요청 없는 만료와 정확한 경계에서 create/complete/delete 일관성을 구현한다.
- [ ] **S6-4** 반복 complete 정책을 세 어댑터에 적용하고 응답/TTL/createdAt 결과를 검증한다.
- [ ] **S6-5** Memory 긴 TTL과 timer 지연을 처리하고 직접 adapter 입력 검증 책임을 반영한다.
- [ ] **S6-6** 동시 create의 단일 승자, 새 token 교체 후 옛 complete/delete 무효화를 실제 서비스에서 검증한다.
- [ ] **S6-7** S5의 늦은 완료·실패·재시도 시나리오에 확정 계약을 연결하고 문서/타입을 동기화한다.

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

- 초기 기록: 구현 미착수. 마지막 갱신 2026-10-06.
- 다음 행동: S6-1 상태표를 만들고 S6-2에서 만료 후 대체 요청 없는 PG/Redis 재현부터 추가한다.
- 남은 이슈: 반복 완료·정확한 경계·긴 TTL 정책 미결, 실제 DB 재현 미실시.
- 구현 검증 증거: 미기록. `대상 commit / artifact(없으면 해당 없음) / 환경 / 명령 / pass·fail·skip / 제한`을 기록한다.
