# 1.0.0 계약과 설계 결정 기록

[작업판으로 돌아가기](README.md)

조사 기준: 2026-10-06, 0.4.0, `9610774a767d152c4cbae49c6276a4f2d76463e4`. D01·D02를 결정해 S1·S2에 반영하며 나머지는 미결이다. 재현된 사실은 [조사 문서](../1.0.0-stabilization-research.md), 진행 상태는 작업판을 기준으로 한다.

## 기록 방법

결정 상태는 `OPEN`, `DECIDED`, `SUPERSEDED`를 사용한다. 근거·검증 방법·호환성 영향을 정리해 `DECIDED`로 바꾼 뒤 관련 구현에 반영한다. 결정 기록은 추가 승인 절차를 뜻하지 않는다. 선택한 설계의 이유를 다음 작업자가 이해할 수 있게 하는 문서다.

각 결정에 날짜, 결정자, 선택한 계약, 대안과 선택 이유, 공개 API/키/schema/운영 영향, 회귀 테스트, 후속 작업을 기록한다. 결정을 바꿀 때는 이전 이유를 지우지 말고 대체한 결정과 변경 사유를 남긴다. 태스크 체크박스 완료만으로 결정 상태를 자동 변경하지 않는다.

## 결정 목록

| ID | 상태 | 담당 작업 | 결정할 계약 | 반드시 검토할 영향 |
| --- | --- | --- | --- | --- |
| D01 | DECIDED | S1 | 최외곽 idempotency에서 최종 plain JSON 저장, 마지막 정상 emission, 버전 표식, 미지원 lease 유지/사전 거부 | 자세한 계약과 전환 조건은 아래 D01 및 S1 문서 |
| D02 | DECIDED | S2 | Memory/common root, Redis·PG 공식 subpath 분리; PG 타입은 소비자가 설치 | 0.4 root DB import를 /redis·/postgres로 이동; TS5.7.3 CJS node/node16/nodenext |
| D03 | OPEN | S3 | 인증된 identity와 endpoint 조합, 모호하지 않은 key 형식, header/resolver 입력 계약 | global/custom scope 의미, query 제외, 중복·빈 헤더, 문자열 길이, legacy record와 혼합 버전 |
| D04 | OPEN | S4 | event namespace·keyHash·오류 정보·로그 마스킹 계약 | raw key/인증 정보/동적 경로의 노출, 기존 event 소비자, metric cardinality, callback 실패 |
| D05 | OPEN | S5 | handler 실패·저장소 실패·취소·결과 불명 시 레코드와 클라이언트 동작 | 동기 throw/rejection 일치, 기록 성공 후 응답 유실, 취소 후 업무 성공, 잠금 삭제와 중복 실행 |
| D06 | OPEN | S6 | create/complete/delete의 만료 경계와 반복 complete, 긴 TTL 정책 | Memory/Redis/PG 동일 동작, stale token, custom adapter 변경, schema 필요 여부 |
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
