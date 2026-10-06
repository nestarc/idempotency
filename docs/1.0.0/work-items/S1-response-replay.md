# S1 응답 재생 정확성

- 상태 단일 원본: [1.0.0 작업판](../README.md).
- 기준: 2026-10-06, `9610774a767d152c4cbae49c6276a4f2d76463e4` (`0.4.0`) 위 작업 트리 변경. 아직 릴리스/커밋하지 않았다.
- 근거: [안정화 조사](../../1.0.0-stabilization-research.md), [D01 결정](../decisions.md#d01--응답-재생-경계-decided).
- 사용자 S1 구현 요청에 따라 제품 코드·테스트·개발 의존성·도입 문서를 갱신했다.

## 결과

응답 변환이 끝난 plain JSON을 정상 완료 뒤 저장하도록 경계를 확정했다.
지원 순서는 `IdempotencyInterceptor` → `ClassSerializerInterceptor` → handler다.
최초 응답은 역순으로 변환 후 저장하며 replay는 안쪽 변환을 다시 실행하지 않는다.
`@Exclude()`, `@Transform()`, `@SerializeOptions({ type })`를 실제 Express/Fastify HTTP로 검증했다.

미지원 클래스·파일·binary를 JSON으로 저장하거나 성공한 작업의 잠금을 바로 삭제하지 않는다.
수동 응답은 handler 실행 전에 차단한다. 이미 저장된 구형 응답도 제외 필드가 섞였을 수 있으므로
버전 표식이 없는 COMPLETED는409로 거부하고 기존 레코드를 유지한다.

## 확정 계약과 지원 표

| 경로 | 최초 요청 / HTTP 종료 | 저장 상태 | 같은 키 후속 요청 |
| --- | --- | --- | --- |
| plain JSON·Promise, idempotency 바깥/serializer 안쪽 | 변환된 최종 status/body/허용 헤더를 Nest가 전송 | COMPLETED, 버전 표식 포함 | 동일 status/body/허용 헤더 재생, handler/안쪽 serializer 생략 |
| 일반 HTTP Observable | 정상 complete까지 대기, 마지막 값만 전송 | complete 뒤 한 번만 COMPLETED | 완료 전409, 완료 후 최종값 replay |
| EMPTY | undefined 빈 성공. 명시한204도 유지 | undefined 전용 표식으로 COMPLETED | 빈 응답 replay |
| intermediate 이후 error | intermediate를 응답으로 내보내지 않고 기존 Nest 오류 경로 | complete 없음, 기존 best-effort delete | 삭제 성공 시 다음 실행 가능. 전체 실패 정책은 S5 |
| 완료 전 구독 취소 | 해당 구독 종료; 업무 취소/실패로 단정하지 않음 | complete/delete 없음, 기존 PROCESSING | lease 동안409 |
| raw class·중첩 class·Date·StreamableFile·binary·stream·비JSON | 원래 값을 Nest/adapter에 전달, `bypassed` 기록. 파일은 정상 파일로 전달되며 adapter가 원래부터 처리하지 못하는 값의 HTTP 성공은 보장하지 않음 | PROCESSING 유지, complete/delete 없음 | 기존 processingTtl 동안409, 만료 후 재실행 가능 |
| `@Res({ passthrough:true })` + 상태/헤더 변경 후 반환 | 반환값 기반 자동 응답 | 지원 JSON이면 COMPLETED | replay |
| passthrough 코드가 이미 `send()` | 이미 전송한 응답을 유지, 추가 헤더 쓰기 없음 | PROCESSING 유지 | lease 동안409 |
| 직접 `@Res()` / `@Next()` without passthrough | handler 전에500 configuration error로 종료 | storage 접근 없음 | 매번 같은 configuration error, handler 미실행 |
| `@Render()` / `@Redirect()` | adapter의 별도 렌더/리다이렉트 경로 사용 전에500 | storage 접근 없음 | 매번500, handler 미실행 |
| SSE | Nest가 먼저200 event-stream을 열 수 있음. error event 뒤 연결 종료 | handler·storage 접근 없음 | 매번 error event 후 종료 |
| decorated non-HTTP | configuration exception, HTTP 상태 접근 없음 | storage 접근 없음 | 지원 대상 아님 |
| legacy·손상·미지원 버전 COMPLETED | 저장 status/headers/body를 적용하지 않고409 | 원본 레코드 유지, TTL 갱신 없음 | 업무 확인 또는 자연 만료까지409. 다른 fingerprint는422 우선 |

`@Idempotent()`가 없거나 disabled면 기존 pass-through다. 미지원 경로 검사는 활성 decorator에
항상 적용되어 `required:false` 및 키 누락으로 잘못된 응답 구성을 우회하지 않는다.

### 직렬화 순서의 제약

- 같은 scope에서 idempotency를 serializer보다 먼저 등록한다. 전역 `APP_INTERCEPTOR`도 같은 순서다.
- 전역 serializer + controller/method idempotency는 잘못된 순서다. DTO/중첩 DTO라면 bypass와409로 정보 노출을 막는 회귀 테스트가 있다.
- plain 객체만으로 모든 잘못된 순서나 사용자 정의 바깥 변환을 자동 판별할 수는 없다. 바깥 `@SerializeOptions({type})`, custom map interceptor 등의 변환까지 지원한다고 해석하지 않는다.
- adapter의 응답 schema/serializer가 idempotency 뒤에서 값을 더 변환하는 구성도 지원 계약 밖이다.
- class-transformer를 제품 코드에서 다시 호출하지 않는다. 이미 변환된 값의 중복 변환과 메타데이터 복구 추측을 피한다.

### 저장 가능한 값

유한 숫자, 문자열, boolean, null, 일반 배열, 재귀적인 plain/null-prototype 객체, root undefined를 지원한다.
비열거 data property는 HTTP JSON처럼 무시한다. Date는 이 경계 전에 문자열로 바꾼다.
클래스·custom prototype·Buffer/typed array·stream·접근자·toJSON·Proxy·순환·희소 배열·배열의 추가 열거 속성·
심벌 키/값·함수·BigInt·비유한 수·nested undefined는 거부한다.
검사/저장은 getter·toJSON·proxy trap을 실행하지 않는 snapshot 방식이다.
HTTP adapter가 응답을 실제로 전송하기 전 애플리케이션이 반환 객체를 다시 변경하는 구성은 지원하지 않는다.

## 저장 형식과 전환

`responseBody`는 다음 prefix와 tagged payload를 가진 opaque string이다.

```text
@nestarc/idempotency:replay:v1:{"kind":"json","value":{"id":1}}
@nestarc/idempotency:replay:v1:{"kind":"undefined"}
```

prefix는 JSON 문법상 시작할 수 없는 문자로 시작하므로 옛 `JSON.stringify()` 결과와 충돌하지 않는다.
사용자 본문이 envelope처럼 생겼거나 prefix를 포함한 문자열이어도 그대로 별도 value로 저장된다.
기존 root undefined도 표식이 없으면 legacy로 거부한다. 손상되거나 알 수 없는 형식도409다.

키·상태·DB schema·공개 함수 시그니처는 바꾸지 않았다. `CompleteResponse.body`/`IdempotencyRecord.responseBody`
JSDoc은 JSON 문자열에서 opaque 문자열 계약으로 수정했다. custom adapter는 문자열을 해석/정규화하지 않고
그대로 보존해야 한다. Memory/Redis mock 공통 계약으로 비JSON 문자열 보존을 검증했다.
Postgres는 TEXT 컬럼을 사용한다는 코드 확인만 했으며 실제 DB 검증은 미실행이다.

전환/롤백은 old/new reader와 writer가 혼재하지 않도록 수행한다.

1. 보호 endpoint의 트래픽을 멈추고 기존 in-flight 작업을 종료시킨다.
2. 기존 storage/key를 보존한 채 모든 애플리케이션 인스턴스를 교체한다.
3. 트래픽을 재개한다. legacy409는 원 작업을 업무 시스템에서 확인하며, 일괄 삭제·새 키 자동 재시도로 우회하지 않는다.
4. 롤백 시에도 트래픽 중단/drain이 필요하다. 구버전은 새 prefix를 JSON으로 읽을 수 없으므로 새 레코드의 보존기간과 업무 확인이 끝나기 전에 구버전 reader를 투입하지 않는다.

기존 레코드 삭제나 key prefix 교체는 같은 업무를 새 요청으로 실행할 수 있어 전환 수단으로 채택하지 않았다.
자연 만료 뒤에도 재실행 가능성은 남는다. TTL 만료는 원 업무 실패나 exactly-once 보장의 증거가 아니다.
S3/D03에서 키 형식을 결정한 뒤 S7/D07이 이 전환과 함께 최종 서비스별 절차를 구성한다.

## 완료한 작은 작업

- [x] **S1-1 재현 환경:** class-transformer0.5.1을 devDependency/lockfile에 고정, 자체 Nest/HTTP fixture 추가.
- [x] **S1-2 지원 표:** D01 DECIDED, HTTP 종료·저장 상태·재시도 계약을 위 표로 기록.
- [x] **S1-3 직렬화 경계:** 재귀적인 plain JSON 검사, Exclude/Transform/type 및 전역 serializer 조합 회귀.
- [x] **S1-4 완료 시점:** `takeLast(1)` + `defaultIfEmpty(undefined)` 후 단일 capture. error/cancel 시 intermediate 비저장.
- [x] **S1-5 응답 유형:** 파일/binary lease 유지, 수동/렌더/리다이렉트/SSE 사전 차단, passthrough 지원 경계.
- [x] **S1-6 HTTP 검증:** Express/Fastify 실제 HTTP 회귀28개, 상태·본문·허용 헤더 비교.
- [x] **S1-7 인계:** README/CHANGELOG/D01/작업판 및 S5·S7·S8 인수인계 갱신.

## 변경 위치

- [인터셉터](../../../src/idempotency.interceptor.ts): mode 검사, versioned decode, 마지막 정상 완료 뒤 capture, bypass lease 유지.
- [응답 codec](../../../src/utils/replay-body.ts): strict snapshot, 버전 인코딩/안전한 디코딩. 공개 barrel로 export하지 않는다.
- [응답 모드 검사](../../../src/utils/response-mode.ts): handler property를 prototype 체인에서 찾아 Nest의 constructor+method 인자 metadata 조회.
- [저장 응답 계약](../../../src/interfaces/idempotency-storage.interface.ts), [레코드 계약](../../../src/interfaces/idempotency-record.interface.ts): opaque body JSDoc.
- [공통 storage test](../../../test/support/shared-storage-contract.ts): 비JSON payload 보존 테스트. adapter 구현은 변경 없음.
- [README](../../../README.md#response-replay-contract), [CHANGELOG](../../../CHANGELOG.md): 공개 제약·전환·unreleased 변경.

| 회귀 파일 | 검사 내용 |
| --- | --- |
| [response-replay-http.spec.ts](../../../test/regression/response-replay-http.spec.ts) | 실제 HTTP28개: 양 adapter에서 Exclude/Transform/type, 전역 serializer 조합, 파일, EMPTY204, 최종값, manual/Next/render/redirect/SSE/passthrough send |
| [response-completion.spec.ts](../../../test/regression/response-completion.spec.ts) | Subject/deferred 제어6개: intermediate private, 마지막값 단일 저장, error, EMPTY, emission 전/후 cancel |
| [replay-body-format.spec.ts](../../../test/regression/replay-body-format.spec.ts) | codec50개: legacy·marker 충돌·손상·undefined·strict shape·hook 비실행 |
| [response-replay-boundary.spec.ts](../../../test/regression/response-replay-boundary.spec.ts) | legacy/손상409와 status/header 비적용, 원본 레코드 유지, fingerprint 우선, 상속/rename된 manual handler, non-HTTP9개 |

기존 interceptor 및 race-completed-winner 테스트의 정상 seed는 새 형식으로 명시적으로 바꿨다.
FakeStorage.seed에서 legacy를 자동 변환하지 않는다. 기존 binary/circular 테스트도 잠금 유지·retry409·handler1회를 확인한다.

## 검증 증거 (2026-10-06)

환경: Node24.11.1, npm11.6.2, Nest common/core11.1.18, Express adapter11.1.18/Fastify adapter11.1.19,
class-transformer0.5.1, 저장소 package-lock 설치본.
대상은 위 기준 commit 위 S1 작업 트리이며 다른 프로젝트 의존성에 의존하지 않는다.

| 검사 | 결과 | 한계/근거 |
| --- | --- | --- |
| 수정 전 Observable 재현 | 6개 중5 fail / 1 pass | 중간값 capture, 다중 complete, error 전 capture, EMPTY EmptyError, emission 후 cancel을 기존 코드에서 재현 |
| 수정 전 실제 HTTP 재현 | 최초20개 중16 fail / 4 pass | 기존 런타임의 잘못된 순서/파일/manual/SSE 경로. 올바른 순서 Exclude/Transform/type4개는 원래 통과 |
| 이전 interceptor로 boundary 재현 | 9개 중8 fail / 1 pass | 별도 임시 fixture에 HEAD의 interceptor를 복사하여 실행. legacy 재생/형식 오류/상속 manual/non-HTTP 차단 실패, fingerprint 우선은 기존에도 통과 |
| 수정 후 실제 HTTP | 28 pass | 두 adapter, 실제 socket 사용. sandbox listen EPERM은 제품 실패와 분리하고 허용된 재실행으로 확인 |
| 수정 후 완료/legacy boundary | 15 pass | Subject/deferred 사용, 타이머에 의존하지 않는 완료 제어 |
| 기존 interceptor/race | 65 pass | 새 형식 seed 및 변경된 bypass 정책 |
| `npx tsc --noEmit --incremental false -p tsconfig.json` | exit0 | 전체 개발/테스트 타입 검사 |
| `npm run prepublishOnly` | exit0 | clean → lint → 전체 tests → build |
| 전체 tests (위 pipeline) | **293 pass / 41 skip**, 19 suites pass / 6 skip | 실제 PG29개·Redis12개는 접속 환경 없음. S8 출시 검증 미완료 |
| 문서 local link / `git diff --check` | 누락/공백 오류 없음 | 작업 문서와 README/CHANGELOG12개 검사 |

기본 환경에서 npm registry DNS가 거부되어 의존성 설치만 네트워크 허용 후 실행했다.
실제 DB skip 수는 baseline39개에서 공통 opaque-body 테스트가 각 실제 adapter에 추가되어41개가 됐다.
Nest10 및 Node20/22 조합, 실제 PG/Redis, tarball 소비자 검증은 S8/S2에 남아 있다.
S1 완료는 1.0 출시 준비 완료를 뜻하지 않는다.

재실행 명령:

```sh
npm ci
npm test -- --runInBand test/regression/response-replay-http.spec.ts test/regression/response-completion.spec.ts test/regression/replay-body-format.spec.ts test/regression/response-replay-boundary.spec.ts
npx tsc --noEmit --incremental false -p tsconfig.json
npm run prepublishOnly
```

## 다른 작업 인계

- **S2:** public export/signature 변경 없음. helper는 내부 경로. 개발 전용 class-transformer 의존성 추가.
- **S3:** 저장 키 변경 없음. 향후 키 전환과 S1 body 전환을 함께 고려하고409를 단순 새 키로 회피하지 않는다.
- **S4:** 신규 `bypassed`/`conflict` 경로와 legacy decode 거부를 검토한다. `bypassed`는 이미 sent이면 status header를 쓰지 않는다. 새로운 outcome enum은 추가하지 않았다. 기존 raw scope/log 문제는 별도다.
- **S5:** 완료 경계는 takeLast/defaultIfEmpty 후 capture. error 시 기존 cleanup, cancel 시 lease 유지. 동기 storage throw, capture 부수효과 throw, complete 도중 cancel 등 전체 수명주기는 S5에서 다룬다. unsupported 성공 뒤 delete를 다시 넣지 않는다.
- **S6:** opaque body roundtrip을 공통 계약에 추가했다. 만료·반복 complete·긴 TTL 정책은 변경하지 않았다.
- **S7:** 지원 표/등록 순서/legacy409/traffic drain/혼합 버전 금지/rollback 전제를 최종 도입 예제로 통합한다.
- **S8:** class-transformer0.5.1, 실제 HTTP 테스트(회귀 경로라 unit project에 포함), opaque payload 실제 PG/Redis 확인, Node/Nest 지원 매트릭스 검증이 필요하다.

## 다음 작업자에게

- 마지막 갱신: 2026-10-06. 작업자: Codex. 작업 위치: 현재 checkout, S1 변경은 미커밋/미게시.
- 완료 ID: S1-1~S1-7. 결정: D01. 진행 상태는 작업판을 따른다.
- S1 완료 기준에 남은 실패 없음. 실제 DB/지원 버전 매트릭스 검증은 S8의 명시적인 미완료 범위다.
- 다음 행동: 작업판에서 S2 또는 S6을 시작한다. S5 통합은 S6 계약 확정 뒤 이 완료 파이프라인 위에서 진행한다.
- S1 재개 시에는 작업 트리 diff와 이 문서의 지원 표·전환 규칙을 먼저 확인한다. 조사 당시 누출 증거는 조사 문서에 보존한다.
