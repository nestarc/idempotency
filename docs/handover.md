# @nestarc/idempotency — 핸드오버 문서

> **작성일**: 2026-04-09
> **목적**: 다음 세션(Claude Code 등)에서 바로 구현을 시작할 수 있도록 설계 결정사항과 컨텍스트를 정리
> **관련 인프라**: npm org `@nestarc`, 도메인 `nestarc.dev`, GitHub org/repo 미정

---

## 1. 해결하는 문제

POST/PATCH 같은 비멱등 HTTP 메서드에서 **동일한 요청이 여러 번 처리되는 것을 방지**한다.

발생 시나리오:
- 클라이언트의 네트워크 타임아웃 → 사용자가 버튼 재클릭
- API Gateway / 로드밸런서의 자동 retry
- 모바일 앱의 네트워크 불안정으로 인한 자동 재전송
- 마이크로서비스 간 메시지 중복 처리

결과: 이중 결제, 중복 주문 생성, 데이터 불일치 등

---

## 2. IETF 표준 근거

**`draft-ietf-httpapi-idempotency-key-header-07`** (2025-10, IETF HTTPAPI WG)

핵심 스펙:
- 클라이언트가 `Idempotency-Key` 헤더에 UUID v4 등의 고유값을 전송
- 서버는 키를 식별 → fingerprint 생성(선택) → 중복 여부 판단
- **첫 요청**: 정상 처리 후 결과를 키와 함께 저장
- **완료 후 재요청**: 저장된 결과를 그대로 리플레이 (같은 status code + body)
- **처리 중 재요청**: `409 Conflict` 응답
- **같은 키 + 다른 payload**: `422 Unprocessable Entity` 응답
- 서버는 키의 TTL(만료 정책)을 정의하고 문서화해야 함

참조: https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/

---

## 3. 기존 솔루션 분석

### 3.1 `@node-idempotency/nestjs`
- NestJS 인터셉터로 구현
- Redis / in-memory 어댑터
- 주간 다운로드 미미 (수백 수준)
- **약점**: 응답 리플레이가 불완전, fingerprint 미지원, 에러 시나리오 처리 부족, 문서 빈약

### 3.2 `@nestjs-redisx/idempotency` (nestjs-redisx 모노레포의 일부)
- Redis 전용, redisx 에코시스템에 묶임
- fingerprinting + response replay 지원
- **약점**: Redis 필수 (PostgreSQL만 쓰는 팀은 사용 불가), 독립 사용 불가

### 3.3 직접 구현 (블로그 패턴)
- 대부분의 개발자가 미들웨어/인터셉터를 직접 작성
- 레이스 컨디션 처리, 락 관리, TTL, 에러 핸들링 등에서 실수 다발
- 프로젝트마다 반복 구현

### 3.4 차별화 포인트
| 기능 | node-idempotency | nestjs-redisx | **@nestarc (목표)** |
|------|:-:|:-:|:-:|
| NestJS 데코레이터 | ✅ | ✅ | ✅ |
| Redis 스토어 | ✅ | ✅ | ✅ |
| PostgreSQL 스토어 | ❌ | ❌ | ✅ |
| In-memory 스토어 | ✅ | ❌ | ✅ |
| 응답 리플레이 (status + headers + body) | 부분 | ✅ | ✅ |
| Request fingerprint | ❌ | ✅ | ✅ |
| 동시 요청 락 (race condition) | 부분 | ✅ | ✅ |
| IETF draft 준수 에러 코드 | ❌ | ❌ | ✅ |
| forRoot/forRootAsync 패턴 | ✅ | ✅ | ✅ |
| 독립 패키지 (외부 의존 없음) | ✅ | ❌ | ✅ |
| @nestarc/tenancy 연동 | ❌ | ❌ | ✅ (향후) |

---

## 4. 설계 — API 인터페이스

### 4.1 모듈 등록

```typescript
// app.module.ts
import { IdempotencyModule } from '@nestarc/idempotency';

@Module({
  imports: [
    IdempotencyModule.forRoot({
      storage: {
        type: 'redis',             // 'redis' | 'postgres' | 'memory'
        // Redis 옵션
        redis: {
          host: 'localhost',
          port: 6379,
        },
        // 또는 PostgreSQL 옵션 (Prisma 활용)
        // prisma: prismaServiceInstance,
      },
      ttl: 86400,                  // 키 만료 시간 (초), 기본 24시간
      headerName: 'Idempotency-Key', // 커스텀 헤더명 (기본값 IETF 표준)
      fingerprint: true,           // request body 기반 fingerprint 생성 여부
      lockTimeout: 10000,          // 동시 요청 락 대기 시간 (ms)
    }),
  ],
})
export class AppModule {}
```

### 4.2 Async 등록 (ConfigService 연동)

```typescript
IdempotencyModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    storage: {
      type: config.get('IDEMPOTENCY_STORAGE', 'redis'),
      redis: {
        host: config.get('REDIS_HOST'),
        port: config.get('REDIS_PORT'),
      },
    },
    ttl: config.get('IDEMPOTENCY_TTL', 86400),
  }),
}),
```

### 4.3 데코레이터 사용

```typescript
import { Idempotent } from '@nestarc/idempotency';

@Controller('payments')
export class PaymentController {
  
  // 기본 사용 — Idempotency-Key 헤더 필수
  @Post()
  @Idempotent()
  async createPayment(@Body() dto: CreatePaymentDto) {
    return this.paymentService.process(dto);
  }

  // 옵션 오버라이드 — 이 엔드포인트만 TTL 다르게
  @Post('refunds')
  @Idempotent({ ttl: 3600 })
  async createRefund(@Body() dto: CreateRefundDto) {
    return this.refundService.process(dto);
  }

  // 헤더 없어도 허용 (optional 모드)
  @Post('logs')
  @Idempotent({ required: false })
  async createLog(@Body() dto: CreateLogDto) {
    return this.logService.create(dto);
  }
}
```

### 4.4 플로우 다이어그램

```
Client Request (with Idempotency-Key header)
    │
    ▼
[IdempotencyInterceptor]
    │
    ├─ 1. 헤더에서 키 추출
    │     └─ 키 없음 + required=true → 400 Bad Request
    │
    ├─ 2. 스토리지에서 키 조회
    │     ├─ 키 존재 + status=COMPLETED
    │     │   ├─ fingerprint 일치 → 저장된 응답 리플레이 (기존 status code)
    │     │   └─ fingerprint 불일치 → 422 Unprocessable Entity
    │     │
    │     ├─ 키 존재 + status=PROCESSING
    │     │   └─ 409 Conflict (처리 중)
    │     │
    │     └─ 키 없음 → 3단계로
    │
    ├─ 3. 락 획득 (키 + status=PROCESSING 저장)
    │     └─ 락 실패 → 409 Conflict
    │
    ├─ 4. 컨트롤러 핸들러 실행 (비즈니스 로직)
    │
    ├─ 5a. 성공 → 응답 저장 (status=COMPLETED, statusCode, headers, body)
    │
    └─ 5b. 실패 → 키 삭제 (재시도 가능하게)
         └─ 단, 비즈니스 에러(4xx)는 저장할 수도 있음 (옵션)
```

---

## 5. 스토리지 어댑터 설계

### 5.1 인터페이스

```typescript
interface IdempotencyRecord {
  key: string;                   // Idempotency-Key 값
  fingerprint?: string;          // SHA-256 of request body
  status: 'PROCESSING' | 'COMPLETED';
  statusCode?: number;           // 저장된 응답 status code
  responseHeaders?: Record<string, string>;  // 저장할 헤더 (선택)
  responseBody?: string;         // JSON serialized 응답 body
  createdAt: Date;
  expiresAt: Date;
}

interface IdempotencyStorage {
  /**
   * 키 조회. 없으면 null 반환.
   */
  get(key: string): Promise<IdempotencyRecord | null>;

  /**
   * 키 생성 (PROCESSING 상태). 이미 존재하면 false 반환 (락 역할).
   */
  create(key: string, fingerprint?: string, ttl?: number): Promise<boolean>;

  /**
   * COMPLETED 상태로 업데이트 + 응답 저장.
   */
  complete(key: string, response: {
    statusCode: number;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<void>;

  /**
   * 키 삭제 (처리 실패 시 재시도 허용).
   */
  delete(key: string): Promise<void>;
}
```

### 5.2 Redis 어댑터 (MVP 우선)
- `SET key value NX EX ttl` 로 원자적 락 + 생성
- Hash에 응답 데이터 저장
- TTL은 Redis의 EXPIRE로 자동 관리

### 5.3 PostgreSQL 어댑터
- `idempotency_keys` 테이블
- `INSERT ... ON CONFLICT DO NOTHING` 으로 원자적 락
- `expires_at` 컬럼 + cron/pg_cron으로 정리
- Prisma Client Extensions 또는 raw query

### 5.4 In-Memory 어댑터
- `Map<string, IdempotencyRecord>` + `setTimeout` TTL
- 개발/테스트용, 프로덕션 비권장
- 단일 인스턴스에서만 동작

---

## 6. MVP 스코프 (v0.1.0)

### 포함
- [x] `IdempotencyModule.forRoot()` / `forRootAsync()`
- [x] `@Idempotent()` 데코레이터
- [x] `IdempotencyInterceptor` (핵심 로직)
- [x] Redis 스토리지 어댑터
- [x] In-Memory 스토리지 어댑터
- [x] Request fingerprint (SHA-256 of body)
- [x] 응답 리플레이 (statusCode + body)
- [x] 동시 요청 처리 (409 Conflict)
- [x] IETF draft 에러 코드 준수 (400, 409, 422)
- [x] TTL 설정 (글로벌 + 엔드포인트별 오버라이드)
- [x] README + 기본 예제

### v0.2.0 (출시 완료)
- [x] PostgreSQL 스토리지 어댑터 (`pg` peer dependency, Prisma 비의존)
- [x] `PostgresSweepService` — opt-in 만료 레코드 정리 (`pg_try_advisory_lock` 기반 멀티-레플리카 세이프)
- [x] 번들 SQL DDL (`sql/init.sql`) + `PostgresStorage.createSchema()` 코드 헬퍼 + `autoCreateSchema` 모듈 옵션
- [x] CI Postgres 16 서비스 컨테이너 + v0.1.3 회귀 테스트 패리티

### v0.3.0 이후
- [ ] Transactional integration (`@TransactionalIdempotent`) — 비즈니스 INSERT와 idempotency complete를 하나의 DB 트랜잭션으로 묶기
- [ ] 멀티-Postgres 메이저 CI 매트릭스 (12, 14, 16, 17)
- [ ] Optional JSONB body storage (쿼리 가능한 응답 검사)
- [ ] 응답 헤더 저장/리플레이
- [ ] `@nestarc/tenancy` 연동 (테넌트별 키 격리)
- [ ] Swagger/OpenAPI 데코레이터 자동 적용
- [ ] 커스텀 fingerprint 함수 지원
- [ ] 메트릭 (히트율, 충돌율)
- [ ] 비즈니스 에러 캐싱 옵션

---

## 7. 프로젝트 구조

```
@nestarc/idempotency/
├── src/
│   ├── index.ts                        # public API exports
│   ├── idempotency.module.ts           # NestJS DynamicModule
│   ├── idempotency.interceptor.ts      # 핵심 인터셉터
│   ├── idempotency.decorator.ts        # @Idempotent() 데코레이터
│   ├── idempotency.constants.ts        # injection tokens, 기본값
│   ├── interfaces/
│   │   ├── idempotency-options.interface.ts
│   │   ├── idempotency-record.interface.ts
│   │   └── idempotency-storage.interface.ts
│   └── storage/
│       ├── redis.storage.ts
│       ├── memory.storage.ts
│       └── postgres.storage.ts         # v0.2.0
├── test/
│   ├── idempotency.interceptor.spec.ts
│   ├── redis.storage.spec.ts
│   ├── memory.storage.spec.ts
│   └── e2e/
│       └── idempotency.e2e-spec.ts
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── jest.config.ts
├── .eslintrc.js
├── .prettierrc
├── LICENSE                             # MIT
└── README.md
```

---

## 8. 기술 스택 / 공통 규격

`@nestarc` 패키지 공통 규격 적용:

- **런타임**: Node.js 20+
- **NestJS**: 10.x / 11.x 호환
- **TypeScript**: 5.4+
- **패턴**: `forRoot()` / `forRootAsync()` 모듈 등록
- **테스트**: Jest + @nestjs/testing
- **문서**: TSDoc + README
- **CI/CD**: GitHub Actions → npm publish
- **라이선스**: MIT

### 의존성
- **필수**: `@nestjs/common`, `@nestjs/core` (peer)
- **선택**: `ioredis` (Redis 어댑터 사용 시, peer)
- **선택**: `@prisma/client` (PostgreSQL 어댑터 사용 시, peer)
- **내장**: 없음 (crypto는 Node.js 내장)

---

## 9. 핵심 구현 포인트

### 9.1 인터셉터에서 응답 캡처
NestJS의 `CallHandler`를 통해 `Observable`을 구독하고, `tap()` 또는 `map()` 으로 응답을 가로채서 저장해야 한다. `ExecutionContext`에서 response 객체의 statusCode도 함께 캡처.

### 9.2 에러 처리
- 컨트롤러에서 throw된 HttpException → catch하고 키 삭제 (재시도 허용)
- 단, 옵션에 따라 4xx 비즈니스 에러는 캐싱할 수도 있음 (예: "이미 처리된 환불" 같은 응답)

### 9.3 Fingerprint
- `crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')`
- 같은 키 + 다른 body → IETF 스펙에 따라 422 응답

### 9.4 Redis 락 패턴
```
SET idempotency:{key} {value} NX EX {lockTimeout}
```
- NX: 키가 없을 때만 설정 (원자적)
- EX: 락 타임아웃 (처리 중 서버 크래시 대비)
- 완료 후: Hash로 업데이트 + EXPIRE로 TTL 재설정

### 9.5 데코레이터 메타데이터
```typescript
export const IDEMPOTENT_KEY = 'IDEMPOTENT_OPTIONS';

export function Idempotent(options?: IdempotentOptions): MethodDecorator {
  return SetMetadata(IDEMPOTENT_KEY, { enabled: true, ...options });
}
```
인터셉터에서 `Reflector.get(IDEMPOTENT_KEY, handler)` 로 조회.

---

## 10. 타겟 사용자 & 마케팅

- **1차 타겟**: 핀테크, 이커머스, SaaS 백엔드 개발자
- **키워드**: nestjs idempotency, nestjs idempotent api, nestjs duplicate request
- **경쟁 우위 메시지**: "IETF 표준 준수, 데코레이터 한 줄, Redis/PostgreSQL 선택"
- **홍보 채널**: npm README, dev.to 영문 블로그, nestarc.dev 문서, Reddit r/nestjs

---

## 11. 참고 자료

- IETF Draft: https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/
- IETF GitHub: https://github.com/ietf-wg-httpapi/idempotency
- 경쟁 패키지: https://www.npmjs.com/package/@node-idempotency/nestjs
- 경쟁 패키지: https://github.com/nestjs-redisx/nestjs-redisx (idempotency 플러그인)
- NestJS Interceptors: https://docs.nestjs.com/interceptors
- NestJS Custom Decorators: https://docs.nestjs.com/custom-decorators

---

## 12. 다음 세션에서 할 일

1. GitHub 레포 생성 (네이밍: `nestjs-idempotency` 또는 nestarc 모노레포 내)
2. 프로젝트 스캐폴딩 (package.json, tsconfig, jest, eslint)
3. 인터페이스 정의 (`IdempotencyStorage`, `IdempotencyRecord`, `IdempotencyOptions`)
4. `MemoryStorage` 구현 (테스트 우선 개발)
5. `IdempotencyInterceptor` 핵심 로직 구현
6. `@Idempotent()` 데코레이터 구현
7. `IdempotencyModule` 모듈 등록 로직
8. 단위 테스트 작성
9. `RedisStorage` 구현
10. E2E 테스트
11. README 작성
12. npm publish (`@nestarc/idempotency`)

---

*이 문서는 2026-04-09 nestarc.dev 생태계 확장 리서치 세션에서 작성되었으며, Claude Code 또는 다른 세션에서 구현을 이어갈 때 컨텍스트로 활용한다.*

---

## v0.2.0 — PostgreSQL storage adapter (shipped)

Adds `PostgresStorage` and `PostgresSweepService`. Full design:
[postgres-storage-spec.md](./postgres-storage-spec.md). Implementation
plan: [superpowers/plans/2026-05-02-postgres-storage-adapter.md](./superpowers/plans/2026-05-02-postgres-storage-adapter.md).

Future work tracked for v0.3.0:
- Transactional integration (`@TransactionalIdempotent`) so business
  inserts and idempotency completion share one DB transaction.
- Multi-Postgres-major CI matrix (12, 14, 16, 17).
- Optional JSONB body storage for query-friendly inspection.