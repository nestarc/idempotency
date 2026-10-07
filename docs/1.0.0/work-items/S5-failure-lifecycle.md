# S5 장애 상태 전이와 수명주기

- 상태 단일 원본: [1.0.0 작업판](../README.md). 진행 상태와 담당자는 작업판에서만 관리한다.
- 조사 기준: 2026-10-06, 커밋 `9610774a767d152c4cbae49c6276a4f2d76463e4` (`9610774`).
- 근거 문서: [1.0.0 안정화 조사](../../1.0.0-stabilization-research.md)의 장애·저장소 계약 및 S5 항목.
- 이 문서는 구현 지침이다. 이번 문서화 요청에는 제품 코드·테스트·의존성 변경이 포함되지 않는다.

## 목적

업무 실행 결과와 idempotency 기록 결과를 구분하여 저장 후처리 실패가 중복 실행을 유도하지 않게 한다.
handler 실패, 완료 기록 실패, 구독 취소, 프로세스 종료와 lease 만료의 계약을 문서와 테스트로 고정한다.
결과가 불명확한 상태에서 안전하게 조회·조정하는 절차를 제공하고, 보장하지 않는 원자성을 명확히 한다.

## 재현 근거와 독립 재현 절차

아래 두 사례는 인터셉터와 MemoryStorage를 이용한 독립 실험으로 재현했다.
임시 스크립트나 다른 프로젝트의 의존성을 사용하지 않고 저장소의 Jest/RxJS fixture로 옮긴다.
S5 기본 재현에는 추가 외부 패키지가 필요 없다. 필요한 시험 의존성이 생기면 devDependency로 명시한다.
S1 serializer fixture를 재사용할 경우 class-transformer도 저장소 devDependency 설치본을 사용한다.

1. `@Idempotent()` metadata와 동일한 키·body의 실행 컨텍스트를 만든다.
2. MemoryStorage를 구성하고 `complete()`를 Promise 반환형이지만 호출 즉시 `throw new Error(...)`하는 구현으로 대체한다.
3. handler가 `{charged:true}`를 한 번 반환하도록 하고 인터셉터 결과와 저장 레코드를 확인한다.
4. 조사 결과는 성공 값 대신 오류 전파, 해당 레코드 `null`이었다. 재시도 시 업무 재실행이 가능한 상태다.
5. 같은 fixture의 `complete()`를 async rejection으로 바꾸어 비교한다. 기존 보호 경로와 결과가 달라지는지를 고정한다.

취소 재현은 바깥쪽 RxJS `timeout`으로 구독을 종료하고 handler의 비동기 작업을 나중에 완료시키는 구성이다.
조사에서는 timeout 10ms 이후 업무가 30ms에 성공했지만 PROCESSING 레코드가 남았고 기본 lease는 86,400초였다.
정식 테스트는 짧은 실제 시간 경합 대신 제어 가능한 Promise/스케줄러로 구독 종료와 업무 완료 순서를 고정한다.
이 관찰은 취소 후 무조건 삭제해야 한다는 근거가 아니다. 구독 취소와 업무 취소는 서로 다르다.

## 현재 동작과 아직 없는 증거

| 경로 | 기준 코드에서의 관찰/확인 | 남은 확인 |
| --- | --- | --- |
| handler exception | best-effort token delete 후 원래 오류 전파 | 업무 변경 전/후 예외의 소비자 정책과 복구 안내 |
| async complete rejection | 성공 값을 전달하고 PROCESSING 보존 | adapter별 실패·불명확한 쓰기 결과 및 후속 재시도 |
| sync complete throw | 성공 결과가 오류로 바뀌고 record 삭제; 재현됨 | 동일 실패 분류와 상태 보존 구현 |
| 외부 구독 취소 | 이후 업무가 성공해도 PROCESSING 유지; 재현됨 | 취소 후 결과 저장 여부와 지원 timeout 배치 |
| lease 만료 후 완료 | adapter마다 만료/반복 완료 조건이 다름 | S6 계약과 실제 Redis/PG 검증 |
| 프로세스 종료 | 메모리·구독이 사라지는 장애 경계만 확인 | 실제 자식 프로세스 중단·재시작 및 업무 원장 검증 미실시 |

## 포함 범위

- storage 메서드의 동기 throw/Promise rejection과 handler 오류의 구분.
- get/create/경합 재조회/complete/delete의 오류 전파·보존·관측 위치 점검.
- 업무 성공 뒤 완료 기록 실패, handler 실패 뒤 cleanup 실패의 상태 보존과 원래 오류 처리.
- 외부 timeout/unsubscribe, 결과 불명 상태, crash, 늦은 완료와 lease 만료 후 재시도.
- 운영자가 업무 원장과 idempotency 상태를 대조할 수 있는 조회·조정 절차 및 한계 설명.

## 제외 범위

- 업무 DB와 idempotency 기록을 하나의 transaction으로 묶는 범용 API.
- 자동 heartbeat/lease 연장, 강제 unlock API, 범용 retry·불명 쓰기 자동 복구와 중복 요청 wait 모드.
- business-error 캐싱의 범용 옵션 확대 및 모든 외부 업무의 exactly-once 보장.
- 저장소 만료·반복 complete 구현(S6), 응답 serialization/최종값 선택 구현(S1).

## 구현 전 결정 — 미결

공통 결정 **D05 — OPEN**이며 storage 결정 **D06**에 의존한다. 구현 전에 근거와 함께 DECIDED로 기록하며 별도 사용자 승인 필수 절차는 아니다.

| 결정 | 비교할 선택지와 기록할 내용 |
| --- | --- |
| handler 오류 | 현재 delete 정책 유지 여부, 업무 전·후 실패 구분 가능성, 소비자 책임을 정한다. 모든 오류를 안전한 재시도로 설명하지 않는다. |
| 저장 결과 불명 | 서버가 저장 요청을 반영했으나 응답이 유실된 경우의 계약·제약을 명시한다. 조회 가능 조건은 설명하되 자동 복구 기능으로 확장하지 않는다. |
| 구독 취소 | 작업 지속·결과 기록·구독 수명 분리의 지원 범위와 자원 비용을 검토한다. 취소를 업무 중단으로 간주하지 않는다. |
| stale/만료 | S6이 정한 만료 및 token 계약을 받아 늦은 완료·재시도의 사용자 결과를 정한다. |
| crash 조정 | 원장 조회, 재전송 보류/진행 판단에 필요한 증거, 서비스 운영자의 책임을 정한다. |

완료 기록 실패를 handler 실패로 오분류해 성공 작업의 lock을 삭제하는 동작은 제거해야 한다.
그 밖의 오류·취소 처리 방식을 이 문서가 이미 확정한 것으로 해석하지 않는다.
무조건 unlock, TTL을 줄이면 안전하다는 안내, exactly-once 보장 문구는 채택하지 않는다.

## 작은 작업 단위

- [ ] **S5-1 재현 고정:** 동기 throw/async rejection의 비교와 외부 취소 후 업무 완료를 단위 테스트로 옮긴다.
- [ ] **S5-2 전이 표:** 업무 결과·storage 상태·클라이언트 결과·재시도 조건을 장애별로 결정한다.
- [ ] **S5-3 오류 경계:** S1 파이프라인과 S6 계약 확정 뒤 storage 호출/후처리 오류를 handler 오류와 분리한다.
- [ ] **S5-4 취소 수명:** 결정한 timeout/unsubscribe 정책을 구현하고 늦은 업무 완료의 상태를 검증한다.
- [ ] **S5-5 장애 실험:** 공유 storage를 쓰는 자식 프로세스를 중단·재시작하고 lease 전/후 재시도를 관찰한다.
- [ ] **S5-6 불명 상태:** 업무 원장 조회·조정 예제와 위험한 재실행 조건을 S7과 문서화한다.
- [ ] **S5-7 통합 인계:** S4 관측 경로, S6 contract 결과, S8 장애 검증 증거를 묶어 작업판에 연결한다.

## 완료 조건

- 같은 storage 실패의 동기 throw와 async rejection이 동일한 분류·상태 정책을 따른다.
- 완료 기록 실패가 성공한 업무의 레코드를 handler-error cleanup 경로로 삭제하지 않는다.
- cleanup 실패가 원래 handler 오류를 대체하지 않고, 새 token의 레코드를 변경하지 않는다.
- 취소 후 업무 성공/실패/결과 불명의 레코드와 재시도 결과가 전이 표 및 테스트와 일치한다.
- crash 시점별 실험에 handler 실행 수, 업무 원장 결과, token/상태, 클라이언트 결과를 함께 기록한다.
- lease 만료 전·후와 대체 token 유무를 구분하고, S6의 늦은 complete 계약을 적용한다.
- 운영 문서에 조사 가능한 근거와 사람이 결정해야 하는 조건이 있으며 자동 복구를 과장하지 않는다.

## 관련 코드와 테스트

- [인터셉터](../../../src/idempotency.interceptor.ts): `acquireAndRun`, `captureResponse`, storage 오류 경계.
- [저장소 계약](../../../src/interfaces/idempotency-storage.interface.ts), [기록 타입](../../../src/interfaces/idempotency-record.interface.ts).
- [기존 완료 기록 실패 회귀](../../../test/regression/complete-failure-cascade.spec.ts), [인터셉터 테스트](../../../test/idempotency.interceptor.spec.ts).
- [공유 storage contract](../../../test/support/shared-storage-contract.ts), [fake storage](../../../test/support/fake-storage.ts).
- 신규 취소/crash fixture의 최종 파일 위치와 별도 실행 명령은 구현 시 이 문서에 추가한다.

## 검증 명령과 필요 환경

아래 명령은 구현 후의 검증 계획이며 이번 문서화에서 실행한 수정 검증 결과가 아니다.
`npm ci`와 지원 Node/npm이 필요하다. 아래 단위 검증만으로 실제 crash 복구가 입증되지는 않는다.

```sh
npm test -- --runInBand test/idempotency.interceptor.spec.ts test/regression/complete-failure-cascade.spec.ts
npm run lint
npm run build
```

crash 실험에는 공유 가능한 실제 Redis 또는 PG, 자식 프로세스 실행, 테스트 전용 업무 원장과 격리 namespace가 필요하다.
DB 실행·연결 설정 및 contract 명령은 S6을 따른다. mock/MemoryStorage 결과로 실제 DB 성공을 대신하지 않는다.
DB 없이 skip된 경우 환경과 미실행 항목을 남긴다. 새 장애 fixture는 별도 명령과 성공 기준을 추가해야 한다.

## 다른 작업 인계와 호환성

설계는 S1·S6과 병행할 수 있지만 **S1 파이프라인 통합 및 S6 저장소 계약 확정 뒤 S5를 통합**한다.
같은 `acquireAndRun`/`captureResponse`를 동시에 독립 수정하지 않도록 S1에서 결정·변경 지점을 인계받는다.
S4에는 오류 분류와 이벤트 시점을 전달한다. S4 최종 통합은 S3·S5 이후이며 S7에는 조정 절차, S8에는 실제 장애 검증 요구를 전달한다.
기존 handler 오류 후 재시도 동작이 바뀌면 호환성 변경으로 취급하고 마이그레이션 설명을 S7에 넘긴다.
storage API 또는 상태 모델 변경이 필요하면 S6·S2와 먼저 합의하며 custom adapter 영향도 함께 기록한다.

## 다음 작업자에게

### S4 관측 경계 인수인계 (2026-10-07)

[D04](../decisions.md#d04--관측-정보-보호-decided)의 error payload는 패키지 상수만 포함한다.
`get/create/race_get/delete` 실패는 `storage_error` 1회,
`complete` 실패는 `complete_error` 1회이며 operation으로 위치를 구분한다.
handler 오류 자체와 성공 cleanup은 새 이벤트를 내지 않고 onEvent 실패는 고정 로그만 1회 낸다.
동기 storage throw도 rejection과 같은 관측 경계로 들어가도록 보호했다.
`complete` 동기 throw를 handler 실패로 오분류해 cleanup하는 초기 재현은 S4에서 수정하므로,
위 기준 코드 표와 S1 인계의 동기 throw 항목은 역사적 baseline이다.
complete 실패에서는 성공 값을 전달하고 delete하지 않으며, delete 실패는 원 handler 오류를 보존한다.
원래 오류를 애플리케이션에 전파하는 경로에서도 event/logger에는 그 객체나 필드를 전달하지 않는다.

S5 작업 자체와 D05는 여전히 미착수/OPEN이다. S4 fake storage 회귀는 실제 DB의 불명 쓰기,
취소/crash/lease 만료 또는 업무 원장 조정을 검증한 증거가 아니다.
S5가 실패·취소 전이를 정하고 S6 계약을 통합한 뒤 S4의 전체 payload/이벤트 횟수/콜백 격리 회귀를
재실행한다. 상태 전이가 바뀌어도 `namespace`, `keyHash`, 고정 error code/operation만 내보내는
경계와 status header 비활성화 계약을 유지한다. S4 실제 실행 증거는 [S4 기록](S4-observability.md)을 참조한다.

### S1 인수인계 (2026-10-06)

[S1](S1-response-replay.md) 구현과 D01을 먼저 읽는다. `acquireAndRun`은
`takeLast(1)`/`defaultIfEmpty(undefined)` 뒤 단일 capture하며, unsupported 결과는
PROCESSING을 보존한다. 완료 전 cancel도 complete/delete하지 않는다.
`responseBody`는 versioned opaque string이고 legacy/corrupt COMPLETED는409로 유지한다.
동기 storage throw, capture 중 예외, complete 진행 중 취소, 업무 결과 불명 정책은 S5의 남은 범위다.
S6 계약이 확정되면 이 파이프라인 위에 통합한다. S1 성공 뒤 bypass를 delete하는 회귀를 만들지 않는다.

- S5 자체 구현 미착수. 마지막 갱신: 2026-10-07, S4 인수인계 추가. 상태 갱신은 [작업판](../README.md)에서 수행한다.
- 다음 구체 행동: S5-1 재현을 자체 fixture로 고정하고, S1·S6 담당과 S5-2 전이 표의 입력 계약을 정리한다.
- 미결: handler-error 보존 여부, 취소 후 기록 정책, 불명 쓰기의 재조회, stale 결과 처리와 crash 조정 절차.
- S5 자체 증거 없음: 최종 상태 전이 검증, 실제 다중 프로세스 crash, 실제 Redis/PG 장애 주입, 늦은 업무 결과의 조회·조정 절차 검증. S4 오류 관측 검증은 위 인계로 구분하며 자동 조정 기능 구현은 범위 밖이다.
