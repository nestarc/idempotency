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

## 구현 전 결정

- identity를 기존 scope 함수에서 완전히 구성할지, endpoint를 보존하는 합성 수단을 추가할지 결정한다. 새 옵션명은 아직 정하지 않았다.
- key 구성요소를 어떻게 인코딩하고 버전을 구분할지 결정한다. 구분자 변경만으로 충돌 방지를 주장하지 않는다.
- header의 raw/structured string 처리, 빈 값·반복 헤더·비문자열 resolver 결과, maxKeyLength의 단위와 유효 설정값을 정한다. 현재 동작과 draft 프로파일의 차이는 S7에 전달한다.
- 레거시 레코드의 권한 범위를 증명할 수 있는지 확인한다. 증명되지 않는 레코드의 호환 읽기를 기본값으로 삼지 않으며, 키 변경 때문에 기존 업무가 재실행되는 위험도 함께 다룬다.

## 작은 작업

- [ ] **S3-1** 위 두 충돌을 영구 회귀 테스트로 옮기고, tenant·user·endpoint·키가 각각 다른 경우를 분리한 테스트 표를 만든다.
- [ ] **S3-2** D03에 scope와 입력 계약, key 형식, 기존 레코드 전환 전제를 기록한다.
- [ ] **S3-3** 결정한 합성·인코딩을 구현한다. endpoint/global/custom 및 path parameter/query의 동작을 회귀 검증한다.
- [ ] **S3-4** header/resolver 입력 검증을 추가하고, 거절할 입력은 handler 실행과 저장소 변경 전에 종료되는지 확인한다.
- [ ] **S3-5** Express/Fastify에서 같은 키를 사용하는 서로 다른 인증 사용자·tenant를 검증한다. guard 또는 선행 서명 검증이 replay에서도 적용되는 예제를 확인한다.
- [ ] **S3-6** 옛 키·새 키가 공존하는 상황의 제한과 검증 결과를 D07/S7에 넘기고, S4에 원본 키 없는 namespace 표현을 전달한다.

## 완료 조건

- [ ] scope 구성에 포함하기로 한 tenant/user/resource가 다른 요청 사이에 응답 혼선이 없다. 같은 작업의 정상 재시도는 동일 응답을 받는다.
- [ ] tenant-only 예제를 안전한 예제로 교체할 계약이 확정되어 있고 `::` 충돌 회귀가 통과한다.
- [ ] 인증·인가·webhook 서명 확인을 handler 내부에만 두어 replay가 검증을 우회하는 구성을 권장하지 않는다.
- [ ] 입력 거절과 400/422 등의 wire behavior가 결정과 일치한다. 기존 query 제외 동작의 유지·변경 이유가 명시되어 있다.
- [ ] 저장 키 변경 시 기존 레코드와 혼합 버전 배포의 안전 조건을 문서화하고, S7의 전환 검증에 필요한 사례를 전달했다.

## 관련 파일과 검증

- [인터셉터](../../../src/idempotency.interceptor.ts)의 `resolveRawKey`, `applyScope`, `computeEndpointScope`.
- [옵션 타입](../../../src/interfaces/idempotency-options.interface.ts), [request scope utility](../../../src/utils/request-scope.ts).
- [scope utility 테스트](../../../test/utils/request-scope.spec.ts), [path 회귀](../../../test/regression/path-based-scope.spec.ts), [인터셉터 테스트](../../../test/idempotency.interceptor.spec.ts).
- [Express E2E](../../../test/e2e/idempotency.e2e-spec.ts), [Fastify E2E](../../../test/e2e/fastify.e2e-spec.ts).

저장소 루트에서 기존 관련 검사와 추가한 회귀 파일을 실행한다. HTTP E2E에는 로컬 서버 실행이 가능한 환경이 필요하다.

```sh
npm run test -- --runInBand test/utils/request-scope.spec.ts test/regression/path-based-scope.spec.ts test/idempotency.interceptor.spec.ts
npm run test:e2e -- --runTestsByPath test/e2e/idempotency.e2e-spec.ts test/e2e/fastify.e2e-spec.ts
```

## 다음 작업자에게

- 마지막 갱신: 2026-10-06. 구현 미착수, 변경 코드·검증 commit 없음.
- 다음 행동: 기존 tenant-only 설정과 두 `::` 조합을 `test/regression/`의 독립 사례로 작성한다.
- 미결: D03 전체. key migration을 무조건 dual-read나 일괄 삭제로 해결하지 않는다.
- 인계 대상: S2의 공개 타입·export, S4의 namespace, S7/D07의 업그레이드·인증 예제.
- 검증 기록: 아직 없음. 실행 시 대상 commit/artifact, 환경, 명령, pass/fail/skip, 증거와 남은 제한을 기록한다.
