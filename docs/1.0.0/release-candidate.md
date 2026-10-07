# 1.0 RC 시나리오와 출시 증거

이 문서는 S8의 재현 가능한 자동 검사와 도입팀의 RC 관찰 기록을 연결한다.
현재 package version은 출시 준비용 1.0.0이며 RC 또는 1.0을 게시하지 않았다.
S8의 기존 검증 tarball은 bump 이전 0.4.0이므로 최종 1.0.0 artifact는 공통 gate를 다시 실행한다.
자동 검사 결과는 [S8](work-items/S8-release-validation.md)와 [검증 JSON](evidence/S8-validation.json)을 따른다.

## 공통 시작 조건

1. S1~S7 완료, D01~D08 결정, 대상 commit과 tarball SHA-256을 고정한다.
2. Node22/24 × Nest10/11 × 선택 peer 하한/대표 8개 cell에서 같은 tarball을 검사한다.
3. 각 cell의 실제 PG16/Redis7 접속·전체 suite·소비자 compile/import/부팅/종료와 skip=0을 확인한다.
4. tarball/manifest 및 소비자 lockfile·npm ls·로그·Jest JSON·crash JSON을 보존한다.
5. RC 운영 환경에서는 [D07 전환 절차](../migration-1.0.md)의 빈 namespace, writer fencing,
   durable 업무 ID, 불명 결과 조정과 rollback 전제를 먼저 확인한다.

## 시나리오

| 시나리오 | 자동 검사 | 관찰할 결과 | 보류 조건 |
| --- | --- | --- | --- |
| JSON 단일 사용자 API | tarball Memory quickstart, Express/Fastify HTTP 소비자; response-replay-http 및 idempotency E2E | 최초 요청 201/created, 동일 key/body의 동일 JSON replay, handler 1회; 다른 body 422, 처리 중 409; serializer 적용, 미지원 응답 계약 | 응답·status·header 불일치, handler 중복 실행, 종료 지연 |
| Multi-tenant API | request-isolation E2E 및 adoption-recipes의 tenant/user/endpoint 분리와 인증 | 같은 raw key라도 tenant/user/endpoint 간 결과 분리; replay 전 guard 재실행; 업무 ID 소유권 검증 | 다른 주체의 데이터 재생, guard 우회, 업무 history 소실 뒤 중복 실행 |
| PG webhook | tarball Postgres 실제 CRUD/owned·injected 종료/sweep, postgres E2E; PG 업무 원장 기반 signed webhook recipe | signature·timestamp 우선 검증, event-ID 중복 제거, 업무 uniqueness와 out-of-order projection 보호; replay cache 소실 뒤 durable inbox 확인 | 위조 이벤트 replay, 중복 업무 효과, 상태 역행, 기존 event의 변경 payload 허용 |
| 장애·재시도와 조정 | 실제 Redis/PG child SIGKILL 10건, complete 전후 acknowledgment 실패, TTL/native timer·상태 계약 | token·TTL·업무 원장과 client 결과 대조; 불명 업무를 자동 재시도하거나 강제 unlock하지 않음 | 원장과 기록 불일치 미조정, 유효 잠금 삭제, 안전하지 않은 rollback |

PG webhook 조합의 근거는 PG adapter E2E/소비자와 PG 업무 원장 recipe를 함께 검사한 것이다.
recipe HTTP fixture의 replay cache는 Memory이며, 실제 외부 webhook provider·production PG failover를
통합 관찰한 결과로 해석하지 않는다. 결제 provider는 로컬 simulator, 구 0.4 reader는 모델이다.

## 외부 RC 관찰 계획

참여 팀·환경은 아직 제공되지 않았다. 따라서 외부 도입/운영 RC는 **미실시**다.
도입팀이 생기면 아래 표를 채우고 팀의 실제 재전송·보존 기간을 반영해 관찰 기간을 정한다.
기본 계획은 staging에서 최소 48시간 및 해당 서비스의 최대 정상 retry 기간 중 더 긴 기간이다.
관찰 기간 충족만으로 불명 업무나 rollback 미검증을 승인하지 않는다.

| 기록 항목 | 현재 기록 |
| --- | --- |
| 참여 팀 / 담당 / 환경 | 미정 / 미정 / 미정 |
| 검증 commit / artifact SHA-256 | 자동 검사 기록 참조; 외부 RC 후보 미선정 |
| Node / npm / Nest / HTTP adapter / DB | 외부 RC 미실시 |
| 관찰 시작 / 종료 / retry horizon | 미정 |
| 트래픽 / 최초·replay·conflict·failure / skip | 미기록 |
| durable ledger·inbox 대조 / 불명 업무 조정 | 미실시 |
| D07 전환·rollback rehearsal | 미실시 |
| 결과 / 미해결 결함 / 담당 결정 | 외부 검증 미실시; 별도 출시 결정 필요 |

통과에는 응답 및 격리 계약 유지, durable 업무 중복 없음, 불명 업무 조정 완료, shutdown과
rollback rehearsal 성공, 필수 검증 skip=0이 필요하다. 하나라도 실패하면 원인과 담당·재검증
조건을 기록하고 보류한다. 외부 팀이 없다는 사실을 자동 검사 통과로 덮지 않는다.

## 검증 전용 게이트

`release.yml`의 수동 dispatch는 검증만 수행한다. 실제 게시 없이 CI와 같은 서비스를 준비하고
같은 8개 cell·tarball·artifact 집계를 실행한다. 로컬 재현 명령은
[CONTRIBUTING](../../CONTRIBUTING.md#validation-without-publishing)에 있다.

`npm run test:release-gates`는 URL 누락/접속 실패, skip/todo/필수 spec 누락/실행 수 감소,
소비자 실패·skip·summary 누락, artifact 누락·변조·잘못된 commit/version과 matrix 누락을
의도적으로 주고 실패하는지 확인한다. 이는 실제 registry 게시나 GitHub Actions 서버 실행의
증거가 아니다. 최종 tag 대상에서는 clean commit으로 전체 gate를 다시 실행한다.
