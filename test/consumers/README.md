# 배포 tarball 소비자 검증

소스 저장소 밖의 독립 프로젝트에 실제 `npm pack` tarball을 설치하고, 공개 import 경로·선택 의존성·strict TypeScript·Nest 부팅/종료를 검사한다. README의 도입 예제는 TypeScript로 타입 검사한 **동일한 파일을 emit하여 실행**한다. 실행기는 [`scripts/consumer-package.mjs`](../../scripts/consumer-package.mjs)다.

## 실행

저장소 루트에서 실행한다. 실제 서비스 검증에서는 fixture가 생성하는 전용 Redis 키와 Postgres 테이블을 사용할 수 있어야 한다.

```sh
npm ci
TEST_REDIS_URL=redis://127.0.0.1:6379 \
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/idempotency \
node scripts/consumer-package.mjs
```

기본 실행은 저장소를 빌드하고 tarball을 만든다. 이미 만든 tarball 또는 baseline을 검사하려면 아래 옵션을 사용한다.

```sh
node scripts/consumer-package.mjs --tarball /absolute/path/candidate.tgz
node scripts/consumer-package.mjs --baseline /absolute/path/baseline-0.4.0.tgz
node scripts/consumer-package.mjs --skip-services
node scripts/consumer-package.mjs --tarball /absolute/path/candidate.tgz \
  --nest 10 --peer-profile minimum --output /tmp/fresh-consumer-evidence
```

`--nest 10|11`과 `--peer-profile representative|minimum`으로 출시 matrix를 선택한다. 기본값은 `11`과 `representative`다. `--output`은 **상위 디렉터리가 존재하는 절대 경로이며 아직 존재하지 않는 디렉터리**여야 한다. 저장소 밖에서만 실행하며 상위 `node_modules`가 없어야 한다. CI에서는 `$RUNNER_TEMP` 아래를 사용한다. 동일한 tarball을 Node 22/24 × Nest 10/11 × 두 peer profile에서 검사하며, 각 실행의 Memory 소비자에서 Express와 Fastify의 실제 HTTP 요청을 모두 실행한다. 버전 원본과 개발 테스트 설치 명령은 [`scripts/release-matrix.mjs`](../../scripts/release-matrix.mjs)에서 함께 관리한다.

`--baseline`은 기존 루트 MemoryStorage import와 선언 파일의 드라이버 의존성 실패를 자동 재현한다. `--skip-services`는 명시적인 부분 검증이다. Redis/PG 소비자도 공식 어댑터와 예제를 import하고 타입 검사를 수행하지만, Nest 부팅에는 MemoryStorage를 사용하며 실제 어댑터·sweep·외부 연결 소유권 smoke를 `SKIP`으로 기록한다. 서비스 없이 실행한 결과만으로 S2, S7 또는 S8의 실제 어댑터 검증을 완료 처리하지 않는다. Memory HTTP 예제는 이 옵션에서도 실행하므로 loopback port를 열 수 있어야 한다.

## Fixture 구조와 설치 계약

각 `memory/`, `redis/`, `postgres/` 디렉터리에는 독립 `package.json`, `tsconfig.json`, `consumer.ts`, `examples.ts`, `runtime.cjs`가 있다. 실행기는 선택한 디렉터리의 내용을 격리 프로젝트 루트에 복사하고 공통 파일은 `common/`으로 복사한다. 따라서 소스 위치에서 직접 `tsc`를 실행하는 대신 실행기를 사용한다. `examples.ts`와 공통 등록 예제는 `compiled/`에 emit하고 `runtime.cjs`에서 호출한다. Memory의 `quickstart.ts`는 tarball 안의 README `// app.module.ts` 블록과 줄바꿈·앞뒤 공백을 제외한 동일성을 검사한다. 문서 예제를 수정하면 이 파일도 함께 갱신한다.

| 항목                                     | 고정 버전 / 계약                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| Node                                     | 지원 matrix 22/24; 실행 환경의 정확한 버전을 기록                                       |
| Nest common/core/testing/Express/Fastify | Nest 10은 모두 10.4.22, Nest 11은 모두 11.1.18; Fastify 소비자 의존성은 Memory에만 설치 |
| Memory serializer 예제                   | `class-transformer` 0.5.1                                                               |
| reflect-metadata / rxjs                  | 0.2.2 / 7.8.2                                                                           |
| TypeScript / @types/node                 | 5.7.3 / 20.19.39                                                                        |
| Memory                                   | `pg`, `ioredis`, `@types/pg` 모두 없음                                                  |
| Redis                                    | representative `ioredis` 5.10.1 / minimum 5.0.0; `pg`와 `@types/pg` 없음                |
| Postgres                                 | representative `pg`/`@types/pg` 8.20.0 / minimum 둘 다 8.11.0; `ioredis` 없음           |

Postgres는 어느 profile에서도 먼저 `@types/pg` 없이 설치하여 세 resolution 모드의 TS7016을 기대된 실패로 확인한 뒤, 선택한 버전의 타입 패키지를 명시적으로 설치한다. `minimum`은 선언한 **선택 peer 세 개**의 하한 검사다. Nest의 모든 minor/patch 또는 모든 전이 의존성 하한 검사를 뜻하지 않는다.

TypeScript는 `strict: true`, `skipLibCheck: false`에서 `node`, `node16`, `nodenext` 모드를 검사한다. 이는 현재 CommonJS 배포물을 소비하는 검사이며 ESM 배포물 제공이나 모든 TypeScript/Nest 버전의 지원을 입증하지 않는다.

`common/public-api.ts`는 루트의 공개 storage/options/callback/event 타입과 상수를 사용한다. 어댑터 타입은 각각 `@nestarc/idempotency/redis`, `@nestarc/idempotency/postgres`에서 가져온다. Postgres sweep 타입과 클래스도 Postgres 경로에서 검사한다. 런타임 검사는 SQL 공개 경로와 차단된 내부 `dist/`, `src/` 경로도 확인한다.

Memory 런타임은 DB 드라이버 없이 두 어댑터 경로를 import할 수 있는지, `connection`으로 생성할 때 빠진 드라이버와 설치 명령을 설명하는 오류가 발생하는지도 검사한다. 실제 Redis/PG smoke는 Nest `create/init/close` 안에서 `create/get/complete/delete`, 중복 생성 차단, 응답 보존을 검사한다. Redis는 실행별 prefix를 사용하고 클라이언트를 닫는다. Postgres는 실행별 테이블을 만들고 검사 후 삭제하며 pool을 닫는다.

## S7 실행 가능한 도입 예제

| 예제 파일                                                | 실제 검증 범위                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`common/module-examples.ts`](common/module-examples.ts) | `forRoot`와 `forRootAsync`의 `useFactory`/`useClass`/`useExisting`; 공식 storage/options token, imports/inject 연결, factory 인스턴스 재사용, TestModule compile/init/close                                                                    |
| [`memory/quickstart.ts`](memory/quickstart.ts)           | 배포 README 코드와 동일성 검사; 그대로 compile/init; curl 예제와 같은 첫 요청 201 및 정상 replay; close                                                                                                                                        |
| [`memory/examples.ts`](memory/examples.ts)               | quickstart의 전역/컨트롤러/메서드 interceptor 등록; HTTP 201 및 정상 replay; idempotency→serializer 순서와 제외 필드 미노출; payload 변경 422; 검증된 tenant/user 별 격리; 인증 회수 후 replay 전에 401; 고정 outcome 관측                     |
| [`memory/http-adapters.ts`](memory/http-adapters.ts)     | Express와 Fastify 각각 NestFactory create/init/listen; 실제 TCP 첫 요청 201·정상 replay·본문/Content-Type 일치·payload 변경 422·handler 1회·close                                                                                              |
| [`redis/examples.ts`](redis/examples.ts)                 | 공식 `new RedisStorage({ client, keyPrefix })`; 모든 sync/async 모듈 등록; Nest close 뒤 외부 client PING 성공; async `connection`으로 만든 실제 client는 close 뒤 end 상태                                                                    |
| [`postgres/examples.ts`](postgres/examples.ts)           | 공식 `new PostgresStorage({ pool })`; 모든 sync/async 모듈 등록; README sweep provider wiring compile/init/close; 동일 Pool로 실제 만료 row만 제거; Nest close 뒤 외부 Pool SELECT 성공; async `connection`으로 만든 실제 Pool은 close 뒤 종료 |

Memory의 인증 토큰 목록은 테스트용 verifier다. 실제 서비스는 자신이 검증한 인증/권한 정보를 사용한다. HTTP 예제의 결제 handler는 영속 업무 원장이나 실제 결제 provider가 아니며, 업무 중복 방지와 결과 불명 조정은 [도입 recipe](../../docs/adoption-recipes.md) 및 해당 회귀 검증의 범위다. `client`/`pool`로 주입한 외부 연결은 호출자가 마지막 `quit()`/`end()`를 수행한다. fixture는 Nest 종료가 이 외부 연결을 닫지 않았음을 확인한 뒤 정리한다. `connection` 구성은 공개 `clientFactory`/`poolFactory`로 실제 생성된 연결을 관찰하고 Nest가 어댑터 소유 연결을 종료했는지 별도로 확인한다.

## 격리와 증거

실행기는 macOS의 `/private/tmp/idempotency-consumers-*` 또는 Linux의 `/tmp/idempotency-consumers-*`에 프로젝트와 결과를 보존한다. `NODE_PATH`와 `NODE_OPTIONS`를 제거하고 Node의 전역 검색 경로를 끄며, 상위 `node_modules`와 설치 패키지 symlink가 없는지 검사한다. 별도 lockfile을 생성한 뒤 `npm ci`로 설치한다.

실행 결과 디렉터리에는 tarball SHA-256, 실행 환경, Git 기준점과 working tree 상태, `summary.json`, 명령별 로그, tarball 파일 목록, 소비자별 `package-lock.json`과 설치 목록이 남는다. summary의 `nestMajor`, `peerProfile`, `versions`에 선택값과 정확한 pin을, `consumers.*.installedVersions`에 실제 설치한 직접 의존성 버전을 기록한다. HTTP 결과는 `memory-express-http`, `memory-fastify-http`로 따로 기록한다. 직접 의존성은 fixture와 공통 matrix 설정에서 고정되며 전이 의존성까지 같은 설치를 재현하려면 해당 실행에서 보존한 lockfile을 사용한다. 보존할 때 `node_modules`를 제외하고 실행 결과·lockfile·로그를 함께 수집한다.

S8은 성공/기대된 실패/생략 결과와 실제 서비스 환경을 함께 인계받아 최종 지원 matrix를 다시 실행한다. 최종 증거는 [S2 작업 문서](../../docs/1.0.0/work-items/S2-consumer-package.md), [S7 작업 문서](../../docs/1.0.0/work-items/S7-adoption-docs.md), [S8 작업 문서](../../docs/1.0.0/work-items/S8-release-validation.md)에 기록한다.
