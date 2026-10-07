# S8 — 출시 검증

- 상태: [작업판](../README.md) 참조. 이 파일은 출시 증거와 검증 연결을 관리한다.
- 조사일: 2026-10-06 · baseline: `9610774` (`@nestarc/idempotency` 0.4.0).
- 근거: [안정화 조사](../../1.0.0-stabilization-research.md)의 출시 범위·검증 한계 항목.
- 착수 조건: CI 골격은 병행 개발 가능. 최종 완료는 S1–S7 완료와 통합 검증을 선행 조건으로 한다.

## 목적

소스 테스트 성공에서 끝나지 않고, 소비자가 받을 같은 배포물이 지원 환경에서 동작함을 확인한다.
release 경로에서 실제 DB 검사가 빠지지 않도록 만들고, 검증한 commit·artifact를 추적할 수 있게 한다.
이번 요청은 문서 작성이다. 이 문서를 읽었다는 이유로 실제 publish, tag 생성, push를 실행하지 않는다.

## 확인된 근거와 재현 절차

기존 CI는 Node 20/22 × Nest 10/11을 검사하며, 실제 Redis smoke와 Postgres 서비스가 이미 있다.
release의 build-and-test 잡은 PG만 제공하므로 `TEST_REDIS_URL` 없는 Redis spec은 skip된다.
release publish 잡은 다른 Node 환경에서 다시 build하므로 앞서 검증한 tarball을 그대로 게시하는 구조가 아니다.
pack dry-run은 파일 구성 점검이며 설치/import/선언 파일 안전성을 입증하지 않는다.
2026-10-06 공식 Node 표는 20을 EOL, 22/24를 LTS로 표시했다. 지원 정책은 구현 전에 확정한다.
조사 baseline은 Node 24.11.1/npm 11.6.2에서 15 suite 통과, 6 skip; 198 test 통과, 39 skip이었다.
skip은 PG 관련 28개·실제 Redis 11개이며 Docker daemon 부재 때문에 실행하지 못했다.

1. 새 checkout에서 `npm ci`를 수행하고 Node/npm/commit을 기록한다. 기존 개발자의 설치 상태에 의존하지 않는다.
2. 환경 변수 없이 DB spec이 skip되는 현재 경로를 확인한다. 실패 재현 결과이지 출시 성공 조건이 아니다.
3. 테스트 전용 PG 16/Redis 7을 준비하고 두 URL을 설정한 전체 suite와 S6 계약 검사를 실행한다.
4. S2가 제공할 저장소 내 consumer fixture와 실행기로 실제 tarball의 설치·타입·부팅을 검사한다.
5. release workflow의 검증 전용 경로에서 DB 누락과 fixture 실패가 출시 게이트를 차단하는지 확인한다.
6. 같은 commit의 tarball checksum과 소비자 검사 결과를 보존하고, 게시 단계가 해당 artifact를 사용하도록 연결한다.

fixture dependency/lockfile/스크립트는 저장소에 선언한다. 조사자의 `/tmp` 파일이나 형제 저장소를 참조하지 않는다.

## 포함·제외 범위

- 포함: 지원 Node/Nest/HTTP adapter matrix, 실DB 검사, tarball 소비자 검사, 필수 검사 skip 감지.
- 포함: 테스트한 commit·artifact와 게시 입력의 일치, 검증 전용 실행 경로, RC 체크리스트와 결과 기록.
- 포함: 기존 Postgres/Redis 서비스 잡을 재사용하거나 공통화하여 tag 검증과 일반 CI의 차이를 줄이기.
- 제외: 이 문서 작업 중 실제 릴리스, registry 인증 변경, npm publish, tag/push, 별도 장기 성능 프로젝트.
- 제외: 실패한 S1–S7을 검증 예외로 승인하거나 skip을 통과로 바꾸는 작업.

## 구현 전 결정

| 미결 사항 | 결정할 내용 |
| --- | --- |
| Node 지원 정책 | 22/24 필수 검사, Node 20 유지 여부, engines/문서/CI의 일치. |
| 지원 matrix | Nest 10/11과 Express/Fastify, 선택 peer 하한·대표 버전 검사의 범위와 비용. |
| artifact 경로 | 한 번 만든 tarball의 검증·보존·게시 방법과 lifecycle script 재실행에 대한 처리. |
| 실패/skip 게이트 | 환경 누락, 연결 실패, 필수 spec 미발견, 실행 수 감소를 검출할 방식. |
| RC 운영 검증 | 실제 참여 팀/환경, 관찰 기간, 통과·보류 기준. 도입팀이 없으면 외부 검증 미실시로 남긴다. |

공통 결정 **D08**에 지원 matrix·artifact 대안·선택 근거를 기록하고 `OPEN`에서 `DECIDED`로 갱신한다.
결정 자체가 별도 사용자 승인을 요구한다는 뜻은 아니다. CI 작성 전에 게시 경로를 변경했다고 간주하지 않는다.

## 작업 체크리스트

- [ ] **S8-1** 지원 matrix를 확정하고 package engines·문서·CI의 차이를 정리한다.
- [ ] **S8-2** 일반 CI와 release 검증에서 PG/Redis 준비·health check·URL 전달을 일치시킨다.
- [ ] **S8-3** DB 서비스/URL 누락과 필수 테스트 skip을 명시적으로 실패시키는 검증을 추가한다.
- [ ] **S8-4** S2 consumer fixture를 동일 tarball로 실행하고 설치 목록·컴파일·부팅 결과를 수집한다.
- [ ] **S8-5** tarball checksum/commit 기록과 검증 artifact 전달 경로를 구성한다.
- [ ] **S8-6** S1–S7 회귀와 문서 recipe 검증을 모두 연결하고 정상·실패 경로를 검증 전용으로 실행한다.
- [ ] **S8-7** JSON 단일 사용자 API, multi-tenant API, PG webhook의 RC 시나리오와 검증 기록을 준비한다.
- [ ] **S8-8** 미해결 결함/미검증 환경을 정리하고 별도 출시 결정에 사용할 증거를 제출한다.

## 완료 조건

- S1–S7이 작업판의 완료 조건을 충족하고, 최종 commit에서 전체 통합 검증을 수행했다.
- 결정한 지원 matrix에서 Nest 10/11 및 Express/Fastify 경로가 검증된다.
- tag 대상 commit의 검증 경로에서 실제 PG·Redis 필수 검사가 실행되며 skip 수를 명시적으로 확인한다.
- Memory-only/Redis-only/PG-only 소비자가 동일 tarball을 설치하고 import·strict TS·Nest 부팅/종료를 통과한다.
- pack 내용에 필수 SQL/JS/declarations가 있고 검증한 artifact와 게시 입력의 checksum이 연결된다.
- 서비스 누락·소비자 fixture 실패·검증 artifact 누락을 의도적으로 주었을 때 게이트가 실패한다.
- RC/외부 도입 검증은 수행 여부와 한계를 분리 기록하며, 실제 publish 없이도 검증 흐름을 점검할 수 있다.

## 관련 파일

- [CI workflow](../../../.github/workflows/ci.yml), [Release workflow](../../../.github/workflows/release.yml), [package.json](../../../package.json).
- [Jest 설정](../../../jest.config.ts), [PG compose](../../../docker-compose.yml), [Express E2E](../../../test/e2e/idempotency.e2e-spec.ts).
- [Fastify E2E](../../../test/e2e/fastify.e2e-spec.ts), [PG E2E](../../../test/e2e/postgres.e2e-spec.ts), [실제 Redis spec](../../../test/storage/redis.storage.real.spec.ts).
- [S2 소비자 배포물 작업](S2-consumer-package.md), [S6 공통 계약 작업](S6-storage-contract.md). S2 fixture 실행 명령은 `npm run test:consumers -- --tarball <artifact>`이며 S6 변경을 같은 artifact에 반영한다.

## 검증 명령과 환경

저장소 루트에서 `npm ci`, `npm run lint`, `npx tsc --noEmit -p tsconfig.json`, `npm run build`를 실행한다.
테스트 전용 `TEST_DATABASE_URL`, `TEST_REDIS_URL`을 설정한 뒤 `npm run test:all -- --runInBand`를 실행한다.
전체 prepublish 검사는 두 URL이 설정된 환경에서 `npm run prepublishOnly`로 확인할 수 있다. 이 명령 자체는 게시하지 않는다.
`npm pack --json`으로 만든 tarball에 S2 소비자 실행기를 적용하고 실제 명령·checksum을 결과에 기록한다.
PG는 기존 compose 서비스를 사용할 수 있다. 현재 compose에는 Redis가 없으므로 CI의 Redis 7 구성 또는 별도 테스트 서비스를 준비한다.
DB DDL/전용 prefix 정리 권한, registry 접근, 로컬 HTTP 포트가 필요하다. 운영 서비스에 테스트를 실행하지 않는다.
실DB skip, 포트/네트워크 제약, 설치 실패는 원인과 미검증 범위를 기록한다. green exit만으로 완료하지 않는다.
실제 publish/tag/push 및 release workflow dispatch는 이 문서의 검증 명령에 포함하지 않는다.

## 호환성과 다른 작업 인계

S2의 package 경계, S6의 상태 계약, S7의 실행 예제와 마이그레이션 절차를 한 commit에서 검증한다.
지원 버전 축소나 배포 artifact 변경은 S7의 설치·업그레이드 문서와 함께 갱신한다.
검증 기록 형식은 `대상 commit / artifact·checksum / 환경(Node·npm·DB) / 명령 / pass·fail·skip / 제한`으로 통일한다.

## 다음 작업자에게

### S4 관측 검증 인수인계 (2026-10-07)

[D04](../decisions.md#d04--관측-정보-보호-decided)의 공개 event는 namespace/keyHash와
고정 error code/operation만 전달하며 event.scope 및 원본 Error payload를 제거했다.
S2 공통 fixture는 새 root 타입과 제거된 필드의 컴파일 기대 오류를 검사한다.
S4 관측 회귀는 전체 event/logger 인자에 심은 가짜 비밀 값, 각 storage 단계의 동기 throw/rejection,
이벤트 횟수, callback 실패 격리, status header enable/disable과 legacy 저장 헤더의 재생 차단을 다룬다.
검증 명령·실제 pass/fail/skip·artifact는 [S4 작업 기록](S4-observability.md)을 참조한다.
이 인계 자체는 새 실행 증거가 아니며 이전 S2 tarball 결과를 변경된 타입의 검증으로 재사용하지 않는다.

S5는 미착수/D05 OPEN, S6도 미완료다. S5/S6의 최종 오류·만료 상태 전이를 반영한 commit에서
관측 회귀와 같은 tarball의 소비자 타입 검사를 다시 실행한다. fake storage 장애 결과는
실제 Redis/PG 장애 주입이나 crash/불명 쓰기 복구 증거를 대신하지 않는다.
실제 DB 생략 여부, 최종 지원 matrix, RC/출시 판단은 기존 S8 gate를 따른다.

### S2 인수인계 (2026-10-06)

[소비자 실행기](../../../scripts/consumer-package.mjs)와 [fixture 안내](../../../test/consumers/README.md)를 추가했다.
`npm run test:consumers -- --tarball /absolute/path/package.tgz`로 게시 후보와 같은 artifact를 설치한다.
옵션 없이 실행하면 build/pack까지 수행한다. TEST_REDIS_URL/TEST_DATABASE_URL을 모두 제공해야 실제 DB 필수 검사에 통과한다.
`--skip-services`는 명시적인 부분 검사이며 summary.result가 pass-with-skips다. 출시 gate는 이를 성공으로 인정하지 않는다.
실행은 소스 밖에서 lockfile 생성·npm ci·npm ls·선택 peer 부재·strict 공개 타입·Node import·Nest init/close·DB CRUD를 검사한다.
NODE_PATH/전역 경로·상위 node_modules·symlink 누출을 방지한다.

fixture는 Nest11.1.18, TS5.7.3, @types/node20.19.39, ioredis5.10.1, pg/@types/pg8.20.0으로 직접 의존성을 고정했다.
PG는 @types/pg 미설치 TS7016을 기대된 실패로 검사한 뒤 명시적으로 타입을 설치한다.
TS5.4.5 후보는 현재 pg-protocol1.16.1과의 generic Buffer 선언 호환 문제로 실패하여 D02 하한을5.7.3으로 정했다.
전체 개발 테스트는 실제 Redis7.2.7/PG16.14에서 **26 suite / 351 pass / 0 skip**이다.
최종 소비자 결과와 checksum·실행 로그는 [S2 증거](S2-consumer-package.md#검증-증거--2026-10-06) 및
[보존 JSON](../evidence/S2-validation.json)을 참조한다.

S8에서 각 matrix 셀의 dependency 버전 선택을 연결하고 생성된 소비자 lockfile·npm ls·summary·로그·tarball을 CI artifact로 보존한다.
검증한 SHA-256과 게시할 입력을 일치시킨다. 현재 runner가 자동으로 지원 matrix 전체나 workflow를 변경하지는 않는다.
S1 시점41 skip은 이번 대표 실제 DB 환경에서 해소됐지만 S8의 최종 지원 조합/RC/출시 검증 완료를 뜻하지 않는다.


### S1 인수인계 (2026-10-06)

[S1 검증](S1-response-replay.md#검증-증거-2026-10-06)은 Node24.11.1/Nest11.1.18,
Express adapter11.1.18/Fastify adapter11.1.19 및 class-transformer0.5.1 환경에서
prepublishOnly와 타입 검사 통과다. 전체 **293 pass / 41 skip**(실제 PG29·Redis12).
새 실제 HTTP 회귀28개는 `test/regression/response-replay-http.spec.ts`에 있어 unit project에 포함된다.
형식/완료/boundary 회귀와 opaque body 공통 계약도 전체 pipeline에 포함된다.
Nest10·Node20/22·실제 PG/Redis opaque body 보존·tarball 소비자를 아직 검증하지 않았다.
이제 기존 조사 baseline39 skip 대신 현행41 skip을 기준으로 환경을 복구하고 출시 gate에서 skip을 막는다.
S1 완료는 S8 또는 1.0 출시 승인으로 해석하지 않는다.

- 초기 기록: 구현 미착수. 마지막 갱신 2026-10-06.
- 다음 행동: S8-1 지원 matrix를 결정하고 S8-2의 검증 전용 PG/Redis 잡 골격부터 준비한다.
- 남은 이슈: 지원 정책·artifact 게시 방식 미결; S3–S7 완료와 최종 지원 matrix 통합 검증 대기. S2 대표 환경 증거는 위 인계 참조.
- S8 자체 구현 검증 증거: 미기록. 위 S1 결과의41개 skip을 최종 출시 통과로 재사용하지 않는다.
