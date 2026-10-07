# S3 요청 격리와 키 계약

상태·담당은 [작업판](../README.md)에서 관리한다. 조사 기준: 2026-10-06, 0.4.0, `9610774a767d152c4cbae49c6276a4f2d76463e4`. 관련 결정: [D03](../decisions.md). 선행 작업 없이 착수할 수 있다.

## 목적과 확인된 근거

다른 tenant/user/resource의 요청이 같은 저장 레코드를 사용하지 않도록 scope 합성 계약을 정한다. 기본 endpoint scope에는 identity가 없고 custom scope는 기본 endpoint scope를 대체한다. 인증 정보를 일반적으로 추론할 수 없으므로 어떤 identity를 사용할지는 서비스의 인증 결과와 연결해야 한다.

[조사 문서](../../1.0.0-stabilization-research.md)에서 다음을 재현했다.

1. README 예제처럼 `scope: ctx => ctx.switchToHttp().getRequest().user.tenantId`를 사용한다. 같은 tenant·키·body로 `/payments`, `/refunds`를 순서대로 호출하면 두 번째 handler가 실행되지 않고 payment 응답이 반환된다.
2. `POST /payments` + 키 `archive::K`와 `POST /payments::archive` + 키 `K`는 `::` 연결 결과가 같다. 인터셉터 probe에서 다른 리소스 응답이 재생됐다.

인접 프로젝트의 [사용자 간 replay 보고](https://github.com/mahendraHegde/node-idempotency/issues/35)와 [tenant별 prefix 요구](https://github.com/mahendraHegde/node-idempotency/issues/29)는 사용 맥락의 근거다. 이 패키지의 실제 사용자 피해가 확인됐다는 뜻은 아니다.

## 범위

포함: identity·method·실제 path와 키의 모호하지 않은 조합, global/custom scope의 공개 의미, query 포함 여부, 인증/서명 검증 순서, header와 custom resolver 입력 검증, 기존 레코드 전환 제약.

제외: tenancy/auth 프레임워크 구현, 인증되지 않은 header 값을 신뢰하는 자동 tenant 판별, RPC/GraphQL 지원 확대, 광범위한 fingerprint 알고리즘 교체. 기존 기본 동작을 바꿀 경우 D03에 이유와 호환성 영향을 기록한다.

## 확정 계약과 구현

[D03](../decisions.md#d03--요청-격리와-키-입력-decided)을 2026-10-07에 확정했다.

- 함수형 scope는 endpoint를 보존하고 인증 identity를 추가한다. `string | readonly string[]`를
  반환하며 `[tenantId, userId]` 구성요소의 경계가 보존된다. 기본 endpoint는 identity를 추론하지
  않고 global은 모든 endpoint/identity에서 응답을 공유한다.
- JSON tuple `[namespaceTuple, rawKey]`를 SHA-256으로 hash해
  `@nestarc/idempotency:key:v1:<hex>` 92바이트 저장 키를 만든다. 원본 key 없이 namespace만
  hash한 표현도 내부 utility가 제공하여 S4에 넘긴다. SQL schema/adapter API는 유지한다.
- method와 실제 path parameter·percent encoding·중복/끝 slash를 구분한다. query는 추적 값이나
  순서 변경 때문에 새 실행이 생기지 않도록 기존 제외 정책을 유지한다. 의미 있는 query는 서비스가
  scope 구성요소 또는 fingerprint에 포함한다.
- header는 raw opaque string이며 Structured Field parsing을 하지 않는다. quotes는 literal이다.
  반복/배열/쉼표/빈 값/공백뿐/제어문자/단독 surrogate/비문자열은400, maxKeyLength는 UTF-8
  bytes(기본255)다. resolver도 동일 검증하되 comma를 허용하고 header를 대체한다.
  undefined만 누락이며 optional이어도 invalid는 거부한다. 잘못된 maxKeyLength/scope는500이다.
- 인증·인가·webhook 서명 확인은 replay 전에 guard에서 실행한다. README는 검증된 tenant/user
  배열 예제로 교체했으며 HMAC rawBody 예제가 두 HTTP adapter에서 실행된다.
- legacy alias를 추가 조회하지 않는다. 옛 key와 새 address는 정확히 겹칠 수도 있어 **빈 물리
  namespace 분리**가 필요하고, 키 변경에 따른 과거 업무 재실행을 막는 **durable 업무 중복 방지
  또는 결과 조정**도 별도로 필요하다. old/new writer 혼합 배포는 지원하지 않는다. D03/D07/S7에
  두 전제와 rollback 제약을 전달했다. 단순 dual-read·prefix 회전·TTL 만료를 안전한 전환으로 보지 않는다.

## 회귀 테스트 표

| 바뀐 항목 / 상황 | 기대 결과 | 영구 검증 |
| --- | --- | --- |
| tenant-only scope에서 payments→refunds | 두 handler 각각 실행 | request-isolation regression |
| `/payments` + `archive::K` / `/payments::archive` + `K` | 충돌 없이 각자 응답 | request-isolation regression |
| tenant / user / method / endpoint / path parameter / key 하나 변경 | 별도 실행, 각각의 동일 재시도만 replay | regression 및 Express/Fastify E2E |
| identity의 `::`, comma, JSON 경계 / string과 배열 | 경계 보존, string과 한 원소 배열은 동등 | request-isolation regression |
| query만 변경 | 같은 작업 replay | regression 및 E2E |
| 중복·끝 slash / percent encoding 변경 | 별도 실제 path로 격리 | request-scope unit 및 regression |
| invalid key 또는 scope/config | 400 또는500, fingerprint/storage/handler 무호출 | request-key-validation regression |
| 인증 실패·권한 회수·잘못된 HMAC으로 replay 시도 | 401/403, storage/handler 무호출 | 양 adapter의 request-isolation E2E |
| distinct legacy alias만 존재 | 새 실행 가능, 옛 record 유지 | regression: 전환 시 업무 중복 방지 필요성 |
| 옛 global key가 새 address와 같고0.4 body | 409, 저장소 변경·handler 없음 | regression: prefix는 출처 증명이 아님 |
| 별도 빈 namespace에 전환, 옛 namespace에 S1 body | 과거 응답 혼입 없이 신규 실행 후 replay | regression: 지원하는 저장 공간 격리 전제 |

## 작은 작업

- [x] **S3-1** 위 두 충돌을 영구 회귀 테스트로 옮기고, tenant·user·endpoint·키가 각각 다른 경우를 분리한 테스트 표를 만든다.
- [x] **S3-2** D03에 scope와 입력 계약, key 형식, 기존 레코드 전환 전제를 기록한다.
- [x] **S3-3** 결정한 합성·인코딩을 구현한다. endpoint/global/custom 및 path parameter/query의 동작을 회귀 검증한다.
- [x] **S3-4** header/resolver 입력 검증을 추가하고, 거절할 입력은 handler 실행과 저장소 변경 전에 종료되는지 확인한다.
- [x] **S3-5** Express/Fastify에서 같은 키를 사용하는 서로 다른 인증 사용자·tenant를 검증한다. guard 또는 선행 서명 검증이 replay에서도 적용되는 예제를 확인한다.
- [x] **S3-6** 옛 키·새 키가 공존하는 상황의 제한과 검증 결과를 D07/S7에 넘기고, S4에 원본 키 없는 namespace 표현을 전달한다.

## 완료 조건

- [x] scope 구성에 포함하기로 한 tenant/user/resource가 다른 요청 사이에 응답 혼선이 없다. 같은 작업의 정상 재시도는 동일 응답을 받는다.
- [x] tenant-only 예제를 안전한 예제로 교체할 계약이 확정되어 있고 `::` 충돌 회귀가 통과한다.
- [x] 인증·인가·webhook 서명 확인을 handler 내부에만 두어 replay가 검증을 우회하는 구성을 권장하지 않는다.
- [x] 입력 거절과 400/422 등의 wire behavior가 결정과 일치한다. 기존 query 제외 동작의 유지·변경 이유가 명시되어 있다.
- [x] 저장 키 변경 시 기존 레코드와 혼합 버전 배포의 안전 조건을 문서화하고, S7의 전환 검증에 필요한 사례를 전달했다.

## 관련 파일과 검증

- [인터셉터](../../../src/idempotency.interceptor.ts)의 `resolveRawKey`, `applyScope`, `computeEndpointScope`.
- [옵션 타입](../../../src/interfaces/idempotency-options.interface.ts), [request scope utility](../../../src/utils/request-scope.ts).
- [scope utility 테스트](../../../test/utils/request-scope.spec.ts), [path 회귀](../../../test/regression/path-based-scope.spec.ts), [인터셉터 테스트](../../../test/idempotency.interceptor.spec.ts).
- [Express E2E](../../../test/e2e/idempotency.e2e-spec.ts), [Fastify E2E](../../../test/e2e/fastify.e2e-spec.ts).

저장소 루트에서 기존 관련 검사와 추가한 회귀 파일을 실행한다. HTTP E2E에는 로컬 서버 실행이 가능한 환경이 필요하다.

```sh
npm run test -- --runInBand test/utils/request-scope.spec.ts test/utils/request-key.spec.ts test/regression/path-based-scope.spec.ts test/regression/request-isolation.spec.ts test/regression/request-key-validation.spec.ts test/idempotency.interceptor.spec.ts
npm run test:e2e -- --runTestsByPath test/e2e/idempotency.e2e-spec.ts test/e2e/fastify.e2e-spec.ts test/e2e/request-isolation.e2e-spec.ts
```

## 다음 작업자에게

- 마지막 갱신: 2026-10-07. 작업자 Codex, 기존 checkout에서 구현. 기준 commit
  `e2b9cec673acea9726fddc22dcdc2167283d3ead` + S3 작업 트리이며 commit/publish하지 않았다.
- 변경: interceptor, scope 공개 타입, request-key/request-scope utilities, 기존 키 fixture,
  신규 격리/입력 regression·Express/Fastify E2E, readonly scope tarball 소비자 fixture,
  README/CHANGELOG/D03와 S2/S4/S7 인계 문서.
- 채택: D03의 endpoint 보존 합성과 JSON tuple hash. 완전 교체형 custom scope를 남겨 tenant-only
  설정이 계속 endpoint를 잃는 대안은 채택하지 않았다.
- 인계: S2 공개 타입 배열 반환; S4 key 없는 namespace와 hash/관측 한계; S7/D07 빈 물리 namespace와
  업무 중복 방지, 인증 guard/raw header 프로파일; S8 최종 지원 버전·출시 artifact 검증.
- 다음 행동: S4가 `createRequestKey().namespace`를 event/log 계약과 연결한다. D07은 S5/S6 완료 후
  전환 운영 절차 전체를 확정한다. S3에서 실제 운영 migration을 수행한 것은 아니다.

## 검증 증거 — 2026-10-07

검증 요약·명령·source hash·tarball checksum은 [보존 JSON](../evidence/S3-validation.json)에 기록했다. HTTP listener와 실제 DB 검사는 sandbox 밖에서 승인된 로컬
실행으로 수행하며, 초기 sandbox의 EPERM을 제품 테스트 실패와 구분한다.

| 대상 / 명령 | 결과 | 증거와 제한 |
| --- | --- | --- |
| 수정 전 tenant-only 및 `::` 충돌 2건 | 2 fail | 각각 refund/archive에서 payment 응답을 replay함. 변경 전 회귀 실행으로 확인 |
| 수정 전 입력 회귀 초기163건 | 36 pass / 127 fail | `/private/tmp/s3-request-key-validation-red.log` |
| 격리·입력·키 형식·path 관련4 suite | **203 pass / 0 fail / 0 skip** | `/private/tmp/s3-regressions.log` |
| 새 Express/Fastify 인증·서명·입력 E2E | **58 pass** | 전체 테스트에도 포함, guard 거절 시 storage 무호출 확인 |
| `npm run test:all -- --runInBand` + 실제 테스트 Redis/PG | **30 suite / 605 pass / 0 fail / 0 skip** | `/private/tmp/s3-test-all.log` |
| `npm run lint` / 개발 `tsc --noEmit` / `npm run build` | 모두 성공 | `/private/tmp/s3-lint.log`, `s3-typecheck.log`, `s3-build.log` |
| `npm run test:consumers` + 실제 테스트 Redis/PG | **41 pass / 기대된 실패3 / 0 skip** | readonly scope tuple이 node/node16/nodenext 모두 compile. PG 타입 미설치3건은 기대된 실패이며 설치 후 모두 성공 |

- 환경: macOS arm64, Node24.11.1/npm11.6.2, Nest common/core/Express11.1.18,
  Fastify adapter11.1.19, 개발 TypeScript5.9.3, 소비자 TypeScript5.7.3,
  Redis7.2.7/PostgreSQL16.14. fresh test-only 서비스로 검증했다.
- 소비자 artifact: `/private/tmp/idempotency-consumers-qWBJwU/nestarc-idempotency-0.4.0.tgz`.
  SHA-256: `6bdd65b058e3bf5df7484b707c7fa03b66194dd18f56c1d6c291ecf718678ffd`.
  같은 디렉터리에 summary, 각 명령 로그, lockfile과 설치 트리가 남아 있다.
- 제한: 전체 지원 Node/Nest matrix 및 최종 release artifact는 S8에서 다시 검증한다. S3는 실제 운영
  배포/데이터 migration을 수행하지 않았다. S4/S5/S6 작업은 남아 있으며 S3 완료로 대체되지 않는다.

이번 검증에서 직접 실행한 Redis/PG는 정상 종료했고 데이터·로그·artifact는 보존했다.
