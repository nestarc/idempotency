# 배포 tarball 소비자 검증

소스 저장소 밖의 독립 프로젝트에 실제 `npm pack` tarball을 설치하고, 공개 import 경로·선택 의존성·strict TypeScript·Nest 부팅/종료를 검사한다. 실행기는 [`scripts/consumer-package.mjs`](../../scripts/consumer-package.mjs)다.

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
```

`--baseline`은 기존 루트 MemoryStorage import와 선언 파일의 드라이버 의존성 실패를 자동 재현한다. `--skip-services`는 명시적인 부분 검증이다. Redis/PG 소비자도 공식 어댑터를 import하고 타입 검사를 수행하지만, Nest 부팅에는 MemoryStorage를 사용하며 실제 어댑터 smoke를 `SKIP`으로 기록한다. 서비스 없이 실행한 결과만으로 S2 또는 S8의 실제 어댑터 검증을 완료 처리하지 않는다.

## Fixture 구조와 설치 계약

각 `memory/`, `redis/`, `postgres/` 디렉터리에는 독립 `package.json`, `tsconfig.json`, `consumer.ts`, `runtime.cjs`가 있다. 실행기는 선택한 디렉터리의 내용을 격리 프로젝트 루트에 복사하고 공통 파일은 `common/`으로 복사한다. 따라서 소스 위치에서 직접 `tsc`를 실행하는 대신 실행기를 사용한다.

| 항목                              | 고정 버전 / 계약                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| Node                              | 패키지의 Node >=20 지원 범위 안에서 실행 환경 버전을 기록                                       |
| Nest common/core/platform-express | 각각 11.1.18                                                                                    |
| reflect-metadata / rxjs           | 0.2.2 / 7.8.2                                                                                   |
| TypeScript / @types/node          | 5.7.3 / 20.19.39                                                                                |
| Memory                            | `pg`, `ioredis`, `@types/pg` 모두 없음                                                          |
| Redis                             | `ioredis` 5.10.1, `pg`와 `@types/pg` 없음                                                       |
| Postgres                          | 처음에는 `pg` 8.20.0만 설치하여 타입 실패를 확인한 다음 `@types/pg` 8.20.0 추가; `ioredis` 없음 |

TypeScript는 `strict: true`, `skipLibCheck: false`에서 `node`, `node16`, `nodenext` 모드를 검사한다. 이는 현재 CommonJS 배포물을 소비하는 검사이며 ESM 배포물 제공이나 모든 TypeScript/Nest 버전의 지원을 입증하지 않는다.

`common/public-api.ts`는 루트의 공개 storage/options/callback/event 타입과 상수를 사용한다. 어댑터 타입은 각각 `@nestarc/idempotency/redis`, `@nestarc/idempotency/postgres`에서 가져온다. Postgres sweep 타입과 클래스도 Postgres 경로에서 검사한다. 런타임 검사는 SQL 공개 경로와 차단된 내부 `dist/`, `src/` 경로도 확인한다.

Memory 런타임은 DB 드라이버 없이 두 어댑터 경로를 import할 수 있는지, `connection`으로 생성할 때 빠진 드라이버와 설치 명령을 설명하는 오류가 발생하는지도 검사한다. 실제 Redis/PG smoke는 Nest `create/init/close` 안에서 `create/get/complete/delete`, 중복 생성 차단, 응답 보존을 검사한다. Redis는 실행별 prefix를 사용하고 클라이언트를 닫는다. Postgres는 실행별 테이블을 만들고 검사 후 삭제하며 pool을 닫는다.

## 격리와 증거

실행기는 macOS의 `/private/tmp/idempotency-consumers-*` 또는 Linux의 `/tmp/idempotency-consumers-*`에 프로젝트와 결과를 보존한다. `NODE_PATH`와 `NODE_OPTIONS`를 제거하고 Node의 전역 검색 경로를 끄며, 상위 `node_modules`와 설치 패키지 symlink가 없는지 검사한다. 별도 lockfile을 생성한 뒤 `npm ci`로 설치한다.

실행 결과 디렉터리에는 tarball SHA-256, 실행 환경, Git 기준점과 working tree 상태, `summary.json`, 명령별 로그, tarball 파일 목록, 소비자별 `package-lock.json`과 설치 목록이 남는다. 직접 의존성은 fixture에서 고정되며 전이 의존성까지 같은 설치를 재현하려면 해당 실행에서 보존한 lockfile을 사용한다.

S8은 성공/기대된 실패/생략 결과와 실제 서비스 환경을 함께 인계받아 최종 지원 matrix를 다시 실행한다. 최종 증거는 [S2 작업 문서](../../docs/1.0.0/work-items/S2-consumer-package.md)와 [S8 작업 문서](../../docs/1.0.0/work-items/S8-release-validation.md)에 기록한다.
