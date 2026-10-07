# 1.0.0 계약과 설계 결정 기록

[작업판으로 돌아가기](README.md)

조사 기준: 2026-10-06, 0.4.0, `9610774a767d152c4cbae49c6276a4f2d76463e4`. D01~D06을 결정했다. D06은 긴 TTL·직접 입력 정책까지 포함하며, D07·D08은 미결이다. 재현된 사실은 [조사 문서](../1.0.0-stabilization-research.md), 진행 상태는 작업판을 기준으로 한다.

## 기록 방법

결정 상태는 `OPEN`, `DECIDED`, `SUPERSEDED`를 사용한다. 근거·검증 방법·호환성 영향을 정리해 `DECIDED`로 바꾼 뒤 관련 구현에 반영한다. 결정 기록은 추가 승인 절차를 뜻하지 않는다. 선택한 설계의 이유를 다음 작업자가 이해할 수 있게 하는 문서다.

각 결정에 날짜, 결정자, 선택한 계약, 대안과 선택 이유, 공개 API/키/schema/운영 영향, 회귀 테스트, 후속 작업을 기록한다. 결정을 바꿀 때는 이전 이유를 지우지 말고 대체한 결정과 변경 사유를 남긴다. 태스크 체크박스 완료만으로 결정 상태를 자동 변경하지 않는다.

## 결정 목록

| ID | 상태 | 담당 작업 | 결정할 계약 | 반드시 검토할 영향 |
| --- | --- | --- | --- | --- |
| D01 | DECIDED | S1 | 최외곽 idempotency에서 최종 plain JSON 저장, 마지막 정상 emission, 버전 표식, 미지원 lease 유지/사전 거부 | 자세한 계약과 전환 조건은 아래 D01 및 S1 문서 |
| D02 | DECIDED | S2 | Memory/common root, Redis·PG 공식 subpath 분리; PG 타입은 소비자가 설치 | 0.4 root DB import를 /redis·/postgres로 이동; TS5.7.3 CJS node/node16/nodenext |
| D03 | DECIDED | S3 | 함수형 scope의 identity + endpoint 합성, JSON tuple SHA-256 key v1, raw string/UTF-8 입력 계약 | 기존 키 재사용·혼합 배포 불가; 아래 D03의 업무 중복 방지 전환 전제 필수 |
| D04 | DECIDED | S4 | raw key와 독립된 namespace, encoded key의 SHA-256, 고정 오류 분류와 안전 로그 | event.scope 제거, 원본 Error 필드 제거; callback 격리 및 현재 오류 경로는 아래 D04, S5/S6 통합 재검증 필요 |
| D05 | DECIDED | S5 | handler 실패·저장소 실패·취소·결과 불명 시 레코드와 클라이언트 동작 | 동기 throw/rejection 일치, 기록 성공 후 응답 유실, 취소 후 업무 성공, 잠금 삭제와 중복 실행 |
| D06 | DECIDED | S6 | 만료·token·반복 complete, TTL 1~2,147,483,647초·직접 호출 선행 검증 | Memory/Redis/PG 동일 동작, custom adapter 검증·긴 TTL 지원, schema 변경 없음 |
| D07 | OPEN | S7 | 기존 저장 레코드·키·schema를 사용하는 서비스의 전환과 복구 절차 | 이전 tenant/user 권한 검증, 중복 실행, 롤링 배포·롤백, webhook 보존기간과 업무 DB 확인 |
| D08 | OPEN | S8 | 지원 Node/Nest/HTTP adapter 조합과 artifact 검증·게시 경로 | Node 20 유지 여부, 22/24 검증, 실DB skip 차단, 동일 artifact 검증, RC 증거 |

## 먼저 지켜야 할 경계

- 보안·정확성 결함을 해결해야 한다는 목표와 특정 구현안을 구분한다. 예를 들어 namespace 옵션 추가나 subpath 분리는 후보이지 확정 API가 아니다.
- D01의 미지원 유형은 “캐시하지 않는다”로 끝내지 않는다. handler 실행 여부, HTTP 응답 종료, 저장 상태와 후속 재시도 결과를 함께 결정한다.
- D03/D07에서 legacy key 호환 읽기를 자동 채택하지 않는다. 옛 레코드에 tenant/user의 권한 범위를 증명할 정보가 없으면 호환 조회가 새 격리를 우회할 수 있다. 반대로 키 초기화·일괄 삭제도 동일 작업 재실행을 유발할 수 있다. 전환 전제를 명시하고 검증한다.
- D05에서 timeout·구독 취소를 업무 실패로 단정하지 않는다. 무조건 delete나 강제 unlock을 기본 복구로 선택하지 않는다. 외부 결제/업무 DB와 이 저장소의 원자성 한계를 유지한다.
- D06은 adapter 간 차이를 없애는 계약 결정이다. SQL 검토만으로 실제 Postgres 검증을 완료했다고 기록하지 않는다.
- D08의 필수 검사가 skip됐다면 환경을 복구하거나 미완료 상태를 유지한다. pack dry-run과 작업공간 타입 검사는 실제 tarball 소비자 검증을 대체하지 않는다.

## 결정 상세 기록 양식

아래 양식을 복사해 결정 ID별 기록을 추가한다.

```text
결정 ID / 상태:
날짜 / 결정자:
관련 작업과 근거 commit:
결정한 계약:
검토한 대안과 채택 이유:
공개 API·저장 키·schema·오류·운영 영향:
기존 사용자 전환과 롤백 조건:
검증할 회귀 시나리오와 실제 검증 결과:
후속 작업 / 대체한 결정:
```

## D01 — 응답 재생 경계 (DECIDED)

S1 당시의 키 유지·같은 저장소 전환 기록은 이후 D03의 키 변경으로 대체된다. 최종 업그레이드에는
D01 body 계약과 D03의 별도 빈 namespace·업무 중복 방지 조건을 함께 적용한다.

- 날짜/결정자: 2026-10-06, Codex. 사용자 S1 구현 요청 범위에서 결정.
- 기준: `9610774`, Nest 11.1.18 실제 HTTP 재현, `class-transformer@0.5.1`.
- 계약: idempotency가 응답 변환 interceptor의 바깥쪽이어야 한다. 등록 순서는 `IdempotencyInterceptor` 다음 `ClassSerializerInterceptor`. 처음에는 직렬화가 먼저 끝나고, replay에서는 안쪽 변환을 재실행하지 않는다. 전역 serializer 바깥에 메서드 idempotency를 두는 구성은 지원하지 않는다.
- 저장 값: 유한 숫자·문자열·불리언·null·일반 배열·재귀적인 plain/null-prototype 객체만 지원한다. root undefined는 빈 응답으로 구분한다. 클래스, Date, binary, stream, 접근자·toJSON, 순환, nested undefined 등은 저장하지 않는다. 객체를 다시 직렬화해 클래스 메타데이터를 복구하거나 임의의 바깥 변환을 추측하지 않는다.
- 완료: 일반 HTTP Observable의 정상 complete 후 마지막 값만 한 번 저장한다. EMPTY는 undefined 성공, error 전의 emission은 폐기한다. 취소 때 완료/삭제하지 않으며 기존 lease가 유지된다. 실패/취소 전체 정책은 S5 담당.
- 실행 후 미지원: 원래 값을 Nest에 전달하고 `bypassed`로 기록한다. PROCESSING을 삭제하지 않아 lease 동안 같은 키는409다. lease 만료 후의 재실행, adapter가 해당 값을 HTTP로 보낼 수 없는 경우까지 성공 응답을 보장하지 않는다.
- 실행 전 미지원: `@Res()`/`@Next()` without passthrough, `@Render()`, `@Redirect()`, SSE, non-HTTP는 handler·storage 실행을 거부한다. 일반 HTTP는500 configuration error. SSE는 Nest가 먼저 헤더를 쓰므로200 error event 후 종료할 수 있다. passthrough는 상태·헤더 설정 후 JSON 반환만 지원하며 이미 send한 응답은 lease 유지로 우회한다.
- 형식: responseBody는 `@nestarc/idempotency:replay:v1:`로 시작하는 opaque string이며 뒤에 kind=json/value 또는 kind=undefined envelope를 둔다. JSON 문법상 시작할 수 없는 prefix를 사용해 기존 응답 JSON의 marker 충돌을 피한다. 키·상태·DB schema·공개 함수 시그니처는 유지한다. custom adapter는 body를 해석하지 않고 그대로 저장해야 한다.
- 이전 데이터: legacy·형식 불명·손상 COMPLETED는 상태/헤더/본문을 재생하지 않고409, handler 재실행/레코드 삭제 없음. fingerprint mismatch422가 우선한다. 구버전 reader는 새 형식을 읽을 수 없으므로 old/new writer 혼합 롤링 배포를 지원하지 않는다. 트래픽 중단·in-flight 종료 후 전 노드 전환하고 기존 키를 보존한다. 롤백도 트래픽을 멈추고 새 레코드가 사라지거나 업무 확인을 완료한 뒤 수행한다. 단순 삭제·key prefix 교체는 중복 실행 위험 때문에 전환 절차로 채택하지 않는다.
- 대안: 인터셉터 안에서 class-transformer를 다시 호출하면 type/Transform 중복 및 다른 변환 누락이 생긴다. 바이너리 전체 저장이나 adapter patch는 S1보다 넓다. bypass/delete는 이미 성공한 작업의 즉시 재실행을 허용한다. legacy 호환 replay는 제외된 필드가 다시 나타날 수 있다.
- 검증: S1 문서의 실행 결과를 단일 근거로 갱신한다. 지원 Nest/Node 전체 버전 매트릭스와 실제 DB 검증은 S8에서 추가한다.
- 후속: S4 신규 bypass/conflict 관측 경로, S5 완료 뒤 capture 경계, S6 opaque body 계약, S7 배포·복구 절차, S8 adapter/serializer/devDependency 매트릭스.

## D02 — 선택 의존성과 공개 import 경계 (DECIDED)

- 날짜/결정자: 2026-10-06, Codex. 사용자 S2 구현 요청 범위에서 결정.
- 기준: 조사 `9610774`, 구현 전 재현 tarball은 S1 완료 commit `c5dff136404a135396957258204af8466744f971`에서 생성했다.
- 계약: 루트에는 MemoryStorage·module/interceptor/decorator·공통 token/타입만 공개한다. RedisStorage/RedisStorageOptions는 `@nestarc/idempotency/redis`, PostgresStorage/PostgresStorageOptions/PostgresSweepService/SweepOptions는 `@nestarc/idempotency/postgres`에서 공개한다. `sql/init.sql`, `package.json`도 공식 subpath다. 내부 `dist/*`와 storage barrel은 공식 API가 아니다.
- 타입: key/fingerprint resolver·입력과 observability options/event/outcome을 루트에서 export한다. Memory 소비자는 pg/ioredis/@types/pg가 필요 없다. Redis 소비자는 ioredis만, PG TypeScript 소비자는 pg와 개발 의존성 @types/pg를 명시적으로 설치한다. @types/pg는 optional peer로 표시한다. 공개 adapter 옵션은 원래 드라이버의 Pool/PoolConfig, Redis/RedisOptions 타입을 유지한다.
- 런타임: 모듈 import만으로 선택 드라이버를 require하지 않는다. 내부 연결 생성 시 드라이버 누락을 설치 명령이 포함된 오류로 보고한다. PostgreSQL 오류 분류는 실제 DatabaseError의 22P02만 stale로 다루는 기존 계약을 유지하고 해당 오류 경로에서 pg를 지연 조회한다. 의존성 내부 손상은 드라이버 누락 메시지로 덮지 않는다.
- 컴파일 범위: TypeScript 최소 5.7.3, strict/skipLibCheck:false, CJS 소비자의 node/CommonJS, node16/Node16, nodenext/NodeNext를 검사한다. exports의 types와 legacy node용 typesVersions를 함께 제공한다. ESM 배포, bundler resolution, 이외 TypeScript 버전 전체 지원을 검증했다고 주장하지 않는다. Node/Nest 전체 matrix는 D08에서 확정한다.
- 컴파일 하한 근거: 초기 TS5.4.5 검사에서 pg-protocol1.16.1의 generic Buffer 선언과 @types/node20.19.39의 TS<=5.6 경로가 충돌해 TS2315가 발생했다. 같은 격리 PG 소비자가 TS5.7.3에서 통과했다. 전이 의존성 override로 현재 소비자 문제를 숨기지 않고 대표 드라이버 버전과 함께 검증 가능한 하한5.7.3을 채택했다. 이전5.4.5 실패 로그도 보존한다.
- 대안: root DB export 유지+lazy require만으로는 선언 파일의 pg/ioredis 참조가 남는다. 모든 DB 타입을 필수 dependency로 제공하면 Memory 최소 설치 계약과 충돌한다. 자체 구조적 client 타입으로 바꾸면 Pool/Redis 호환·기능 범위를 새로 관리해야 한다. subpath 분리는 기존 adapter 타입을 그대로 유지하면서 선택 의존성 경계를 명확하게 하므로 채택했다.
- 호환성: 0.4의 root DB import 및 내부 경로 사용자는 새 subpath로 소스를 변경해야 한다. Memory·공통 API의 root 경로는 유지한다. 키/schema/저장 형식/어댑터 처리 정책은 S2에서 변경하지 않는다. S1 데이터 전환 규칙은 별도로 적용한다. root DB 재export shim은 타입 의존성 누출을 다시 만들므로 제공하지 않는다.
- 검증: 실제 tarball의 격리 Memory/Redis/PG fixture, PG 타입 미설치 음성 검사, 선택 driver 누락 검사, 공개 타입 컴파일, Nest 생성/init/close, 실제 DB create/get/complete/delete 및 포장 파일 검사를 S2 기록에 남긴다. adapter 동작 계약은 변경하지 않았으므로 공통 storage 계약은 유지하고 기존 전체 suite로 검증한다.
- 후속: S7은 import/설치 전환과 예제를 이 결정에 맞추며 sweep DI 문제를 별도로 마무리한다. S8은 같은 fixture와 검증한 tarball·checksum을 재사용하고 최종 matrix 및 artifact 게시 연결을 구현한다.

## D03 — 요청 격리와 키 입력 (DECIDED)

- 날짜/결정자: 2026-10-07, Codex. 사용자 S3 구현 요청 범위에서 결정. 기준 `e2b9cec673acea9726fddc22dcdc2167283d3ead`.
- scope: 기본 `endpoint`는 method와 실제 path를 포함하며 identity를 추론하지 않는다. 함수형 scope는 인증된 identity를 반환하고 **항상 endpoint에 추가**한다. 기존 string 반환은 한 구성요소이며, 새 `readonly string[]` 반환으로 tenant/user 등의 경계를 보존한다. 빈 문자열·공백뿐인 값·빈 배열·비문자열 구성요소·비동기 반환은 configuration error다. `global`은 명시적으로 identity·endpoint를 제외한 저장소 전체 공유다. 인증 주체가 여럿인 서비스에서 사용하지 않는다.
- 대안: 완전 교체형 custom scope를 유지하고 별도 옵션을 추가하면 기존 tenant-only 예제가 계속 endpoint를 누락한다. 1.0에서는 함수 의미를 합성으로 바꾸어 이 원인을 제거한다. endpoint 제거가 꼭 필요한 서비스는 global의 공유 권한 전제를 직접 입증해야 한다.
- endpoint: Express `originalUrl`, Fastify `url`의 실제 path를 사용한다. method는 대문자이며 path parameter, percent encoding, 중복/끝 slash를 그대로 구분한다. 라우터가 다른 리소스로 처리할 수 있는 slash를 임의로 합치지 않는다. query는 기존대로 제외한다. 순서·추적 파라미터 변화가 중복 실행을 만들지 않도록 유지하며, 의미 있는 query는 scope 배열에 선택한 값을 안정된 순서로 추가하거나 fingerprint에 넣어422로 구분한다. 실제 URL이 없는 custom context만 metadata path, 마지막으로 class/handler 이름에 fallback한다. fallback은 실제 HTTP path의 격리를 대신하지 못한다.
- 키: namespace tuple은 `['global']` 또는 `['endpoint', identityParts, locationParts]`. location은 `['path', METHOD, actualPath]`, `['route', METHOD, metadataPath]`, `['handler', METHOD, className, handlerName]` 중 하나다. 저장 key는 `@nestarc/idempotency:key:v1:` + `SHA256(UTF8(JSON.stringify([namespaceTuple, rawKey])))`의 소문자 hex다. 문자열 구분자 연결이 아닌 JSON 배열 인코딩이 구성요소 경계를 보존하며, 고정 길이 hash는 긴 URL로 인한 저장소 index 길이 문제도 피한다. hash의 암호학적 충돌 한계는 남는다. SQL schema와 adapter 계약은 바꾸지 않는다.
- 원본 키 없는 namespace: 내부 `createRequestKey()`가 별도로 `@nestarc/idempotency:namespace:v1:` + `SHA256(JSON.stringify(namespaceTuple))`를 반환한다. hash는 암호화가 아니며 저엔트로피 identity 추측이나 cardinality 문제를 해결하지 않는다. S3 시점 fingerprint input.scope와 event.scope는 새 저장 key를 받았다. 아래 D04에서 event.scope를 제거하고 event.namespace로 연결한다. fingerprint input.scope 계약은 별개로 유지한다.
- 입력: header는 raw opaque string이다. Structured Field 인용·escape를 해석하지 않아 `K`와 `"K"`는 다른 키다. 누락은 undefined만 해당한다. 빈 값·공백뿐인 값·비문자열·C0/C1 제어문자·단독 surrogate·header 배열·반복 header field·쉼표가 있는 header는400이다. rawHeaders(Express 또는 Fastify raw)에서 대소문자와 무관하게 반복을 검사한다. 프록시에서 합쳐진 쉼표도 거부하지만 upstream이 이미 버린 중복 정보는 복구할 수 없다. trim/case fold/Unicode 정규화는 하지 않는다(HTTP parser의 OWS 처리는 별개).
- resolver: header를 완전히 대체하고 동기/비동기 string 또는 undefined만 허용한다. 위 문자열 검증·길이 제한은 같으며 쉼표는 허용한다. undefined + required:false만 bypass하고 invalid input은 optional이어도400이다. resolver 자체 throw/rejection은 원래 오류를 전파한다. 모든 입력 거절은 fingerprint·저장소·handler 이전이다.
- 길이: `maxKeyLength`는 UTF-8 bytes, 기본255, 양의 safe integer만 허용한다. handler override가 우선이다. 잘못된 설정은 서버 configuration error(HTTP500)이며 resolver/저장소/handler를 실행하지 않는다. key 오류400, 기존 body 불일치422, PROCESSING409의 우선순위를 유지한다. raw header 프로파일은 draft의 Structured Field String 파싱을 구현한 것이 아니며 S7에서 표기한다.
- 인증: Nest guard 또는 idempotency보다 앞선 인증/인가/서명 검증이 최초 요청과 replay 모두에 적용되어야 한다. handler 내부 검증만으로는 replay를 보호하지 못한다. scope에는 검증된 tenant/user를 넣고 header를 신뢰해 identity를 자동 선택하지 않는다.
- 전환: 모든 scope의 저장 키가 변경된다. legacy 형태로 fallback 조회·이동·삭제하지 않는다. 단, 옛 global raw key/자유로운 resolver 값은 새 v1 key 문자열과 같을 수 있으므로 버전 prefix 자체가 구/신 저장 공간의 분리를 보장하지 않는다. 이미 S1 형식의 body가 있는 그런 레코드는 현 reader가 출처를 구별하지 못하고 재생할 수 있다. 따라서 전환 시에는 **기존 레코드가 없는 별도 물리 저장 namespace**(새 MemoryStorage, 검증된 빈 Redis keyPrefix, 새 Postgres tableName 또는 별도 저장소)를 반드시 사용하고, 구/신 키의 동일 저장 공간 공존은 지원하지 않는다. 옛 레코드에는 권한 범위를 입증할 identity 정보가 없으며 custom 문자열을 역분해해도 복구할 수 없다. 구/신 키가 함께 있으면 같은 업무가 다시 실행될 수 있다. **traffic pause와 drain만으로 이 중복 위험을 해결하지 못한다.** 전 노드 전환 전에 업무 DB/inbox의 durable unique command ID 또는 외부 업무 결과 조정으로 과거 재시도를 차단해야 한다. 그 보장이 없으면 과거 key를 가진 재시도를 upstream에서 계속 차단하고 모든 재전송 가능 기간·처리 불명 업무를 해소할 때까지 전환하지 않는다. TTL 만료만으로 안전하다고 간주하지 않는다.
- 혼합 배포/롤백: old/new writer가 같은 업무를 받을 수 있는 롤링 배포는 미지원이다. 트래픽 중단→in-flight 업무 결과 확인→과거/새 key의 업무 중복 방지 확인→기존 데이터와 겹치지 않는 빈 저장 namespace 확인→전체 교체 후 재개한다. rollback도 동일하게 새 버전에서 처리한 업무를 구버전이 재실행하지 못하게 해야 한다. 무조건 dual-read, prefix 회전만 수행, 일괄 삭제는 전환 절차가 아니다. namespace 분리는 과거 응답 혼입을 막고, 별도 업무 중복 방지는 재실행을 막는 각각의 전제다. D01의 replay body 전환 조건도 함께 적용한다.
- 회귀: 수정 전 tenant-only endpoint 충돌과 `::` 경계 충돌이 모두 실패함을 확인했다. tenant/user/method/path/key 단일 변경, 정상 retry, query/slash/parameter, header/resolver invalid, Express/Fastify guard, legacy/new 공존을 검증한다. 최종 실행 결과는 [S3 작업 기록](work-items/S3-request-isolation.md)에 기록한다.
- 후속: S2 공개 scope 타입의 배열 반환 소비자 검사, S4 namespace/event/log, S7 raw header 프로파일·인증 예제, D07의 업무 중복 방지 조건과 전환 시나리오. D07 전체는 S5/S6 계약까지 반영한 뒤 확정한다.


## D04 — 관측 정보 보호 (DECIDED)

- 날짜/결정자: 2026-10-07, Codex. 사용자 S4 구현 요청 범위에서 결정. 기준 `2fc43d7620dcdcff0d367669acc88a5e1a05b7dd`의 작업 트리.
- namespace: `IdempotencyEvent.scope`를 제거하고 필수 `namespace: string`으로 대체한다. S3 `createRequestKey()`의 namespace를 그대로 사용하며 raw key를 제외한 identity + endpoint JSON tuple의 versioned SHA-256이다. 유효 scope가 같으면 raw key만 바꿔도 namespace는 같다. global은 global tuple을 사용한다. identity·동적 path·원본 key를 문자열로 붙이지 않는다.
- keyHash: 기존 S3 동작인 `SHA256(encodedStorageKey)`의 소문자 hex를 유지한다. 같은 scope/key와 같은 인코딩 버전이면 안정적이고 raw key·identity·endpoint를 바꾸면 달라질 수 있다. S3가 0.4 저장 키 형식을 바꾸었으므로 0.4 keyHash와의 연속성은 보장하지 않는다. S4 자체는 저장 키/schema를 추가로 바꾸지 않는다. 두 hash 모두 암호화·익명화 보장이 아니며 저엔트로피 값 추측, 상관관계 노출, 높은 cardinality가 남는다. metric label에는 namespace/keyHash를 사용하지 않는다.
- error 공개 타입: `IdempotencyEventError = { code: 'storage_failure'; operation: IdempotencyStorageOperation } | { code: 'response_not_replayable' }`. `IdempotencyStorageOperation`은 `'get' | 'create' | 'race_get' | 'complete' | 'delete'`다. `error`는 선택 필드이며 원본 Error/driver 객체를 전달하지 않는다. 원본 `message/name/stack/cause/code`를 읽어 마스킹하거나 복사하지 않고 패키지 소유 상수만 생성한다. getter·순환 참조·임의 throw 값도 같은 규칙을 따른다.
- 내부 로그: 고정 diagnostic code/message와 생성한 namespace/keyHash만 허용하며, 원본 key·storage key·body·identity·path 및 Error 객체/필드를 인자로 전달하지 않는다. bypass/stale/complete 실패/cleanup 실패/callback 실패/Postgres sweep 실패에 적용한다. 직접 호출한 Logger 메서드의 동기 throw와 반환 Promise rejection을 격리하며 재귀 로그를 내지 않는다. Nest 내부에서 반환이 버려진 custom async transport Promise는 관찰할 수 없으므로 transport가 자체 처리한다. 이벤트/로그 계약은 패키지가 생성한 관측 정보에 한정한다. 애플리케이션 exception filter·driver·onEvent 구현이 별도로 기록하는 값은 소비자가 관리한다.
- 대안과 이유: scope 이름을 유지한 채 저장 key를 넣으면 raw key에서 분리된 grouping 의미가 불분명하고 키 변경 때마다 바뀐다. scope 제거 후 namespace를 명시한다. 원본 오류 문자열의 부분 치환은 raw key 이외의 body/인증 정보 및 중첩 cause를 보장할 수 없고 getter를 실행할 수도 있다. 고정 분류만 내보내는 방식으로 진단 상세를 제한한다. 모든 관측 필드를 없애는 대신 생성한 hash로 제한적인 상관관계 분석을 유지한다.

| 실패/경로 | 이벤트 수와 분류 | 현재 클라이언트·저장 처리 |
| --- | --- | --- |
| 첫 `get` | `storage_error` 1회, operation `get` | 원 storage 오류 전파, handler 미실행 |
| `create` | `storage_error` 1회, operation `create` | 원 storage 오류 전파, handler 미실행 |
| 경합 패배 후 재조회 | `storage_error` 1회, operation `race_get` | 원 storage 오류 전파, handler 미실행 |
| `complete` | `complete_error` 1회, operation `complete` | 성공 handler 값 보존, cleanup delete 금지 |
| handler 오류 후 `delete` 실패 | `storage_error` 1회, operation `delete` | 원 handler 오류 보존 |
| handler 오류와 cleanup 성공 | 추가 이벤트 없음 | 기존 handler 오류 전파 |
| handler 반환값 capture 불가 | `bypassed` 1회, code `response_not_replayable` | handler 값 전달, PROCESSING lease 보존 |
| 재생 불가 completed body | `conflict` 1회, error payload 없음 | 409, 기존 record 보존 |
| onEvent 실패 | 추가 이벤트 없음, 고정 안전 로그 1회 | 원 요청 결과·레코드 처리 유지 |

- 동기/비동기: 각 storage 메서드의 동기 throw와 Promise rejection은 같은 관측·보존 경계를 사용한다. `onEvent`는 await하지 않는 best-effort callback이며 동기 throw/rejection이 원 요청을 바꾸거나 cleanup을 실행하지 않는다. 오류 이벤트는 쓰기의 확정 실패나 저장소 상태를 증명하지 않는다. 예를 들어 complete 후 응답 유실이면 실제 저장소는 이미 COMPLETED일 수 있다.
- HTTP 헤더: 기본 활성화. headers가 쓰기 가능할 때 `created/replayed/conflict/mismatch/bypassed/stale/complete_error`의 `Idempotency-Status`를 유지하고 replay에만 `Idempotency-Replayed: true`를 생성한다. `storage_error`에 새 HTTP status 또는 status header를 지정하지 않는다. `exposeStatusHeaders: false`이면 패키지가 생성하지 않는다. 두 관측 헤더는 명시적인 replayHeaders allowlist에도 capture/replay하지 않으며 legacy record의 헤더가 비활성화 설정을 우회하지 못한다.
- 호환성과 진단 한계: 소비자는 event.scope→namespace로 바꾸고 원본 오류 접근을 code/operation 분기로 바꾼다. `IdempotencyEventError`, `IdempotencyStorageOperation`을 root에서 type export하며 S2 fixture에서 검증한다. 원본 오류 상세는 제공하지 않고 metric 예제는 고정 outcome만 사용한다. fingerprint callback의 scope는 별도 API이며 이 전환 대상이 아니다.
- 회귀와 검증: `test/regression/observability-safety.spec.ts`, `observability-headers-sweep.spec.ts`에서 가짜 비밀 값을 key·body·identity·path·storage/callback/logger/sweep 오류에 넣어 전체 event와 Logger 인자를 검사한다. 각 storage 단계 동기 throw/rejection의 event 횟수, handler 결과, 레코드 보존을 대조하고 callback 실패·헤더 enable/disable·명시 allowlist·과거 저장 헤더를 확인한다. 실제 명령/결과/skip은 [S4 검증 기록](work-items/S4-observability.md)에 기록하며 이 결정만으로 검증 완료를 주장하지 않는다.
- 후속(초기 S4 인계): 당시 S5/D05·S6/D06은 미결이었다. 2026-10-07 S5에서 D05와 D06 수명 계약을 통합하고 기존 관측 및 취소/capture/불명 쓰기 회귀를 재실행했다. 최종 결과는 S5 기록을 따른다. S7은 운영 예제/0.4 전환, S8은 동일 tarball 및 최종 지원 matrix 검증으로 인수한다.

## D07 — S3에서 넘긴 전환 전제 (OPEN)

2026-10-07 S3가 확정한 key/scope 전환은 [D03](#d03--요청-격리와-키-입력-decided)과
[S7 인수인계 표](work-items/S7-adoption-docs.md#s3--d07-전환-인수인계-2026-10-07)를 따른다.
legacy alias 재조회는 없지만 raw key와 새 address의 정확한 중첩은 가능하다. 기존 데이터와
writer가 없는 빈 물리 namespace 및 업무 DB/inbox dedup 또는 과거 결과 조정이 모두 필요하다.
구/신 writer 혼합은 지원하지 않으며 rollback도 새 버전이 처리한 업무를 중복 실행하지 못해야 한다.
S3 회귀에서 alias-only 재실행, 정확한 address 중첩의0.4 body409, 별도 namespace 격리를 확인한다.
D07 전체는 S5/S6의 실패·만료 계약과 S7 실행 전환 절차가 완성될 때 확정한다.


## D05 — 장애와 구독 수명 (DECIDED)

- 날짜/결정자: 2026-10-07, Codex. S5 구현 요청, 기준 `e13b3709651b367441d420239e8b91e69d465ea1`. S1 최종값 경계와 S4 안전 관측을 유지한다. 만료/반복 complete의 선행 계약은 D06 및 S6 인계에 기록한다.
- handler 오류: 기존 token 조건부 delete를 유지하고 원 오류를 전파한다. sync `next.handle()` throw와 Observable error, 안쪽 timeout 모두 포함한다. cleanup 실패는 원 오류를 바꾸지 않는다. 패키지는 업무 변경 전/후 예외를 구분하지 못하므로 이 결과는 안전한 업무 재시도를 보장하지 않는다. 업무 transaction rollback 또는 durable command ID/inbox/외부 provider dedup은 소비자 책임이다.
- 오류 경계: handler-error catch를 응답 capture보다 앞에 둔다. 응답 body/status/headers/sent 조회 실패는 `bypassed`/`response_not_replayable`이며 성공 값을 전달하고 PROCESSING을 보존한다. 관측 헤더 쓰기는 best-effort이며 실패해도 업무 결과나 이벤트 분류를 바꾸지 않는다. complete 동기 throw/rejection은 `complete_error` 1회, 성공 값 보존, delete 금지다. get/create/race_get은 원 storage 오류 전파 및 handler 미실행, cleanup 실패는 storage_error/delete 1회다.
- 불명 쓰기: 오류는 저장 미반영의 증거가 아니다. create 응답 유실은 PROCESSING을 남길 수 있고 complete 응답 유실은 이미 COMPLETED일 수 있다. 자동 재조회/재시도는 추가하지 않는다. 접근 가능한 저장소의 get과 업무 원장/provider 조회를 대조하되 null/PROCESSING/만료만으로 업무 실패를 판정하지 않는다.
- 취소: 외부 unsubscribe/timeout은 구독을 종료한다. 별도 구독으로 업무를 계속 붙들거나 자동 cleanup하지 않는다. handler 완료 전 취소하면 이후 Promise 업무 성공/실패/불명 모두 capture/delete를 실행하지 않는다. 이미 시작한 create/complete/delete Promise는 중단되지 않아 이후 저장 상태를 바꿀 수 있고 취소한 구독에는 결과/이벤트가 전달되지 않을 수 있다. HTTP disconnect가 Nest 구독 취소와 같은 시점이라는 보장은 없다.
- 대안과 이유: detached subscription은 무기한 Observable·응답 객체·자원 보존과 shutdown/drain 관리 API를 새로 요구한다. 자동 delete는 취소 뒤 성공할 업무의 중복 실행을 허용한다. 모든 handler 오류의 lease 보존은 기존 retry 호환성을 바꾸지만 업무 완료 여부를 증명하지도 못한다. 기존 cleanup을 유지하고 소비자에게 위험과 durable 업무 중복 방지를 명시한다.
- timeout 배치: 바깥쪽 timeout은 취소 정책이다. 안쪽 handler timeout은 handler 오류 cleanup이므로 abort/rollback이 확인되지 않은 작업에는 사용하지 않는다. Promise race/timeout만으로 외부 side effect가 중단되지 않는다. 지속 처리·결과 회수가 필요하면 서비스의 durable queue/job 및 별도 상태 조회를 사용한다. 자동 heartbeat/강제 unlock/범용 retry는 제공하지 않는다.
- lease/stale: 활성 PROCESSING+동일 token만 완료한다. 만료(새 token 없음 포함), 대체 token, 이미 COMPLETED인 token은 stale이며 성공 handler 값은 전달하고 기존 저장소를 변경하지 않는다. lease 만료는 재실행이 가능해지는 경계이며 업무 중단/안전 증거가 아니다.
- crash 조정: 프로세스 종료는 rollback을 보장하지 않는다. 업무 commit 전, commit 후 complete 전, complete 후 응답 전을 독립 실험하고 ledger·handler 수·token·상태·클라이언트 결과를 기록한다. 결과 불명은 재전송 보류, 성공 확인은 서비스 조정 경로로 결과 반환, 부작용 없음/rollback 확인과 durable dedup이 갖춰진 경우에만 재시도를 판단한다. 저장소와 업무 DB의 범용 원자성/exactly-once는 보장하지 않는다.
- 호환성: 새 공개 옵션/상태/API/schema 없음. 성공 후 capture 예외가 오류+삭제에서 성공값+bypass 보존으로 바뀐다. D06으로 늦은/반복 complete는 일관되게 stale가 되므로 custom adapter도 따른다. 원본 오류는 이벤트/로그에 추가하지 않는다.
- 검증/후속: [S5 기록](work-items/S5-failure-lifecycle.md)에 회귀·실제 공유 저장소 자식 프로세스·불명 쓰기 경계 주입 결과를 기록한다. [운영 절차](../failure-recovery.md)를 S7에, 필수 실DB 명령과 대표 환경 한계를 S8에 전달한다. S4 최종 관측 회귀를 함께 재실행한다.

## D06 — 저장소 공통 계약 (DECIDED)

- 날짜/결정자: 2026-10-07, Codex. S5 선행 수명 계약에 이어 S6-5의 긴 TTL·직접 adapter 입력 정책까지 확정·구현했다.
- 만료: Memory/PG는 `expiresAt <= now`부터 논리적으로 부재다. Redis는 서버 TTL을 권위로 삼고 payload의 client-clock expiresAt은 조회용 메타데이터다. 서로 다른 프로세스/DB 시계가 정확히 일치한다는 보장은 추가하지 않는다. physical timer/sweep 실행 여부와 무관하게 get은 null, create는 새 token 획득 가능, complete는 stale, delete는 ok다.
- complete-once: 활성 PROCESSING + 동일 token만 COMPLETED로 전환하고 성공 응답/headers/새 retention TTL을 저장한다. 최초 createdAt은 유지한다. 같은 token의 반복 또는 동시 complete는 첫 성공 이후 stale이며 최초 응답과 TTL을 바꾸지 않는다. 대체 token이 없어도 만료한 token은 stale다.
- delete: 활성 소유 token이면 삭제 ok, 활성 다른 token이면 stale로 보존, 부재/만료이면 ok다. PG 만료 행의 물리 삭제를 약속하지 않는다. stale 반환은 업무 실패/중단 또는 안전한 업무 재시도의 증거가 아니다.
- TTL: 모든 adapter의 create/complete와 interceptor의 module/decorator `ttl`·`processingTtl`은 **1~2,147,483,647초(양 끝 포함)**의 정수만 허용한다. `Number.isSafeInteger`와 범위 검사로 비숫자·0·음수·소수·NaN·무한대·안전 정수 밖·상한 초과를 거절한다. 30일과 최대값은 유효하다. 유효한 TTL을 받았을 때의 상태표이며, 잘못된 TTL은 NX/CAS·만료 검사보다 먼저 `RangeError`로 reject한다. 저장소 조회·변경·timer 정리는 수행하지 않는다. interceptor에서는 handler/storage 호출 전 요청 시점의 설정 오류(기본 HTTP 500)다.
- TTL 대안/근거: Node timer의 약 24.8일 상한을 TTL 자체에 적용하면 30일 사용을 막으므로 채택하지 않았다. 제한 없는 safe integer 초도 ms/Date/DB 범위를 넘으므로 채택하지 않았다. 명시적인 32-bit 양수 **초** 범위는 현재 날짜에서 ms/Date 변환 및 Redis EXPIRE·PG interval에 여유가 있고 backend별 범위 차이를 숨기지 않는다. Node timer의 같은 숫자는 **밀리초** 상한이므로 Memory는 deadline까지 최대 2,147,483,647ms씩 나눠 예약한다. 조용한 clamp·문자열 숫자 변환은 하지 않는다.
- 직접 입력 책임: built-in과 custom adapter가 TTL을 매 호출 검증한다. 내부 공통 helper는 새 public export가 아니며 custom adapter는 동일 계약을 구현한다. 나머지 key/token/response 입력 전체의 런타임 schema 검증을 추가하는 결정은 아니다. 기존 token 판정과 타입 계약은 유지한다.
- 구현: Memory 모든 연산의 논리 만료 검사를 공유하고 timer callback도 deadline을 재검사한다. Entry identity로 교체·완료 후 남은 callback을 무효화하며 각 chunk를 unref하고 delete/destroy/complete에서 timer를 정리한다. PG create의 정확한 경계를 <=로 통일하고 complete/delete에 만료 조건을 추가한다. Redis Lua는 token과 읽었던 PROCESSING payload를 함께 비교해 동시 완료 두 개가 모두 성공하지 못하게 한다. body는 S1 opaque string으로 취급한다.
- 대안/이유: token만 검사하면 lease 권한이 이미 끝난 작업이 응답을 되살릴 수 있다. repeated complete 덮어쓰기/TTL 갱신은 뒤늦은 호출이 최초 확정 결과를 바꾸므로 채택하지 않는다. 동일 token repeated를 ok로 다루는 멱등 확인 API도 도입하지 않는다. 기존 ok/stale 시그니처를 유지하고 이미 완료된 경우 stale로 통일한다.
- 영향: 공개 시그니처·저장 key·SQL schema 변화 없음. Memory/Redis의 반복 완료, Memory/PG의 늦은 완료 결과가 바뀐다. custom adapter도 논리적 만료·complete-once 원자성 및 TTL 범위·검증 순서를 구현해야 한다. 과거 받아들인 상한 초과 TTL 또는 직접 호출의 잘못된 TTL은 이제 RangeError이며, 30일 Memory TTL은 조기 삭제되지 않는다.
- 검증: 공유 contract의 동시 create/complete, 응답/TTL/createdAt 보존, 만료와 대체 token, Memory -1/0/+1ms, PG transaction의 고정 now 경계, 실제 Redis 서버 expiry에 긴 TTL·범위·직접 호출 검사를 추가했다. [S6 기록](work-items/S6-storage-contract.md)의 최종 증거와 [S5 기록](work-items/S5-failure-lifecycle.md)의 선행 통합 결과를 따른다.
- 후속: S7에는 custom adapter 호환성과 TTL 설정 오류·전환 설명, S8에는 실제 DB 필수 검증·같은 tarball·지원 버전 전체 검증을 넘긴다.
