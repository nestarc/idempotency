# S2 — 소비자 설치와 공개 API

- 상태: [작업판](../README.md) 참조. 이 파일은 작업 범위와 인계 기록을 관리한다.
- 조사일: 2026-10-06 · baseline: `9610774` (`@nestarc/idempotency` 0.4.0).
- 근거: [안정화 조사](../../1.0.0-stabilization-research.md)의 선택 의존성·공개 API 항목.
- 착수 조건: 다른 작업과 독립 착수 가능. 최종 소비자 검증은 S8에 인계한다.

## 목적

Memory만 쓰는 앱은 DB 드라이버 없이 설치·실행·타입 검사가 가능해야 한다.
Redis 또는 Postgres 소비자는 선택한 어댑터의 의존성만 명시적으로 설치한다.
1.0에서 지원할 import 경로와 공개 타입을 고정하여 내부 파일 경로에 의존하는 사용을 줄인다.

## 확인된 근거와 재현 절차

`postgres.storage.ts`의 `DatabaseError` 값 import는 루트 barrel import만으로 실행된다.
`pg`는 optional peer인데도 MemoryStorage만 import한 독립 소비자가 `Cannot find module 'pg'`로 종료됐다.
배포용 선언 파일은 `pg`와 `ioredis` 타입을 참조하므로 런타임 lazy import만으로 해결되지 않는다.
`strict: true`, `skipLibCheck: false` 소비자에서 두 peer가 없으면 TS2307이 발생했다.
두 peer가 있어도 `@types/pg`가 없으면 TS7016이 발생했다. 조사 당시에는 복사한 dist를 사용했다.
아래 재현은 조사자의 임시 디렉터리 대신 저장소에 선언할 재사용 fixture를 기준으로 한다.

1. `npm ci`로 개발 의존성을 준비하고 `npm run build`, `npm pack --json`으로 실제 tarball을 만든다.
2. fixture 정의와 실행기를 저장소에 추가한다. 별도 소비자 package.json, tsconfig, 시작 코드를 포함한다.
3. 소비자 공통 의존성은 지원 버전의 `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, `rxjs`다.
4. 컴파일용 `typescript`, `@types/node`와 부팅에 사용할 `@nestjs/platform-express`도 fixture에 선언한다.
5. Memory fixture에는 `pg`, `ioredis`, `@types/pg`를 넣지 않고 tarball의 공식 경로에서 MemoryStorage를 import한다.
6. Redis-only에는 ioredis, PG-only에는 pg만 추가한 경우부터 검사한다. PG 타입의 추가 설치 필요성도 별도로 확인한다.
7. Node import, strict TS 컴파일, Nest 애플리케이션 생성·init·close 결과와 실제 설치 목록을 보존한다.

소비자 실행 환경은 소스 저장소의 상위 `node_modules`로 fallback하지 않아야 한다.
컨테이너 또는 실행기가 만든 격리 환경을 사용하고, symlink·`NODE_PATH`로 개발 의존성이 새지 않는지 확인한다.
fixture 소스와 dependency 선언은 저장소에 남기며, 기존 `/tmp` 산출물이나 형제 저장소를 전제로 하지 않는다.

## 포함·제외 범위

- 포함: optional peer 런타임/선언 경계, 공식 import 경로, package files/entry point, 공개 타입 export.
- 포함: `IdempotencyKeyResolver`, `IdempotencyFingerprintInput/Resolver`, `IdempotencyEvent/Outcome/ObservabilityOptions`의 공개 사용.
- 포함: 현재 CJS 배포물을 소비하는 지원 TypeScript/Nest 환경과 설치 문서에 필요한 변경 정보.
- 제외: dual ESM/CJS 신규 제공, 저장소 어댑터 추가, DB 운영 정책, 도메인별 도입 recipe 작성.

## 구현 결정 — D02 확정 (2026-10-06)

| 항목 | 확정 계약 |
| --- | --- |
| optional 타입 경계 | root는 Memory/common만 공개, Redis와 PG는 각각 `/redis`, `/postgres`로 분리. |
| pg 타입 제공 | PG TypeScript 소비자가 `pg`와 개발 의존성 `@types/pg`를 명시적으로 설치. @types/pg는 optional peer. |
| 공개 import 경로 | root의 DB adapter·옵션 및 sweep export를 제거. DB 사용자는 새 공식 경로로 이동하며 내부 dist 경로는 exports에서 차단. SQL·package.json은 공개. |
| 컴파일 환경 | TS 최소5.7.3, strict/skipLibCheck:false, CJS의 node/CommonJS·node16/Node16·nodenext/NodeNext. |

[D02](../decisions.md#d02--선택-의존성과-공개-import-경계-decided)에 lazy-only·필수 타입 의존성·구조적 client 타입 대안과 호환성 영향을 기록했다.
`DatabaseError instanceof`와 SQLSTATE22P02 분류는 유지하고, 드라이버 require만 필요한 생성/오류 경로로 지연했다.
새 공개 callback/event 타입은 root에서 export한다. S2에서 저장 키·schema·상태 계약을 변경하지 않았다.

## 작업 체크리스트

- [x] **S2-1** Memory/Redis/PG 소비자 fixture와 격리 실행기를 만들고 baseline 실패를 자동 재현한다.
- [x] **S2-2** root import의 eager pg 의존성을 제거하고 선택 드라이버 누락 시점·오류 메시지를 검증한다.
- [x] **S2-3** 선언 파일의 선택 의존성 경계를 결정·구현하고 `skipLibCheck: false` 검사를 통과시킨다.
- [x] **S2-4** 공개 옵션·callback·event 타입을 공식 경로에서 import하는 컴파일 검사를 추가한다.
- [x] **S2-5** tarball에 runtime JS, declarations, 필요한 SQL/README/LICENSE가 포함되는지 확인한다.
- [x] **S2-6** 기존 root import 소비자와 새 설치 경로를 비교하여 마이그레이션 요구를 S7에 전달한다.
- [x] **S2-7** 실행기 명령, fixture 위치, dependency 버전, 성공/실패 로그를 S8에서 재사용하도록 정리한다.

## 완료 조건

- Memory-only는 pg/ioredis 및 그 타입 없이 import·strict TS·Nest 부팅/종료를 통과한다.
- Redis-only는 pg 없이, PG-only는 ioredis 없이 동일 검사를 통과한다.
- fixture는 실제 tarball을 설치하며 소스 직접 import나 소스 저장소 의존성 fallback을 사용하지 않는다.
- 선택한 DB 어댑터는 대표 실제 서비스 환경에서 create/get/complete/delete smoke 검사를 통과한다. S8은 동일 fixture를 최종 지원 matrix에서 재사용한다.
- 새 공개 타입을 소비자가 내부 `dist/` 경로에 접근하지 않고 사용할 수 있다.
- 계약 변경, 필요한 타입 패키지, 공식 import 경로가 S7 문서에 반영될 정보로 정리돼 있다.

## 관련 파일

- [package.json](../../../package.json), [빌드 설정](../../../tsconfig.build.json), [루트 export](../../../src/index.ts).
- [저장소 export](../../../src/storage/index.ts), [RedisStorage](../../../src/storage/redis.storage.ts), [PostgresStorage](../../../src/storage/postgres.storage.ts).
- [옵션·공개 타입](../../../src/interfaces/idempotency-options.interface.ts), [모듈 테스트](../../../test/idempotency.module.spec.ts).
- [소비자 fixture 안내](../../../test/consumers/README.md), [격리 실행기](../../../scripts/consumer-package.mjs), [공개 타입 검사](../../../test/consumers/common/public-api.ts).
- [선택 peer 회귀](../../../test/regression/optional-peer-boundary.spec.ts), [Redis 공식 진입점](../../../src/redis.ts), [Postgres 공식 진입점](../../../src/postgres.ts).
- [공유 storage 계약](../../../test/support/shared-storage-contract.ts)은 malformed/유효 UUID nonmatching token 모두 검사하도록 강화했다.

## 검증 명령과 환경

```sh
npm ci
npm run lint
npx tsc --noEmit --incremental false -p tsconfig.json
# 테스트 전용 실제 Redis/PG URL을 설정한 셸에서:
npm run prepublishOnly
npm run test:consumers
# 이미 생성한 동일 artifact를 재검사하려면:
npm run test:consumers -- --tarball /absolute/path/candidate.tgz
# 수정 전 tarball의 실패를 자동 확인하려면:
npm run test:consumers -- --baseline /absolute/path/baseline.tgz
```

`test:consumers` 기본값은 build→pack→격리 설치다. `--tarball`은 주어진 artifact를 그대로 설치한다.
fixture dependency 선언은 `test/consumers/{memory,redis,postgres}/package.json`에 있다.
실행마다 소스 밖 임시 디렉터리에서 lockfile 생성→npm ci를 수행하고 해당 lockfile·설치 목록을 보존한다.
Node 검색 경로를 비활성화하며 NODE_PATH/NODE_OPTIONS·상위 node_modules·패키지 symlink 누출을 차단한다.

`TEST_REDIS_URL`, `TEST_DATABASE_URL`이 없으면 기본 실행은 실패한다. `--skip-services`만 명시적 부분 검사이며
실DB 검사를 skip으로 기록한다. 이 옵션은 S2/S8 완료 검증에 사용하지 않았다.
HTTP 서버는 Nest create/init/close까지 검사하며 listen은 호출하지 않는다.
Redis prefix와 PG 테이블은 실행별로 생성하고 제거한다. 운영 서비스에서 실행하지 않는다.

검증기는 summary.json, tarball SHA-256/파일 목록, 명령별 로그, 소비자별 실제 dependency 목록과 lockfile을
macOS `/private/tmp/idempotency-consumers-*` 또는 Linux `/tmp/idempotency-consumers-*`에 보존한다.
직접 의존성은 고정이며 전이 의존성까지 같은 설치를 재현하려면 해당 실행의 lockfile을 사용한다.
최종 지원 matrix와 CI artifact 보존은 S8에서 연결한다.

## 검증 증거 — 2026-10-06

- 대상: `c5dff136404a135396957258204af8466744f971` + S2 작업 트리. 버전은 unreleased 개발 상태의0.4.0이며 publish/tag/push하지 않았다.
- baseline (TS5.4.5): 위 commit에서 수정 전에 만든 실제 tarball. Memory/Redis root import의 `Cannot find module 'pg'`, 선언 TS2307(pg/ioredis), PG 타입 미설치 TS7016을 자동 재현했다. @types/pg 설치 후에도 baseline PG 소비자는 ioredis 타입 누출이 남는다.
- 설치/검사 환경: macOS arm64, Node24.11.1/npm11.6.2, Nest common/core/platform-express11.1.18, reflect-metadata0.2.2/rxjs7.8.2, TS5.7.3/@types/node20.19.39, ioredis5.10.1, pg8.20.0/@types/pg8.20.0.
- 실제 서비스: Redis7.2.7, PostgreSQL16.14. Docker 초기 설정을 대신해 이번 실행에서 임시 디렉터리에 바이너리와 전용 데이터를 준비했다. 실행기는 이 로컬 경로에 의존하지 않고 제공된 서비스 URL만 사용한다.
- 개발 검증: clean `npm ci`, lint, 전체 개발 TypeScript 검사 통과. 두 실제 DB URL을 설정한 `npm run prepublishOnly`에서 **26 suite / 351 pass / 0 fail / 0 skip**, clean/build까지 통과.
- 하한 검증: 초기 TS5.4.5 후보에서 pg-protocol1.16.1의 Buffer generic 선언으로 TS2315가 발생했다. 전이 패키지 override 대신 최소 검증 버전을5.7.3으로 확정해 재검사했다.
- consumer 결과와 tarball checksum: 아래 최종 실행 기록 및 [보존 증거](../evidence/S2-validation.json) 참조.
- 제한: Nest11/Node24 대표 환경이다. Node22·Nest10·다른 드라이버 버전 및 최종 출시 artifact 검증은 S8에 남는다. DB smoke는 adapter 저장 계약 검사이며 sweep DI 예제나 RC 도입 검증을 대체하지 않는다.

### 최종 실행 기록

| 대상 | 결과 | SHA-256 / 증거 |
| --- | --- | --- |
| 수정 전 baseline, TS5.4.5 | 22 pass, 14 기대된 실패, 0 unexpected fail/skip | `3e717a589fd248e0311a18c7a761e5460d68cf2e13a2b7370d78e200055062da` |
| 초기 후보, TS5.4.5 | PG 타입 설치 후 TS2315 실패. D02 하한 수정의 근거이며 완료 증거로 사용하지 않음 | `b9add395d6150308ffa34066f7cf75979af0bb144345eb2e1daf3baf61ac8bf2` |
| 최종 후보, TS5.7.3 | **41 pass, 3 기대된 실패, 0 unexpected fail / 0 skip** | `3388c4bb8ad81c516fad086b881011dbfd820eb01bf48f077088ef0b55579f6f` |

최종 실행: 2026-10-06 21:25 KST. Memory·Redis·PG 모두 Node import와 세 compiler mode,
Nest 생성/init/close, create/get/complete/delete를 통과했다. 기대된 실패3개는 @types/pg 미설치 상태에서
세 compiler mode의 TS7016을 확인한 검사다. 타입을 추가한 뒤 세 모드 모두 성공했다.

소비자 소스·직접 버전은 저장소 fixture에, 요약·선택 로그·전체 테스트 결과는
[보존 JSON](../evidence/S2-validation.json)에 남겼다. 전체 설치 목록/lockfile/명령별 로그와 tarball은
최종 실행 디렉터리 `/private/tmp/idempotency-consumers-v8lDiK/`에 있다.
최종 artifact는 그 디렉터리의 `nestarc-idempotency-0.4.0.tgz`이며 S8에서 새 최종 commit을 검증할 때 새 artifact/checksum을 기록한다.
baseline 전체 로그는 `/private/tmp/idempotency-consumers-FDbulO/`에 있다.
새 baseline은 별도 `c5dff13` checkout에서 npm ci→npm run build→npm pack으로 만든 뒤 현재 실행기의 --baseline에 전달한다.
검증 종료 후 이번에 띄운 임시 Redis/PG는 정상 종료했고 실행 증거는 보존했다.
기존 임시 디렉터리가 없어도 저장소 fixture·실행기와 테스트 서비스 URL로 새 검증을 재현할 수 있다.

## 호환성과 다른 작업 인계

S4의 event 의미와 S5/S6의 storage 계약은 관련 타입 변경 가능성을 S2에 전달한다.
S2는 import·dependency 변경을 S7에, 재현 가능한 tarball 소비자 실행기를 [S8](S8-release-validation.md)에 인계한다.
S8 최종 matrix 결과가 나오기 전에는 전체 지원 환경을 검증했다고 기록하지 않는다.

## 다음 작업자에게

- 마지막 갱신: 2026-10-06. 작업자 Codex, main 작업 트리, 기준 commit `c5dff13`.
- S2-1~S2-7 구현·검증 완료. D02 DECIDED. 대표 환경의 실제 tarball 소비자와 실DB 검사 통과, skip 없음.
- S7: DB adapter·옵션·sweep import를 새 subpath로 옮기고 PG의 @types/pg 설치를 명시한다. README 설치/경로/생성자 오기는 S2에서 수정했으며 sweep DI 연결·recipe 검증은 S7에 남는다.
- S8: `npm run test:consumers -- --tarball <동일 artifact>`를 최종 Node/Nest matrix와 필수 DB 게이트에 연결한다. summary/lockfile/로그/checksum을 CI artifact로 보존하고 게시 입력과 연결한다. 실행기 기본 서비스 누락 실패를 유지한다.
- 다음 행동: S3~S6 구현 후 공개 타입 변경을 fixture에 반영하고 S7/S8에서 최종 통합한다. 이 기록을 S8 또는1.0 출시 승인으로 해석하지 않는다.

### S3 공개 타입 인수인계 (2026-10-07)

`IdempotencyScope`의 함수 반환을 `string | readonly string[]`로 확장했다. 추가 export는 없고
기존 root 타입 경계를 유지한다. 함수는 endpoint를 대체하지 않고 identity를 추가한다.
`test/consumers/common/public-api.ts`에 readonly tuple 소비 예제를 반영했다.
S3 tarball 소비자 검증 결과는 [S3 기록](S3-request-isolation.md)을 따른다.
