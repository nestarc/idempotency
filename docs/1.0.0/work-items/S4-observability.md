# S4 관측 정보 보호

상태·담당은 [작업판](../README.md)에서 관리한다. 조사 기준: 2026-10-06, 0.4.0, `9610774a767d152c4cbae49c6276a4f2d76463e4`. 관련 결정: [D04](../decisions.md). 노출 재현은 바로 시작할 수 있고 최종 통합은 S3의 namespace와 S5의 실패 경로가 정해진 뒤 수행한다.

## 목적과 확인된 근거

관측 이벤트와 내부 로그가 raw idempotency key를 내보내지 않게 한다. 오류 관측이 업무 결과를 바꾸지 않으면서 created/replayed/conflict/mismatch/stale/storage failure를 구분할 수 있어야 한다.

조사 기준 0.4의 `emitEvent`는 `keyHash`와 함께 `scope: scopedKey`를 전달한다. 키 `sensitive-business-key`로 `POST /p`를 실행하고 onEvent의 전체 값을 확인하면 scope에 `POST /p::sensitive-business-key`가 들어간다. 일부 logger 메시지도 scopedKey와 원본 오류 메시지를 포함한다. 기존 keyHash만 확인하는 테스트는 이 노출을 놓친다. [0.4 설계](../../superpowers/specs/2026-06-16-v0-4-0-scope-spec.md)의 원본 키 비노출 목표와 일치시키는 작업이다.

## 범위와 확정 계약

포함: 이벤트·로그의 원본 키 제거, S3 namespace와의 연결, error 필드·메시지 노출 검토, 경합 재조회와 cleanup 등 오류 관측 경로, onEvent 동기/비동기 실패 격리, 공개 event 타입과 예제.

제외: 메트릭 수집 서버나 OpenTelemetry 의존성 추가, 관리 UI, 자동 복구 시스템. 별도 관측 인프라를 도입하지 않는다.

[D04](../decisions.md#d04--관측-정보-보호-decided)에서 `event.scope`를 제거하고 S3의 키 독립적인 `namespace`를 채택했다. `keyHash`는 S3 인코딩 저장 키의 SHA-256을 유지한다. 원본 오류의 어떤 필드도 읽거나 전달하지 않고 `error.code`와 storage `operation`만 생성한다. namespace/hash는 암호화나 개인정보 익명화 보장이 아니며 metric label로 사용하지 않는다. 사용자 callback·exception filter·driver가 별도로 기록하는 원본 오류는 패키지 관측 경계 밖이다.

## 작은 작업

- [x] **S4-1** 고유한 가짜 비밀 키를 사용해 onEvent 전체 객체와 logger 인자를 검사하는 회귀 테스트를 작성한다. hash 필드만 확인하지 않는다.
- [x] **S4-2** D04에 namespace·키 hash·오류 payload 계약과 기존 event 소비자 전환 영향을 기록한다.
- [x] **S4-3** 이벤트와 내부 로그에 공통 마스킹 방식을 적용한다. 성공, bypass, stale, complete error, cleanup error, callback error를 포함한다.
- [x] **S4-4** get/create/경합 get/complete/delete의 실패 경로를 S5와 대조하고, 어떤 event를 몇 번 내보내는지 테스트로 고정한다.
- [x] **S4-5** callback의 동기 throw와 Promise rejection, status header 비활성화에서 원 요청의 성공·실패·레코드 상태가 유지되는지 확인한다.
- [x] **S4-6** S2에 변경된 타입 export를, S7에 raw key/body를 기록하지 않는 운영 예제와 호환성 주의사항을 전달한다.

S4-4의 현재 5개 호출 경로는 동기 throw/Promise rejection과 callback 실패 조합까지 회귀로 고정했다. S5 문서의 기존 실패 경로와 대조하고 동기 complete/delete 경계를 선반영했다. 초기에는 D05·D06 미확정으로 열어 두었으며, 2026-10-07 S5 통합 후 같은 회귀와 추가 취소·capture·결과 불명 경로를 검증해 닫았다. 최종 증거는 아래 S5 인계를 따른다.

## 완료 조건

- [x] 모든 패키지 생성 이벤트·로그의 검사 대상 필드에서 가짜 원본 키를 찾을 수 없다. 원본 키가 포함된 저장소 오류 메시지 사례도 결정한 처리와 일치한다.
- [x] S3의 저장 키 인코딩 변경이 keyHash·namespace에 미치는 영향이 기록되어 있다.
- [x] S5가 정의한 오류 경로에서 관측 누락·중복을 검증했고 callback 실패가 HTTP 응답이나 저장소 정리를 바꾸지 않는다.
- [x] status header 노출/비노출과 replay 헤더 정책이 문서·테스트와 일치한다.
- [x] 기존 event.scope 소비자가 조정할 사항과 진단 정보의 한계를 기록했다. metric label에 요청별 keyHash를 무제한 사용하도록 예제를 쓰지 않는다.

## 관련 파일과 검증

- [인터셉터](../../../src/idempotency.interceptor.ts)의 `emitEvent`, `setIdempotencyStatus`, 저장소 실패 로그.
- [IdempotencyEvent와 관측 옵션](../../../src/interfaces/idempotency-options.interface.ts), [공개 export](../../../src/index.ts).
- [관측 unit 테스트](../../../test/idempotency.interceptor.spec.ts), [헤더 처리](../../../src/utils/response-headers.ts), [헤더 테스트](../../../test/utils/response-headers.spec.ts).
- [전체 payload·실패 경로 회귀](../../../test/regression/observability-safety.spec.ts), [상태 헤더·sweep 로그 회귀](../../../test/regression/observability-headers-sweep.spec.ts), [공통 고정 로그](../../../src/utils/observability.ts).

저장소 루트에서 실행한다. 기본 관측 검사는 fake storage로 가능하며, 실제 DB 장애 증거와 혼동하지 않는다. 신규 회귀 파일도 별도로 포함한다.

```sh
npm run test -- --runInBand test/idempotency.interceptor.spec.ts test/utils/response-headers.spec.ts test/regression/observability-safety.spec.ts test/regression/observability-headers-sweep.spec.ts
npx tsc --noEmit --incremental false -p tsconfig.json
```

## 다음 작업자에게

### S3 인수인계 (2026-10-07)

[D03](../decisions.md#d03--요청-격리와-키-입력-decided)의 v1 키는 JSON tuple의 SHA-256이다.
`src/utils/request-key.ts`의 `createRequestKey(namespaceTuple, rawKey)`가 `{ key, namespace }`를 반환한다.
`namespace`는 raw key 없이 identity + endpoint tuple만 hash하며 key 변경에도 동일하다.
별도 `test/utils/request-key.spec.ts`가 이 독립성과 wire format을 고정한다.
S3 인계 시 interceptor는 `.key`만 사용하고 event.scope 및 fingerprint input.scope도 그 저장 key를 받았다.
S4는 `{ key, namespace }`를 처리 경로에 전달하여 관측에 namespace를 연결했다. fingerprint input.scope의 저장 키 계약은 유지한다.
키 hash는 인코딩 변경으로 이전 값과 달라진다. S3만으로는 원본 오류 객체/메시지의 노출이 해결되지 않았다.
identity·동적 path의 hash는 암호화가 아니고 추측 및 cardinality 위험이 남는다.
관측 전체 마스킹과 오류 경로는 S4/S5 작업이며 S3 완료를 S4 완료로 간주하지 않는다.

### S4 구현과 후속 통합 (2026-10-07)

- 작업자/위치: Codex, 기존 checkout 작업 트리. 기준 commit `2fc43d7620dcdcff0d367669acc88a5e1a05b7dd`. commit/publish는 실행하지 않았다.
- 완료: S4-1/2/3/5/6. D04 확정, 이벤트 namespace·안전 오류 타입, 공통 고정 로그, 상태 헤더 capture/replay 차단, 공개 export·소비자 fixture·README recipe.
- S4-4 현재 경로 구현: `get/create/race_get/delete`는 `storage_error` 1회, `complete`는 `complete_error` 1회. `error`는 `{ code: 'storage_failure', operation }`. get/create/race_get은 원본 오류를 전파하고 handler를 실행하지 않는다. complete 실패는 handler 성공값을 유지하고 delete하지 않는다. cleanup delete 실패는 원본 handler 오류를 유지한다. 동기 throw와 rejection을 같은 경계에서 처리한다.
- 정상 결과: created/replayed/conflict/mismatch/stale 1회. replay 불가능한 handler 결과는 bypassed 1회와 `{ code: 'response_not_replayable' }`. 과거 replay 불가능한 저장 결과는 error 필드 없는 conflict 1회. 성공한 cleanup 및 handler 오류 자체에는 별도 이벤트가 없다.
- callback 실패: 동기 throw/rejection은 안전한 고정 warning 1회로 종료하고 추가 이벤트를 내보내지 않는다. callback이 event를 변조해도 패키지 로그는 내부 namespace/keyHash로 새로 생성한다. callback은 await하지 않는다. 패키지는 관측을 위해 원본 오류 값의 getter/toJSON을 호출하지 않는다.
- 검사: fake key/body/response/identity/path와 오류 message/stack/cause/비열거 필드까지 전체 JSON 및 `util.inspect(showHidden: true)`로 확인한다. sweep는 fake pool 장애를 사용하며 실제 DB 장애 주입 증거가 아니다.
- S5에 남기는 한계: D05/D06 최종 실패·취소·crash·만료 계약과 실제 DB 결과 불명 쓰기는 미검증이다. 기존 HTTP response getter/header setter 예외와 capture 후처리 경계도 S5에서 분리한다. `captureResponse`의 기존 total 주석을 모든 어댑터/HTTP 예외에 대한 보장으로 읽지 않는다.
- 로깅 한계: 직접 호출한 Logger 메서드의 throw/반환 Promise는 격리한다. Nest가 내부에서 버리는 custom async transport Promise는 패키지가 관찰할 수 없으며 transport가 자체 처리해야 한다.
- 당시 다음 행동: S5/D05·S6/D06 수명 계약 통합 후 회귀를 재실행하고 S4-4를 닫는 것이었다. 아래 S5 최종 통합 기록에서 완료했다.
- 인계: S2 새 `IdempotencyEventError`/`IdempotencyStorageOperation` export, S5 오류별 1회 관측, S7 event.scope→namespace 및 오류 code/operation 전환, S8 tarball/최종 matrix 재검증.

## 검증 증거 — 2026-10-07

대상은 위 기준 commit + S4 작업 트리다. [보존 JSON](../evidence/S4-validation.json)에 실행 명령, 소스 hash, artifact와 로그 위치를 기록한다.

| 검증 | 결과 | 증거/한계 |
| --- | --- | --- |
| 수정 전 전체 payload 회귀 | 초기 56개 중 55 fail / 1 pass | `/private/tmp/idempotency-s4-red.log`; 변경 전 src 복사본에서 컴파일 성공 후 runtime 실패 |
| 수정 전 상태 헤더·sweep | 헤더 신규 2개 fail, sweep 비밀값 검사 1개 fail | sweep baseline은 동시 코드 편집의 타입 오류를 피해 일회성 ts-jest diagnostics:false; 최종 검증은 원 설정 |
| 전체 lint/test/build | `npm run prepublishOnly` 성공, 32 suites / 681 pass / 0 fail / 0 skip | `/private/tmp/s4-prepublish.log`; 별도 테스트 Redis7.2.7/PG16.14 사용 |
| 개발 타입 검사 | `npx tsc --noEmit --incremental false -p tsconfig.json` 성공 | `/private/tmp/s4-typecheck.log` |
| 실제 tarball 소비자 | `npm run test:consumers` 성공, 41 pass / 기대된 타입 실패 3 / 0 skip | `/private/tmp/idempotency-consumers-fvsLTs/summary.json`; root 공개 타입·node/node16/nodenext·Memory/Redis/PG 실행 |

Node24.11.1/Nest11 대표 환경이다. 실제 저장소 정상 contract 검증과 fake storage/pool의 오류 주입을 구분한다. S8 전체 지원 matrix·실제 장애 실험·릴리스 승인을 대신하지 않는다.


### S5 최종 통합 검증 (2026-10-07)

S5/D05 및 S6/D06 수명 계약을 반영한 최종 파이프라인으로 기존 payload·callback·header/sweep
회귀를 모두 재실행했다. capture 예외는 bypassed, complete 실패는 complete_error,
handler cleanup 실패는 storage_error/delete로1회이며 성공 후 delete 경로는 분리됐다.
취소된 구독에서 pending storage Promise가 반영돼도 이벤트/헤더는 보장하지 않는다.
관측 헤더 쓰기 실패는 원 결과와 이벤트 분류를 유지한다. FakeStorage가 논리적 만료를 따르게 돼
기존 고정 과거 날짜 seed를 현재+60초로 수정했다.

`npm run prepublishOnly` **36 suites / 768 pass / 0 skip**, 개발 타입 검사 성공,
실제 tarball 소비자 **41 pass / 기대된 실패3 / 0 skip**. S4-4 및 남은 완료 조건을 충족했다.
검증 대상/명령/원시 증거는 [S5 기록](S5-failure-lifecycle.md)과
[S5 JSON](../evidence/S5-validation.json)을 따른다. 기존 S4 JSON의 통합 대기 표기는 당시 기록이다.
S6 긴 TTL/입력 정책 및 S8 전체 matrix는 별도 작업이다.
