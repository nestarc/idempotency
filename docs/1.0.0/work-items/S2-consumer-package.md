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

## 구현 전 결정

| 미결 사항 | 결정할 내용 |
| --- | --- |
| optional 타입 경계 | 루트 API 유지, 공식 어댑터 subpath 분리 등 대안을 비교하고 최소 설치 계약을 확정한다. |
| pg 타입 제공 | 패키지 책임과 소비자의 `@types/pg` 설치 책임을 결정한다. Memory 소비자에게 요구하지 않는다. |
| 공개 import 경로 | 기존 루트 export를 변경한다면 0.4→1.0 마이그레이션과 기존 사용 영향도 기록한다. |
| 지원 컴파일 환경 | 최소 TypeScript 버전과 moduleResolution 검증 범위를 정한다. 모든 모드 지원을 암묵적으로 약속하지 않는다. |

공통 결정 **D02**에 대안·호환성·선택 근거를 기록하고 `OPEN`에서 `DECIDED`로 갱신한다.
새 API 형태는 여기서 확정하지 않으며, 결정 자체가 별도 사용자 승인을 요구한다는 뜻은 아니다.

## 작업 체크리스트

- [ ] **S2-1** Memory/Redis/PG 소비자 fixture와 격리 실행기를 만들고 baseline 실패를 자동 재현한다.
- [ ] **S2-2** root import의 eager pg 의존성을 제거하고 선택 드라이버 누락 시점·오류 메시지를 검증한다.
- [ ] **S2-3** 선언 파일의 선택 의존성 경계를 결정·구현하고 `skipLibCheck: false` 검사를 통과시킨다.
- [ ] **S2-4** 공개 옵션·callback·event 타입을 공식 경로에서 import하는 컴파일 검사를 추가한다.
- [ ] **S2-5** tarball에 runtime JS, declarations, 필요한 SQL/README/LICENSE가 포함되는지 확인한다.
- [ ] **S2-6** 기존 root import 소비자와 새 설치 경로를 비교하여 마이그레이션 요구를 S7에 전달한다.
- [ ] **S2-7** 실행기 명령, fixture 위치, dependency 버전, 성공/실패 로그를 S8에서 재사용하도록 정리한다.

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
- 소비자 fixture와 실행기는 아직 없다. 구현 후 여기에 실제 경로를 추가한다.

## 검증 명령과 환경

저장소 루트에서 `npm ci`, `npm run build`, `npm pack --json`을 실행한다.
소비자별로 `npm ci`, `npx tsc --noEmit -p tsconfig.json`, 선언한 Node/Nest 시작 검사를 실행한다.
fixture의 lockfile 생성·tarball 설치·명령 연결은 S2-1에서 자동화하고 최종 명령을 이 절에 기록한다.
의존성 설치에는 registry 접근이, HTTP 부팅 검사에는 로컬 포트 사용이 필요하다.
네트워크나 서비스 미제공으로 생략한 검사는 미검증으로 기록한다. pack dry-run만으로 S2를 완료하지 않는다.

## 호환성과 다른 작업 인계

S4의 event 의미와 S5/S6의 storage 계약은 관련 타입 변경 가능성을 S2에 전달한다.
S2는 import·dependency 변경을 S7에, 재현 가능한 tarball 소비자 실행기를 [S8](S8-release-validation.md)에 인계한다.
S8 최종 matrix 결과가 나오기 전에는 전체 지원 환경을 검증했다고 기록하지 않는다.

## 다음 작업자에게

- 초기 기록: 구현 미착수. 마지막 갱신 2026-10-06.
- 다음 행동: S2-1의 격리 Memory fixture를 선언하고 baseline tarball의 import/타입 실패부터 고정한다.
- 남은 이슈: optional peer 타입 경계와 기존 루트 export 호환 정책 미결.
- 구현 검증 증거: 미기록. 조사 재현과 구분해 `대상 commit / tarball·checksum / 환경 / 명령 / pass·fail·skip / 제한`을 기록한다.
