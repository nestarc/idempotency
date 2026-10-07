# S7 실행 가능한 도입 예제와 전환 문서

상태·담당은 [작업판](../README.md)에서 관리한다. 조사 기준: 2026-10-06, 0.4.0, `9610774a767d152c4cbae49c6276a4f2d76463e4`. 관련 결정: [D07](../decisions.md), 선행 계약 D01~D06. DI 예제 재현은 바로 시작하고 최종 문서 완료는 S1~S6 통합 후 판단한다.

## 목적과 근거

README를 복사한 Nest 앱이 설치·부팅·정상 재시도·종료까지 동작하게 한다. 결제·주문·webhook 사용자가 키, TTL, 사용자 범위와 실패 후 행동을 선택할 수 있도록 설명한다.

조사에서 PostgresSweepService 예제를 그대로 구성한 TestModule의 compile이 실패했다. 서비스는 PostgresStorage 클래스 토큰을 요구하지만 IdempotencyModule은 IDEMPOTENCY_STORAGE만 등록한다. 관측 예제의 `new PostgresStorage(pool)`도 실제 `{ pool }` 생성자 계약과 다르다. README의 tenant-only scope, invalid TTL=400 설명, 키당 무조건 at-most-once, Redis durability 표현, 0.4 진행 중 표기도 정리가 필요하다.

## 범위

포함: 필요할 경우 sweep의 DI 연결 수정, 실행 가능한 소비 예제와 smoke test, sync/async 모듈 등록·외부 연결 소유권, S1~S6 공개 계약을 반영한 README/CONTRIBUTING/CHANGELOG와 전환 안내.

제외: 새 transactional API, ORM 어댑터, 범용 webhook 프레임워크, 클라이언트 retry 엔진. 기존 결함의 예제·연결 수정과 운영 계약을 다루는 작업이다.

## 작은 작업

- [ ] **S7-1** README sweep 구성을 그대로 TestModule에 옮겨 DI 실패를 재현한다. fixture가 연결의 소유권과 close 동작을 확인하도록 한다.
- [ ] **S7-2** provider alias, 주입 token 또는 공식 wiring 방법 중 기존 API 영향을 검토해 수정하고, 실제 PG에서 만료 row 정리까지 확인한다. 새 Pool을 불필요하게 만드는 예제로 해결하지 않는다.
- [ ] **S7-3** 모든 공식 예제의 생성자·import·공개 타입·forRootAsync wiring을 S2와 맞추고 compile/init/close 검사 대상으로 만든다.
- [ ] **S7-4** 결제/주문 recipe를 작성한다. client command ID, 동일 의도의 재시도, 의미 있는 payload 변경, tenant/user 격리와 serializer 순서를 연결한다. 422를 무조건 새 키 생성으로 회피하도록 안내하지 않는다.
- [ ] **S7-5** webhook recipe를 작성한다. replay 전에 인증·서명 검증을 수행하는 구성을 사용하고, event ID 중복·업무 중복·순서 뒤바뀜을 구분한다. provider 재전송 기간과 inbox/업무 unique constraint의 보존기간을 설명한다.
- [ ] **S7-6** 상태별 client 행동 표를 만든다. missing/invalid key, 409, 422, handler 오류, complete 오류, TTL 만료, 결과 불명 각각의 동작을 S3/S5 계약과 일치시킨다.
- [ ] **S7-7** D07에 기존 key/fingerprint/schema/옵션 변경의 업그레이드·혼합 버전·롤백 조건을 기록하고 실행 가능한 전환 안내를 작성한다.
- [ ] **S7-8** README의 보장 범위·지원 표·draft 프로파일·roadmap과 CONTRIBUTING의 실제 DB/배포 설명을 확정 구현에 맞춰 갱신한다. 과거 handover와 충돌하는 내용은 새 문서를 가리키게 정리한다.

## 운영과 전환에서 결정할 사항

- webhook TTL을 전역 30일로 바꾸는 작업이 아니다. [Stripe 재전송 정책](https://docs.stripe.com/webhooks#event-delivery-behaviors)과 사용자 서비스의 보존기간을 근거로 선택하게 한다. 게시 전 정책 날짜를 다시 확인한다.
- scope 변경 시 legacy 레코드의 권한 범위를 증명할 수 없다면 무조건 호환 읽기를 제공하지 않는다. 기존 키 일괄 삭제도 업무 재실행을 허용할 수 있다. S3와 함께 사용 가능한 전환 전제, 불가능한 조합과 운영 조치를 정한다.
- [기존 SQL](../../../sql/init.sql)과 0.2→0.3 response_headers migration을 확인한다. 실제 schema 변경이 없다면 없는 migration을 만들지 않는다. 변경이 필요하다면 기존 데이터·롤링 배포·롤백의 검증을 S6와 함께 작성한다.
- 처리 중 잠금 만료와 업무 DB commit 여부는 별개다. 결과 불명일 때 업무 결과 조회·조정이 필요한 조건을 설명하고, 강제 unlock을 일반 해결책으로 제시하지 않는다.
- draft의 모든 조항을 새로 구현하는 작업이 아니다. S3 입력 처리와 실제 지원 프로파일의 차이를 정확히 설명한다.

## 완료 조건

- [ ] 공식 quickstart·async 등록·Redis/PG·sweep·관측·tenant 예제가 공식 import 경로로 compile/init/close된다.
- [ ] sweep 예제는 실제 PG의 만료 row 제거와 외부 Pool 소유권을 검증했다. mock 또는 skip만으로 완료 처리하지 않는다.
- [ ] 결제/주문/webhook recipe가 S1의 지원 응답, S3의 인증 경계, S5의 오류 계약과 모순되지 않는다.
- [ ] 400/409/422와 업무·저장소 오류 후 행동, 처리 lease와 replay TTL의 차이가 명시되어 있다.
- [ ] D07에 key/fingerprint/schema/API별 변경 유무와 전환 조건, 미지원 롤백 조합이 기록되어 있다.
- [ ] 문서에서 보장하지 않는 exactly-once, 무조건 durability, 지원하지 않는 스트림 replay를 약속하지 않는다.

## 관련 파일과 검증

- [README](../../../README.md), [CONTRIBUTING](../../../CONTRIBUTING.md), [CHANGELOG](../../../CHANGELOG.md), [기존 handover](../../handover.md).
- [모듈](../../../src/idempotency.module.ts), [PostgresSweepService](../../../src/services/postgres-sweep.service.ts), [PostgresStorage](../../../src/storage/postgres.storage.ts).
- [모듈 테스트](../../../test/idempotency.module.spec.ts), [sweep 테스트](../../../test/services/postgres-sweep.service.spec.ts), [PG lifecycle 테스트](../../../test/storage/postgres.storage.lifecycle.spec.ts).

저장소 루트에서 실행한다. 실제 PG 검사에는 테스트 전용 TEST_DATABASE_URL을 설정한다. 신규 예제 fixture의 실행 명령은 구현 시 이 문서에 추가한다.

```sh
npm run test -- --runInBand test/idempotency.module.spec.ts test/services/postgres-sweep.service.spec.ts test/storage/postgres.storage.lifecycle.spec.ts
npx tsc --noEmit --incremental false -p tsconfig.json
npm run build
```

## 다음 작업자에게

### S3 / D07 전환 인수인계 (2026-10-07)

[D03](../decisions.md#d03--요청-격리와-키-입력-decided)이 확정됐다. 함수형 scope는
`string | readonly string[]` identity를 method + 실제 path에 **추가**한다. tenant/user는
배열로 경계를 보존하고 guard에서 검증된 값을 사용한다. 기본 endpoint는 identity를 추론하지 않는다.
global은 저장소 전체 응답 공유이며 여러 인증 주체를 자동 격리하지 않는다.
실제 path의 중복/끝 slash와 percent encoding은 보존하며 query 제외는 유지한다.

header는 raw string 프로파일이다. Structured Field 파싱을 하지 않으므로 인용부호는 literal이고,
반복/배열/쉼표/빈 값/공백뿐/제어문자/단독 surrogate는400이다. resolver는 header를 대체하고
쉼표만 예외적으로 허용한다. required:false도 invalid는400, undefined만 bypass한다.
maxKeyLength는 UTF-8 bytes(기본255), 양의 safe integer이며 잘못된 설정은500이다.
README scope/key/webhook 및 CHANGELOG를 갱신했고 양 adapter에서 guard와 rawBody HMAC 검증을
실행했다. 전체 도입 recipe와 provider별 서명 구현은 S7에서 완성한다.

D07이 포함할 필수 전환 사례:

| 사례 | S3에서 확인한 결과 / S7 행동 |
| --- | --- |
| 옛 endpoint/custom/global alias만 존재 | 새 key는 alias를 조회하지 않아 handler가 다시 실행된다. durable 업무 ID 중복 방지 또는 결과 조정 필수 |
| 옛 global raw key가 새 v1 address와 정확히 같음 | prefix는 출처 증명이 아니다. 0.4 body면409지만 S1-compatible body면 재생될 수 있음. 같은 저장 namespace의 구/신 key 공존 미지원 |
| 별도의 빈 저장 namespace로 전환 | 옛 응답 혼입을 차단한다. 새 MemoryStorage, 검증된 빈 Redis keyPrefix, 새 PG tableName/별도 DB 사용. Redis prefix가 옛 prefix의 하위라는 이유만으로 격리를 가정하지 않음 |
| old/new writer 동시 동작 | 서로 다른 잠금으로 같은 업무 재실행 가능. rolling 배포 미지원, 트래픽 중단과 전체 교체 필요 |
| 처리 결과 불명 / 배포 후 rollback | 업무 결과를 확인하고 양 버전에서 처리한 command ID를 중복 실행하지 못하게 해야 함. TTL 만료나 prefix 회전만으로 해결하지 않음 |

namespace 분리와 업무 중복 방지는 별도의 필수 조건이다. traffic pause→drain/업무 결과 확인→
업무 중복 방지→빈 namespace 확인→전체 교체→재개 순서를 포함한다. 조건을 충족할 수 없으면
기존 재전송을 차단하고 불명 업무를 해소할 때까지 전환하지 않는다. D01 body 전환 조건도 적용한다.
키가 바뀌지만 SQL schema/adapter 계약 변경은 없다. D07 전체 상태는 S5/S6 인계까지 OPEN으로 유지한다.


### S2 인수인계 (2026-10-06)

[D02](../decisions.md#d02--선택-의존성과-공개-import-경계-decided)는 확정됐다. root는 Memory/common만 제공한다.
기존 root의 RedisStorage/RedisStorageOptions는 `@nestarc/idempotency/redis`,
PostgresStorage/PostgresStorageOptions/PostgresSweepService/SweepOptions는 `@nestarc/idempotency/postgres`로 옮긴다.
Memory 소비자는 pg/ioredis/@types/pg를 설치하지 않으며, Redis는 ioredis만, PG TypeScript 소비자는 pg와 개발 의존성 @types/pg를 설치한다.
공식 SQL 경로는 `@nestarc/idempotency/sql/init.sql`이고 dist 내부 경로는 export하지 않는다.
key/fingerprint resolver·input과 event/outcome/observability options 타입은 root에서 공개된다.

최소 검증 TS는5.7.3, strict/skipLibCheck:false, CJS 소비자의 node/node16/nodenext다.
초기5.4.5는 현재 pg-protocol/@types/node의 generic Buffer 선언 충돌로 실패했으므로 낮은 하한을 약속하지 않는다.
README 설치·import·생성자 오기 및 CHANGELOG를 갱신했지만 sweep DI·수명주기 예제 완성은 S7에 남긴다.
[소비자 fixture](../../../test/consumers/README.md)는 실제 tarball의 공개 경로·공개 타입·Nest init/close와 실제 DB smoke를 제공한다.
이 결과가 README의 모든 recipe 또는 sweep DI 검증을 뜻하지 않는다. 키/schema 변경은 S2에 없으며 S1 데이터 전환 규칙은 별개다.


### S1 인수인계 (2026-10-06)

D01은 확정됐다. [S1 지원 표·전환 절차](S1-response-replay.md)와 README의 새 response contract를
최종 recipe에 반영한다. idempotency는 serializer보다 먼저 등록하며 plain JSON만 저장한다.
미지원 결과는 lease 동안409, 수동 응답은 사전 configuration error, SSE는 error event 후 종료다.
legacy/corrupt COMPLETED도409이며 새 body는 opaque string이다. 키/schema는 S1에서 변경하지 않았다.
구/신 reader·writer 혼합 배포/롤백을 지원하지 않으며 traffic pause→drain→전체 교체가 필요하다.
기존 키 삭제·자동 회전으로409를 피하도록 안내하지 않는다. S3의 향후 키 전환과 함께 D07을 마무리한다.

- 마지막 갱신: 2026-10-06. S7 자체 구현·예제 검증 미착수. S1·S2의 README/CHANGELOG 계약 갱신은 위 인계 참조.
- 다음 행동: README sweep 블록을 소비자 TestModule로 재현하고 필요한 provider와 실제 소유한 Pool이 같은지 확인한다.
- 미결: D07 및 선행 D04~D06. D01·D02·D03은 확정됐다. 상태별 동작이나 마이그레이션은 미확정 API를 예제로 먼저 고정하지 않는다.
- 인계 대상: S8에 실행 예제 목록, 공식 import/지원 구성, 업그레이드·롤백 테스트와 남은 제한을 전달한다.
- 검증 기록: 대상 commit/artifact, 환경, 명령, pass/fail/skip, 증거와 남은 제한을 실행 후 기록한다.
