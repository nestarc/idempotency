# S4 관측 정보 보호

상태·담당은 [작업판](../README.md)에서 관리한다. 조사 기준: 2026-10-06, 0.4.0, `9610774a767d152c4cbae49c6276a4f2d76463e4`. 관련 결정: [D04](../decisions.md). 노출 재현은 바로 시작할 수 있고 최종 통합은 S3의 namespace와 S5의 실패 경로가 정해진 뒤 수행한다.

## 목적과 확인된 근거

관측 이벤트와 내부 로그가 raw idempotency key를 내보내지 않게 한다. 오류 관측이 업무 결과를 바꾸지 않으면서 created/replayed/conflict/mismatch/stale/storage failure를 구분할 수 있어야 한다.

현재 `emitEvent`는 `keyHash`와 함께 `scope: scopedKey`를 전달한다. 키 `sensitive-business-key`로 `POST /p`를 실행하고 onEvent의 전체 값을 확인하면 scope에 `POST /p::sensitive-business-key`가 들어간다. 일부 logger 메시지도 scopedKey와 원본 오류 메시지를 포함한다. 기존 keyHash만 확인하는 테스트는 이 노출을 놓친다. [0.4 설계](../../superpowers/specs/2026-06-16-v0-4-0-scope-spec.md)의 원본 키 비노출 목표와 일치시키는 작업이다.

## 범위와 미결 정책

포함: 이벤트·로그의 원본 키 제거, S3 namespace와의 연결, error 필드·메시지 노출 검토, 경합 재조회와 cleanup 등 오류 관측 경로, onEvent 동기/비동기 실패 격리, 공개 event 타입과 예제.

제외: 메트릭 수집 서버나 OpenTelemetry 의존성 추가, 관리 UI, 자동 복구 시스템. 별도 관측 인프라를 도입하지 않는다.

D04에서 scope를 안전한 namespace·route 표현으로 바꿀지 제거할지, keyHash의 안정성 범위, 오류 정보의 허용 필드를 정한다. raw key가 error.message/stack에 포함되는 경우도 고려한다. callback에 임의의 원본 Error를 그대로 전달하면서 모든 필드가 안전하다고 약속하지 않는다. 동적 path에 민감한 값이 있을 수 있으므로 “raw key가 없다”와 “모든 개인정보가 없다”를 구분한다.

## 작은 작업

- [ ] **S4-1** 고유한 가짜 비밀 키를 사용해 onEvent 전체 객체와 logger 인자를 검사하는 회귀 테스트를 작성한다. hash 필드만 확인하지 않는다.
- [ ] **S4-2** D04에 namespace·키 hash·오류 payload 계약과 기존 event 소비자 전환 영향을 기록한다.
- [ ] **S4-3** 이벤트와 내부 로그에 공통 마스킹 방식을 적용한다. 성공, bypass, stale, complete error, cleanup error, callback error를 포함한다.
- [ ] **S4-4** get/create/경합 get/complete/delete의 실패 경로를 S5와 대조하고, 어떤 event를 몇 번 내보내는지 테스트로 고정한다.
- [ ] **S4-5** callback의 동기 throw와 Promise rejection, status header 비활성화에서 원 요청의 성공·실패·레코드 상태가 유지되는지 확인한다.
- [ ] **S4-6** S2에 변경된 타입 export를, S7에 raw key/body를 기록하지 않는 운영 예제와 호환성 주의사항을 전달한다.

## 완료 조건

- [ ] 모든 패키지 생성 이벤트·로그의 검사 대상 필드에서 가짜 원본 키를 찾을 수 없다. 원본 키가 포함된 저장소 오류 메시지 사례도 결정한 처리와 일치한다.
- [ ] S3의 저장 키 인코딩 변경이 keyHash·namespace에 미치는 영향이 기록되어 있다.
- [ ] S5가 정의한 오류 경로에서 관측 누락·중복을 검증했고 callback 실패가 HTTP 응답이나 저장소 정리를 바꾸지 않는다.
- [ ] status header 노출/비노출과 replay 헤더 정책이 문서·테스트와 일치한다.
- [ ] 기존 event.scope 소비자가 조정할 사항과 진단 정보의 한계를 기록했다. metric label에 요청별 keyHash를 무제한 사용하도록 예제를 쓰지 않는다.

## 관련 파일과 검증

- [인터셉터](../../../src/idempotency.interceptor.ts)의 `emitEvent`, `setIdempotencyStatus`, 저장소 실패 로그.
- [IdempotencyEvent와 관측 옵션](../../../src/interfaces/idempotency-options.interface.ts), [공개 export](../../../src/index.ts).
- [관측 unit 테스트](../../../test/idempotency.interceptor.spec.ts), [헤더 처리](../../../src/utils/response-headers.ts), [헤더 테스트](../../../test/utils/response-headers.spec.ts).

저장소 루트에서 실행한다. 기본 관측 검사는 fake storage로 가능하며, 실제 DB 장애 증거와 혼동하지 않는다. 신규 회귀 파일도 별도로 포함한다.

```sh
npm run test -- --runInBand test/idempotency.interceptor.spec.ts test/utils/response-headers.spec.ts
npx tsc --noEmit --incremental false -p tsconfig.json
```

## 다음 작업자에게

### S3 인수인계 (2026-10-07)

[D03](../decisions.md#d03--요청-격리와-키-입력-decided)의 v1 키는 JSON tuple의 SHA-256이다.
`src/utils/request-key.ts`의 `createRequestKey(namespaceTuple, rawKey)`가 `{ key, namespace }`를 반환한다.
`namespace`는 raw key 없이 identity + endpoint tuple만 hash하며 key 변경에도 동일하다.
별도 `test/utils/request-key.spec.ts`가 이 독립성과 wire format을 고정한다.
현재 interceptor는 `.key`만 사용하고 event.scope 및 fingerprint input.scope도 그 저장 key를 받는다.
S4는 request 처리 경로에 namespace를 별도로 전달하거나 더 제한된 route 표현을 선택해 D04를 확정한다.
키 hash는 인코딩 변경으로 이전 값과 달라진다. 현재 key가 hash라도 원본 오류 객체/메시지의 노출은 해결되지 않았다.
identity·동적 path의 hash는 암호화가 아니고 추측 및 cardinality 위험이 남는다.
관측 전체 마스킹과 오류 경로는 S4/S5 작업이며 S3 완료를 S4 완료로 간주하지 않는다.


- 마지막 갱신: 2026-10-06. 구현 미착수, 새 검증 증거 없음.
- 다음 행동: `test/regression/`에 전체 event JSON과 Logger spy의 원본 키 포함 여부를 검증하는 회귀를 추가하고 기존 onEvent 테스트도 보강한다.
- 미결: D04. namespace 표현은 S3와 맞추고 오류 분기는 S5의 최종 변경 뒤 재검증한다.
- 인계 대상: S2 타입 export, S7 관측 recipe, S8 회귀 검사.
- 검증 기록: 대상 commit/artifact, 환경, 명령, pass/fail/skip, 증거와 남은 제한을 실행 후 기록한다.
