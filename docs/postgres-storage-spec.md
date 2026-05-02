# PostgreSQL Storage Adapter — 설계 스펙

- **Status**: Draft (v0.2.0 계획)
- **Owner**: nestarc
- **Target Release**: `@nestarc/idempotency` v0.2.0
- **마지막 업데이트**: 2026-05-02

---

## 1. 목적과 범위

### 1.1 목적

`@nestarc/idempotency`에 **PostgreSQL을 기반으로 하는 세 번째 스토리지 어댑터**를 추가한다. 기존 `MemoryStorage`(단일 프로세스), `RedisStorage`(분산 인메모리)에 더해, 이미 운영 중인 RDB만으로 멱등성을 충족할 수 있게 한다.

### 1.2 v0.2.0 범위

본 스펙이 다루는 작업:

1. `PostgresStorage` 클래스 구현 (`IdempotencyStorage` 인터페이스 준수)
2. SQL DDL 스크립트(`sql/init.sql`)
3. 옵트인 sweep 서비스 (`PostgresSweepService`)
4. 다중 스키마 마이그레이션 옵션 (SQL 파일, 코드 헬퍼, 자동 생성)
5. 테스트 (공유 컨트랙트 + 어댑터 전용 + e2e)
6. CI에 Postgres 서비스 컨테이너 통합 (Postgres 16)
7. README/CHANGELOG/벤치마크 갱신

### 1.3 v0.2.0에서 명시적으로 제외

다음은 본 릴리스에 포함하지 않으며 별도 마일스톤으로 분리:

- **트랜잭션 통합** (사용자 비즈니스 트랜잭션과 멱등성 레코드를 같은 트랜잭션으로 묶는 기능) → v0.3.0+ 로드맵
- **TypeORM/Prisma/Drizzle 어댑터** (모두 `pg` Pool로 추상화 가능하므로 별도 어댑터 불필요)
- **Postgres 12 미만 지원**
- **다중 Postgres 메이저 버전 매트릭스 CI** (v0.2.0은 16만 검증)

---

## 2. 설계 원칙

### 2.1 LSP 우선

신규 어댑터는 `IdempotencyStorage` 인터페이스의 **모든 행동 계약**을 충족해야 한다. `test/support/shared-storage-contract.ts`의 공유 컨트랙트 스위트를 그대로 통과시키는 것이 합격 기준.

핵심 불변식 3가지 (인터페이스 주석 기준):
1. **원자적 NX 생성** — 같은 키에 대한 동시 `create()` 두 건은 정확히 하나만 `acquired: true`
2. **토큰 기반 CAS** — `complete()` / `delete()`는 호출자의 토큰이 저장된 토큰과 일치할 때만 변이
3. **`createdAt` 불변성** — `complete()`가 원본 PROCESSING 레코드의 `createdAt`를 보존

### 2.2 Postgres의 강점 활용

- **단일 SQL 원자성**: 트랜잭션 없이도 단일 statement는 원자적 → Lua/Map 트릭 불필요
- **`ON CONFLICT ... RETURNING`**: NX-or-replace를 한 라운드트립에 처리
- **`xmax = 0` 이디엄**: INSERT vs UPDATE 구별을 추가 SELECT 없이 같은 쿼리에서 획득
- **`TIMESTAMPTZ + interval`**: TTL 계산을 DB가 책임 (시간 동기화 문제 회피)
- **PK 자체가 NX 제약**: 별도 인덱스/락 없이 충돌 감지

### 2.3 ORM-Agnostic

피어 의존성은 `pg`(node-postgres)만 추가. TypeORM, Prisma, Drizzle, Knex 사용자는 자신의 내부 `Pool`(또는 동등물)을 그대로 전달 가능.

---

## 3. 스키마

### 3.1 테이블 정의

```sql
CREATE TABLE IF NOT EXISTS idempotency_records (
  key            TEXT        PRIMARY KEY,
  token          UUID        NOT NULL,
  fingerprint    TEXT,
  status         TEXT        NOT NULL CHECK (status IN ('PROCESSING','COMPLETED')),
  response_code  INT,
  response_body  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at
  ON idempotency_records (expires_at);
```

### 3.2 컬럼 설계 근거

| 컬럼 | 타입 | 설계 근거 |
|------|------|----------|
| `key` | `TEXT PRIMARY KEY` | 인터셉터에서 이미 스코프 프리픽스(`POST /payments::abc123`)가 적용된 키. PK가 자연스러운 NX 제약. 길이 제한 없음(VARCHAR 대신 TEXT) |
| `token` | `UUID` | `randomUUID()`가 표준 UUID 포맷이므로 네이티브 UUID 타입 사용 (16바이트, 인덱스 효율) |
| `fingerprint` | `TEXT NULL` | SHA-256 hex(64자) 또는 NULL(`fingerprint=false` 모드). VARCHAR(64) 대신 TEXT로 통일 |
| `status` | `TEXT CHECK` | enum 대신 `CHECK` 제약으로 단순화. 마이그레이션 비용 낮음 |
| `response_code` | `INT NULL` | PROCESSING 단계에는 NULL. HTTP 상태 코드 |
| `response_body` | `TEXT NULL` | JSON 직렬화 문자열. JSONB 대신 TEXT인 이유: 인터셉터가 이미 `JSON.stringify`로 직렬화하므로 재파싱 불필요. 저장 시 정규화/검증 비용 회피 |
| `created_at` | `TIMESTAMPTZ DEFAULT now()` | DB가 관리 → 불변식 자동 보장. UPDATE 시 SET 절에서 제외하면 자동으로 보존됨 |
| `expires_at` | `TIMESTAMPTZ NOT NULL` | TTL을 DB 시간으로 계산 (`now() + interval`). 인덱싱하여 sweep 효율 확보 |

### 3.3 인덱스 정책

- `key`는 PK로 자동 인덱스
- `expires_at`은 sweep 쿼리(`WHERE expires_at < now()`)와 lazy 만료 체크(`WHERE expires_at > now()`) 양쪽에 사용 → 단일 B-tree 인덱스로 충분
- 추가 인덱스는 v0.2.0에서 도입하지 않음

---

## 4. 메서드 매핑

### 4.1 `get(key)`

```sql
SELECT key, token, fingerprint, status, response_code, response_body,
       created_at, expires_at
FROM idempotency_records
WHERE key = $1 AND expires_at > now();
```

**핵심**: `expires_at > now()` 필터로 **lazy 만료** 강제. 만료된 레코드를 sweep이 아직 정리하지 않았더라도 호출자에게는 보이지 않음 → Memory/Redis와 동일한 행동.

**매핑**:
- 행 0개 → `null`
- 행 1개 → `IdempotencyRecord` 객체로 변환

### 4.2 `create(key, fingerprint, ttlSeconds)`

```sql
INSERT INTO idempotency_records
  (key, token, fingerprint, status, expires_at)
VALUES
  ($1, $2, $3, 'PROCESSING', now() + ($4 || ' seconds')::interval)
ON CONFLICT (key) DO UPDATE
  SET token = EXCLUDED.token,
      fingerprint = EXCLUDED.fingerprint,
      status = 'PROCESSING',
      response_code = NULL,
      response_body = NULL,
      created_at = now(),
      expires_at = EXCLUDED.expires_at
  WHERE idempotency_records.expires_at < now()
RETURNING token;
```

**행동표**:

| 시나리오 | INSERT 동작 | RETURNING | `acquired` |
|---------|------------|-----------|-----------|
| 키 없음 | INSERT 성공 | 1 row | `true` |
| 활성 레코드 존재 (`expires_at > now()`) | ON CONFLICT 트리거 → UPDATE 시도 → WHERE 거부 | 0 rows | `false` |
| 만료된 레코드 존재 (`expires_at < now()`) | ON CONFLICT 트리거 → UPDATE 성공 (만료된 거 교체) | 1 row | `true` |

**원자성 증명**: 단일 `INSERT ... ON CONFLICT` statement는 Postgres가 행 단위 락으로 직렬화. 두 동시 호출 중 정확히 하나만 `WHERE expires_at < now()`(또는 신규 INSERT)를 충족 → NX 보장.

**`xmax = 0` 트릭은 사용하지 않음**: 위 쿼리는 INSERT/만료된 UPDATE 모두 `RETURNING` 행을 반환하고, 활성 충돌만 0 rows를 반환하므로 추가 구별 불필요. 호출자는 `RETURNING token` 유무로 `acquired`를 판단.

**TTL 표현식**: `($4 || ' seconds')::interval`은 정수형 ttlSeconds를 안전하게 interval로 캐스팅. `make_interval(secs => $4)`도 가능하나 표현식이 더 길어짐.

### 4.3 `complete(key, token, response, ttlSeconds)`

```sql
UPDATE idempotency_records
SET status        = 'COMPLETED',
    response_code = $3,
    response_body = $4,
    expires_at    = now() + ($5 || ' seconds')::interval
WHERE key = $1 AND token = $2 AND status = 'PROCESSING'
RETURNING 1;
```

**핵심 사항**:
- `created_at`을 SET 절에서 명시적으로 제외 → **불변식 자동 충족**
- `WHERE token = $2` → **CAS 보장** (다른 토큰이면 0 rows 영향)
- `WHERE status = 'PROCESSING'`은 방어적 추가 (이미 COMPLETED인 행을 다시 덮어쓰지 않도록) — 이론상 인터셉터가 이런 호출을 만들지 않지만 견고성 차원
- `RETURNING 1` → 영향 행 수 직접 확인

**매핑**:
- `rowCount === 1` → `'ok'`
- `rowCount === 0` → `'stale'` (토큰 불일치 또는 행 없음)

### 4.4 `delete(key, token)`

```sql
DELETE FROM idempotency_records
WHERE key = $1 AND token = $2
RETURNING 1;
```

추가 후처리 (TS 레이어):
- `rowCount === 1` → `'ok'`
- `rowCount === 0` → 별도 SELECT로 행 존재 여부 확인:
  - 행 없음 → `'ok'` (이미 멱등 삭제 완료)
  - 행 있음 (다른 토큰) → `'stale'`

```typescript
async delete(key: string, token: string): Promise<MutateResult> {
  const del = await this.pool.query(
    'DELETE FROM idempotency_records WHERE key = $1 AND token = $2',
    [key, token],
  );
  if (del.rowCount === 1) return 'ok';
  const exists = await this.pool.query(
    'SELECT 1 FROM idempotency_records WHERE key = $1',
    [key],
  );
  return exists.rowCount === 0 ? 'ok' : 'stale';
}
```

**대안 검토 (단일 쿼리화)**:
```sql
WITH del AS (
  DELETE FROM idempotency_records WHERE key = $1 AND token = $2 RETURNING 1
)
SELECT
  CASE
    WHEN EXISTS (SELECT 1 FROM del) THEN 'ok'
    WHEN NOT EXISTS (SELECT 1 FROM idempotency_records WHERE key = $1) THEN 'ok'
    ELSE 'stale'
  END AS result;
```
한 라운드트립으로 끝나지만 가독성 저하. v0.2.0에선 두-쿼리 방식 채택, 향후 병목 시 최적화.

---

## 5. 드라이버 & 의존성 정책

### 5.1 피어 의존성

```jsonc
// package.json
{
  "peerDependencies": {
    "@nestjs/common": "^10.0.0 || ^11.0.0",
    "@nestjs/core":   "^10.0.0 || ^11.0.0",
    "ioredis":        "^5.0.0",
    "pg":             "^8.11.0",
    "reflect-metadata": "^0.1.13 || ^0.2.0",
    "rxjs":           "^7.8.0"
  },
  "peerDependenciesMeta": {
    "ioredis": { "optional": true },
    "pg":      { "optional": true }
  }
}
```

`pg`는 Redis와 동일하게 **옵셔널 피어**. MemoryStorage만 사용하는 사용자에겐 영향 없음.

### 5.2 동적 require 패턴

`RedisStorage`의 lazy require 패턴(`redis.storage.ts:94`) 그대로 적용:

```typescript
const PgPool = require('pg').Pool as new (config: PoolConfig) => Pool;
```

이로써 TypeScript 컴파일은 devDependencies로 보장되고, 런타임에는 `PostgresStorage`가 실제로 import될 때만 `pg`가 로드된다.

### 5.3 사용자 구성 옵션

```typescript
export interface PostgresStorageOptions {
  /** 사용자가 만든 pg Pool. 우선순위 1. destroy 시 end() 안 함. */
  pool?: Pool;

  /** pg Pool 생성용 config. 우선순위 2. destroy 시 end() 함. */
  connection?: PoolConfig;

  /** 테스트용 시임. */
  poolFactory?: (config: PoolConfig) => Pool;

  /** 테이블 명 prefix. 멀티 테넌트 격리용 (선택). 기본 없음. */
  tablePrefix?: string;

  /** 모듈 init 시 CREATE TABLE IF NOT EXISTS 실행. 기본 false. */
  autoCreateSchema?: boolean;
}
```

---

## 6. TTL & Sweep 전략

### 6.1 3단 방어선

| 레이어 | 보장 | 도입 단계 |
|-------|------|----------|
| **L1: Lazy 만료** | `get()`이 `expires_at > now()`로 필터링 → 만료된 레코드는 호출자에게 절대 보이지 않음 | **필수** (모든 `get()`에 내장) |
| **L2: 기회적 정리** | `create()`의 `ON CONFLICT ... WHERE expires_at < now()`가 만료된 레코드를 자연스럽게 교체 | **필수** (자동) |
| **L3: 능동 sweep** | 백그라운드에서 만료된 레코드 일괄 삭제 | **옵트인** (`PostgresSweepService`) |

L1+L2만으로 **정확성**은 완벽히 보장된다. L3는 순전히 디스크 사용량 관리용.

### 6.2 `PostgresSweepService` 설계

```typescript
@Injectable()
export class PostgresSweepService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(IDEMPOTENCY_STORAGE) private storage: PostgresStorage,
    private options: SweepOptions,
  ) {}

  async onModuleInit() {
    if (!this.options.enabled) return;
    this.scheduleSweep();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private scheduleSweep() {
    this.timer = setInterval(() => {
      this.sweep().catch((err) => this.logger.error(err));
    }, this.options.intervalMs ?? 60_000);
  }

  async sweep(): Promise<{ deleted: number }> {
    // pg_try_advisory_lock으로 다중 인스턴스 중복 방지
    const result = await this.storage.pool.query(`
      WITH locked AS (
        SELECT pg_try_advisory_lock(hashtext('idempotency-sweep')) AS acquired
      ),
      deleted AS (
        DELETE FROM idempotency_records
        WHERE expires_at < now()
        RETURNING 1
      )
      SELECT (SELECT COUNT(*) FROM deleted)::int AS count
      WHERE (SELECT acquired FROM locked);
    `);
    // advisory lock 해제는 세션 종료 시 자동 (pg pool 반납 시점)
    return { deleted: result.rows[0]?.count ?? 0 };
  }
}
```

**advisory lock 사용 근거**: 같은 DB에 연결된 N개 인스턴스가 동시에 sweep을 돌리면 같은 행을 경합해 락 비용/dead tuples만 늘어남. `pg_try_advisory_lock`은 **non-blocking** → 경쟁 인스턴스는 그냥 다음 주기로 미룸.

**제공 옵션**:

```typescript
interface SweepOptions {
  enabled: boolean;       // 기본 false
  intervalMs?: number;    // 기본 60000
  batchSize?: number;     // 기본 미사용 (단일 쿼리). 향후 LIMIT 도입 시
}
```

### 6.3 외부 스케줄러용 SQL 스니펫 (README 동봉)

사용자가 pg_cron, cron + psql, Airflow 등으로 직접 sweep을 돌리려는 경우:

```sql
-- 매분 실행 권장
DELETE FROM idempotency_records WHERE expires_at < now();
```

pg_cron 예시 (README에 포함):
```sql
SELECT cron.schedule('idempotency-sweep', '* * * * *',
  $$DELETE FROM idempotency_records WHERE expires_at < now()$$);
```

---

## 7. 스키마 마이그레이션

3가지 옵션을 동시 제공. 사용자가 환경에 맞춰 선택.

### 7.1 옵션 A — SQL 파일

`sql/init.sql`을 패키지에 동봉:

```sql
-- @nestarc/idempotency v0.2.0+ 스키마
CREATE TABLE IF NOT EXISTS idempotency_records (
  key            TEXT        PRIMARY KEY,
  token          UUID        NOT NULL,
  fingerprint    TEXT,
  status         TEXT        NOT NULL CHECK (status IN ('PROCESSING','COMPLETED')),
  response_code  INT,
  response_body  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at
  ON idempotency_records (expires_at);
```

`package.json`의 `files`에 `"sql"` 추가하여 npm 게시 시 포함.

사용자 적용 예:
```bash
psql "$DATABASE_URL" -f node_modules/@nestarc/idempotency/sql/init.sql
```

### 7.2 옵션 B — 정적 메서드

```typescript
import { PostgresStorage } from '@nestarc/idempotency';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await PostgresStorage.createSchema(pool);
```

내부 구현은 위 SQL과 동일한 statement를 실행. 테스트 setup, 마이그레이션 도구 통합에 편리.

### 7.3 옵션 C — 자동 생성 (옵트인)

```typescript
IdempotencyModule.forRoot({
  storage: new PostgresStorage({
    pool,
    autoCreateSchema: true,  // 기본 false
  }),
});
```

`onModuleInit`에서 `createSchema()` 호출. **개발 환경에서만 권장**. 프로덕션은 명시적 마이그레이션 권장 (DDL 권한 필요, 부팅 시 경쟁 가능).

`tablePrefix` 옵션과 결합 시:
```sql
CREATE TABLE IF NOT EXISTS "${prefix}_idempotency_records" (...);
```

### 7.4 비교표

| 옵션 | 사용 환경 | DDL 권한 | 안전성 |
|-----|----------|---------|-------|
| A. SQL 파일 | 프로덕션, 마이그레이션 도구(Flyway, Liquibase, sqitch) 사용자 | 마이그레이션 시점만 필요 | ⭐⭐⭐⭐⭐ |
| B. `createSchema()` | 테스트, 사이드 스크립트, 명시적 부트스트랩 | 호출 시점 필요 | ⭐⭐⭐⭐ |
| C. `autoCreateSchema` | 개발/데모 | 앱 런타임 항상 필요 | ⭐⭐ |

---

## 8. 라이프사이클

`RedisStorage`와 1:1 동일한 패턴:

| 시나리오 | `ownsPool` | `onModuleDestroy()` 동작 |
|---------|-----------|-----------------------|
| 사용자가 `pool` 전달 | `false` | no-op (사용자 소유) |
| 사용자가 `connection` 전달 | `true` | `await pool.end()` |

```typescript
@Injectable()
export class PostgresStorage implements IdempotencyStorage, OnModuleDestroy {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  // ... 생성자: redis.storage.ts:80-109 패턴 그대로 ...

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
```

---

## 9. 패키지 구조 변경

```
src/
├── storage/
│   ├── memory.storage.ts            (변경 없음)
│   ├── redis.storage.ts             (변경 없음)
│   └── postgres.storage.ts          ← 신규
├── services/
│   └── postgres-sweep.service.ts    ← 신규 (옵트인)
└── index.ts                         ← PostgresStorage, PostgresStorageOptions, PostgresSweepService 재내보내기

sql/
└── init.sql                         ← 신규

test/
├── storage/
│   ├── memory.storage.spec.ts       (변경 없음)
│   ├── redis.storage.spec.ts        (변경 없음)
│   ├── postgres.storage.spec.ts     ← 신규: 어댑터 단독 테스트
│   └── shared-storage-contract.ts   ← 변경 없음 (재사용)
├── services/
│   └── postgres-sweep.service.spec.ts ← 신규
└── e2e/
    └── postgres.e2e-spec.ts         ← 신규: NestJS + supertest

bench/
└── idempotency.bench.ts             ← Postgres 시나리오 추가

.github/workflows/
└── ci.yml                           ← postgres 서비스 컨테이너 + DATABASE_URL env 추가

docs/
└── postgres-storage-spec.md         ← 본 문서

README.md                            ← 사용 예시, 마이그레이션 옵션, sweep 가이드
CHANGELOG.md                         ← v0.2.0 항목
package.json                         ← peerDeps에 pg, files에 sql/ 추가
```

---

## 10. 테스트 전략

### 10.1 공유 컨트랙트 (필수 통과)

`test/storage/postgres.storage.spec.ts`는 `shared-storage-contract.ts`의 모든 케이스를 실행한다. 이는 LSP 검증 — 어떤 공개 행동도 Memory/Redis와 달라서는 안 됨.

```typescript
import { runStorageContract } from '../support/shared-storage-contract';

describe('PostgresStorage — shared contract', () => {
  let pool: Pool;
  let storage: PostgresStorage;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await PostgresStorage.createSchema(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE idempotency_records');
    storage = new PostgresStorage({ pool });
  });

  afterAll(async () => {
    await pool.end();
  });

  runStorageContract(() => storage);
});
```

### 10.2 Postgres 전용 테스트

공유 컨트랙트로 검증되지 않는 Postgres 특유 행동:

| 케이스 | 검증 내용 |
|-------|---------|
| 만료된 레코드 자동 교체 | `create()`가 `expires_at < now()`인 행을 새 토큰으로 교체 |
| `created_at` DB 보존 | `complete()` 후 `created_at`이 정확히 `create()` 시점 그대로 |
| `pool` 모드 lifecycle | 사용자 pool은 `onModuleDestroy()`에서 `end()` 안 됨 |
| `connection` 모드 lifecycle | 자체 생성 pool은 `end()` 됨 |
| `autoCreateSchema=true` | 모듈 init 시 테이블이 없으면 생성, 있으면 무동작 |
| `tablePrefix` | 다른 prefix는 격리 (같은 키도 충돌 없음) |
| `createSchema()` 멱등성 | 여러 번 호출해도 에러 없음 |

### 10.3 Sweep 서비스 테스트

```typescript
describe('PostgresSweepService', () => {
  it('만료된 레코드만 삭제한다', async () => { /* ... */ });
  it('활성 레코드는 보존한다', async () => { /* ... */ });
  it('intervalMs 주기로 실행된다', async () => { /* fake timers */ });
  it('disabled 시 스케줄하지 않는다', async () => { /* ... */ });
  it('advisory lock 미획득 시 무동작', async () => { /* 두 인스턴스 동시 실행 */ });
  it('onModuleDestroy 시 타이머 해제', async () => { /* ... */ });
});
```

### 10.4 E2E

`test/e2e/postgres.e2e-spec.ts`:

- 실제 Postgres에 연결된 NestJS 앱 부팅
- supertest로 `Promise.all` 동시 요청 → 정확히 한 번 핸들러 실행 + 두 응답 모두 동일 본문(replay) OR 한 번은 409
- 핑거프린트 불일치 → 422
- 핸들러 에러 → 다음 시도에서 재실행 가능
- 다른 엔드포인트에서 같은 키 사용 → 스코프 격리

### 10.5 회귀 테스트 추가

기존 4개 회귀 테스트(complete-failure-cascade, race-completed-winner, path-based-scope, ttl-validation)에 Postgres 어댑터를 매개변수화하여 추가 실행. v0.2.0 출시 시 **3개 어댑터 × 4개 회귀 시나리오 = 12개 보장**.

### 10.6 테스트 환경

- 로컬: `docker compose up -d postgres` (스크립트 추가)
- CI: GitHub Actions `services.postgres`
- 빠른 피드백을 위해 트랜잭션 롤백 패턴은 사용하지 않음 (DDL/sweep 검증이 트랜잭션 의존적이지 않게)

---

## 11. CI 통합

### 11.1 ci.yml 변경

```yaml
jobs:
  test:
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: idempotency_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    env:
      TEST_DATABASE_URL: postgresql://test:test@localhost:5432/idempotency_test
```

### 11.2 매트릭스 정책

v0.2.0은 **Postgres 16만 검증**. 이유:
- 16은 현재 안정 LTS
- `xmax` 트릭 / `ON CONFLICT` / `TIMESTAMPTZ + interval`은 Postgres 9.5+에서 모두 동작 → 호환성 위험 낮음
- CI 시간 절약

README에 "Postgres 12+ 권장 (16에서 검증, 9.5+ 호환 가능성 있음)" 명시.

### 11.3 Redis 매트릭스와의 일관성

기존 `ioredis-mock` 사용 → CI에 실제 Redis 서비스 없음.
새 Postgres는 실제 컨테이너 사용 → 일관성을 위해 향후 `redis:7-alpine` 컨테이너 도입 검토 (별도 작업).

---

## 12. 벤치마크

`bench/idempotency.bench.ts`에 시나리오 추가:

```typescript
// F) 첫 요청 — PostgresStorage
// G) 리플레이 — PostgresStorage
// H) Sweep 처리량 (옵션)
```

비교 보고서: Memory vs Redis vs Postgres의 p50/p95/p99.
예상치(가설):
- Memory: < 1ms
- Redis (loopback): 1–3ms
- Postgres (loopback): 2–5ms

같은 VPC 내 매니지드 DB라면 실 운영 차이는 무시할 수준이라는 점을 README에 명시.

---

## 13. 문서 갱신

### 13.1 README.md

추가/수정 섹션:

1. **Storage 비교 표**:

   | 어댑터 | 사용 시점 | 인프라 |
   |-------|----------|-------|
   | MemoryStorage | 단일 인스턴스 / 개발 / 테스트 | 없음 |
   | RedisStorage | 분산 환경, 저지연 | Redis 5+ |
   | **PostgresStorage** | **이미 Postgres 운영 중**, 추가 인프라 회피 | Postgres 12+ |

2. **PostgresStorage 사용 예** (sync + async forRootAsync)
3. **마이그레이션 옵션 3종** (SQL 파일 / `createSchema()` / `autoCreateSchema`)
4. **Sweep 가이드** (`PostgresSweepService` + pg_cron 예시)
5. **로드맵 — 트랜잭션 통합 (v0.3.0+)**

### 13.2 CHANGELOG.md

```markdown
## [0.2.0] - 2026-MM-DD

### Added
- PostgreSQL storage adapter (`PostgresStorage`) with optional `pg` peer
- Optional sweep service (`PostgresSweepService`) for active expired-record cleanup
- Three schema migration paths: shipped SQL file, `createSchema()` helper, `autoCreateSchema` option
- CI service container for Postgres 16; Postgres regression suite

### Changed
- Bench script extended with Postgres scenarios (F/G/H)
- README: storage comparison table, PostgresStorage usage, migration & sweep guidance
```

### 13.3 docs/handover.md

기존 "PostgreSQL adapter (future)" 항목을 "Implemented in v0.2.0"으로 갱신. 트랜잭션 통합 부분은 v0.3.0 로드맵으로 이동.

---

## 14. 구현 단계 (TDD 순서)

각 단계는 **테스트 → 구현 → 그린** 사이클을 따른다.

| # | 작업 | 산출물 |
|---|------|-------|
| 1 | `sql/init.sql` 작성, `package.json files` 갱신 | DDL 검증 (psql 실행) |
| 2 | `PostgresStorageOptions` 타입 정의 | 타입 컴파일 |
| 3 | 공유 컨트랙트를 적용한 `postgres.storage.spec.ts` 작성 (RED) | 모든 테스트 실패 |
| 4 | `PostgresStorage.get()` 구현 (GREEN) | get 관련 테스트 통과 |
| 5 | `PostgresStorage.create()` 구현 (GREEN) | create 관련 테스트 통과 |
| 6 | `PostgresStorage.complete()` 구현 (GREEN) | complete 관련 테스트 통과 |
| 7 | `PostgresStorage.delete()` 구현 (GREEN) | delete 관련 테스트 통과 |
| 8 | `OnModuleDestroy`, `close()`, ownsPool 분기 | 라이프사이클 테스트 통과 |
| 9 | `createSchema()` 정적 메서드 + `autoCreateSchema` | 마이그레이션 테스트 통과 |
| 10 | `tablePrefix` 옵션 | prefix 격리 테스트 통과 |
| 11 | `PostgresSweepService` 구현 + 테스트 | sweep 테스트 통과 |
| 12 | `src/index.ts` 재내보내기 | 공개 API 노출 |
| 13 | E2E 테스트 (`test/e2e/postgres.e2e-spec.ts`) | 실제 NestJS 앱 검증 |
| 14 | 회귀 테스트 매개변수화 (Postgres 추가) | 기존 4개 회귀 케이스 Postgres에서도 통과 |
| 15 | `ci.yml` 갱신 (postgres 서비스, env, 단계) | CI 그린 |
| 16 | 벤치마크 시나리오 추가 (F/G) | 측정값 산출 |
| 17 | README, CHANGELOG, handover 갱신 | 문서 동기화 |
| 18 | 0.2.0 태그 + GitHub Actions 자동 게시 | npm 등록 |

---

## 15. 위험 & 대응

| 위험 | 가능성 | 영향 | 대응 |
|------|-------|-----|------|
| `pg` 메이저 버전 호환 (v9 출시 시) | 중 | 빌드 깨짐 | peerDeps에 `^8.11.0` 명시, dependabot이 자동 PR 발행 시 검토 |
| `autoCreateSchema` 경쟁 | 저 | 부팅 실패 | `IF NOT EXISTS` 사용, advisory lock 추가 검토 |
| Sweep 서비스의 multi-node 중복 | 중 | DB 부하 | `pg_try_advisory_lock` 도입 (위 §6.2) |
| `INSERT ... ON CONFLICT DO UPDATE WHERE`의 호환성 | 저 | Postgres < 9.5 지원 못함 | 12+ 명시 |
| `expires_at` 인덱스 비대화 | 저 | 디스크/IO | sweep 또는 `pg_repack` 안내 |
| `JSON.stringify` 결과가 매우 큰 응답 | 중 | row 크기 폭증 | TOAST가 자동 압축, BUT README에 "큰 바이너리는 멱등 캐시 비대상" 명시 (이미 `isReplayable()` 가드됨) |
| 마이그레이션 도구와의 충돌 | 저 | 사용자 혼란 | 옵션 A 권장 + Flyway/sqitch 통합 예시 README에 추가 |

---

## 16. 미해결/후속 결정

다음은 v0.2.0 구현 중 또는 출시 후에 결정:

1. **`tablePrefix` vs `schemaName`**: 멀티 테넌트 격리 단위를 prefix(`tenant1_idempotency_records`)로 할지 별도 schema(`tenant1.idempotency_records`)로 할지. prefix가 단순하지만 schema가 정규적 — 사용자 피드백 후 결정.
2. **`SELECT FOR UPDATE` 도입**: 현재 설계는 트랜잭션 없이 단일 쿼리. 미래에 트랜잭션 통합 기능을 도입하면 행 락이 필요해질 수 있음.
3. **Sweep batchSize**: 매우 큰 테이블에서 한 번에 100만 row 삭제는 vacuum 부담. v0.3.0에서 `LIMIT` + 반복 도입 검토.
4. **JSON 응답을 JSONB로?**: 디버깅 시 `SELECT response_body->>'orderId'` 같은 쿼리가 가능해짐. 단점: 인터셉터의 직렬화/역직렬화 경로 변경 필요. 사용자 수요 확인 후 v0.3.0+ 검토.

---

## 17. 승인 체크리스트

본 스펙으로 구현 진입 전 확인:

- [ ] 인터페이스 변경 없음 — 기존 `IdempotencyStorage` 컨트랙트만 충족
- [ ] 기존 어댑터(Memory/Redis) 동작 영향 없음
- [ ] 공유 컨트랙트 테스트 추가 변경 없이 그대로 통과 가능
- [ ] `pg`는 옵셔널 피어 — Memory/Redis만 쓰는 사용자에게 무영향
- [ ] CI Postgres 16 단일 매트릭스 동의
- [ ] Sweep 서비스를 v0.2.0에 옵트인으로 포함 동의
- [ ] 트랜잭션 통합은 v0.3.0+로 분리 동의
- [ ] 마이그레이션 3-옵션 정책 (A+B+C) 동의

---

## 18. 참고

- IETF draft: `draft-ietf-httpapi-idempotency-key-header-07`
- 인터셉터 구현: [`src/idempotency.interceptor.ts`](../src/idempotency.interceptor.ts)
- 스토리지 인터페이스: [`src/interfaces/idempotency-storage.interface.ts`](../src/interfaces/idempotency-storage.interface.ts)
- Redis 어댑터 (참고 구현): [`src/storage/redis.storage.ts`](../src/storage/redis.storage.ts)
- Memory 어댑터 (참고 구현): [`src/storage/memory.storage.ts`](../src/storage/memory.storage.ts)
- Postgres `INSERT ... ON CONFLICT`: https://www.postgresql.org/docs/current/sql-insert.html
- `pg_try_advisory_lock`: https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS
