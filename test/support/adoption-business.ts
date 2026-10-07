import {
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Pool, type PoolClient } from 'pg';

export interface RecipeIdentity {
  tenantId: string;
  userId: string;
}

export interface PaymentCommand {
  commandId: string;
  amount: number;
  currency: string;
}

export interface OrderCommand {
  commandId: string;
  orderId: string;
  sku: string;
  quantity: number;
}

export interface RecipeEvent {
  id: string;
  objectId: string;
  type: 'order.changed';
  version: number;
  state: 'pending' | 'paid';
}

export interface PaymentResult {
  commandId: string;
  providerReference: string;
  amount: number;
  currency: string;
}

/** Local simulator: no Stripe SDK, network call, or live payment exists here. */
export class RecipeProvider {
  calls = 0;
  loseAcknowledgment = false;
  unavailable = false;
  private readonly results = new Map<string, PaymentResult>();

  charge(key: string, command: PaymentCommand): PaymentResult {
    this.calls += 1;
    if (this.unavailable) throw new Error('simulated unknown provider result');
    const old = this.results.get(key);
    if (old) {
      if (old.amount !== command.amount || old.currency !== command.currency) {
        throw new Error('simulated provider parameter mismatch');
      }
      return old;
    }
    const result = { ...command, providerReference: `fake-${randomUUID()}` };
    this.results.set(key, result);
    if (this.loseAcknowledgment) {
      this.loseAcknowledgment = false;
      throw new Error('simulated acknowledgment loss after provider commit');
    }
    return result;
  }

  lookup(key: string): PaymentResult | undefined {
    if (this.unavailable) throw new Error('simulated provider lookup unavailable');
    return this.results.get(key);
  }

  reset(): void {
    this.calls = 0;
    this.loseAcknowledgment = false;
    this.unavailable = false;
    this.results.clear();
  }
}

/**
 * Application-owned tables, deliberately separate from idempotency storage.
 * A random schema makes each run disposable without touching existing tables.
 */
export class RecipeLedger {
  readonly schema = `s7_recipe_${randomUUID().replace(/-/g, '')}`;
  readonly provider = new RecipeProvider();

  constructor(readonly pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA ${this.schema}`);
    await this.pool.query(`
      CREATE TABLE ${this.schema}.commands (
        tenant_id text NOT NULL,
        kind text NOT NULL,
        command_id text NOT NULL,
        user_id text NOT NULL,
        parameters jsonb NOT NULL,
        state text NOT NULL CHECK (state IN ('pending', 'succeeded')),
        result jsonb,
        PRIMARY KEY (tenant_id, kind, command_id)
      );
      CREATE TABLE ${this.schema}.orders (
        tenant_id text NOT NULL,
        order_id text NOT NULL,
        user_id text NOT NULL,
        sku text NOT NULL,
        quantity integer NOT NULL,
        PRIMARY KEY (tenant_id, order_id)
      );
      CREATE TABLE ${this.schema}.inbox (
        account_id text NOT NULL,
        event_id text NOT NULL,
        fingerprint text NOT NULL,
        PRIMARY KEY (account_id, event_id)
      );
      CREATE TABLE ${this.schema}.order_projection (
        account_id text NOT NULL,
        object_id text NOT NULL,
        version integer NOT NULL,
        state text NOT NULL,
        PRIMARY KEY (account_id, object_id)
      );
      CREATE TABLE ${this.schema}.fulfillments (
        account_id text NOT NULL,
        object_id text NOT NULL,
        PRIMARY KEY (account_id, object_id)
      )
    `);
  }

  async dispose(): Promise<void> {
    await this.pool.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
  }

  async reset(): Promise<void> {
    await this.pool.query(`TRUNCATE ${this.schema}.commands, ${this.schema}.orders,
      ${this.schema}.inbox, ${this.schema}.order_projection, ${this.schema}.fulfillments`);
    this.provider.reset();
  }

  providerKey(identity: RecipeIdentity, commandId: string): string {
    return createHash('sha256')
      .update(JSON.stringify([identity.tenantId, 'payment', commandId]))
      .digest('hex');
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async acquire(
    client: PoolClient,
    identity: RecipeIdentity,
    kind: string,
    commandId: string,
    parameters: Record<string, unknown>,
  ): Promise<{ fresh: boolean; state: string; result: PaymentResult | null }> {
    const values = [identity.tenantId, kind, commandId, identity.userId, parameters];
    const inserted = await client.query(
      `INSERT INTO ${this.schema}.commands
       (tenant_id, kind, command_id, user_id, parameters, state)
       VALUES ($1, $2, $3, $4, $5, 'pending') ON CONFLICT DO NOTHING`,
      values,
    );
    const { rows } = await client.query<{
      user_id: string;
      same_parameters: boolean;
      state: string;
      result: PaymentResult | null;
    }>(
      `SELECT user_id, parameters = $4::jsonb AS same_parameters, state, result
       FROM ${this.schema}.commands
       WHERE tenant_id = $1 AND kind = $2 AND command_id = $3
       FOR UPDATE`,
      [identity.tenantId, kind, commandId, parameters],
    );
    const row = rows[0];
    if (row.user_id !== identity.userId) throw new ForbiddenException();
    if (!row.same_parameters) throw new UnprocessableEntityException('Command parameters changed');
    return { fresh: inserted.rowCount === 1, state: row.state, result: row.result };
  }

  async pay(identity: RecipeIdentity, command: PaymentCommand): Promise<PaymentResult> {
    // Commit the intent before making a provider call. Only the inserter may call it.
    const row = await this.transaction((client) =>
      this.acquire(client, identity, 'payment', command.commandId, {
        amount: command.amount,
        currency: command.currency,
      }),
    );
    if (row.state === 'succeeded' && row.result) return row.result;
    if (!row.fresh) throw new ConflictException('Command needs reconciliation');
    const result = this.provider.charge(this.providerKey(identity, command.commandId), command);
    await this.recordPayment(identity, command.commandId, result);
    return result;
  }

  private async recordPayment(
    identity: RecipeIdentity,
    commandId: string,
    result: PaymentResult,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.schema}.commands SET state = 'succeeded', result = $4
       WHERE tenant_id = $1 AND kind = 'payment' AND command_id = $2 AND user_id = $3`,
      [identity.tenantId, commandId, identity.userId, result],
    );
  }

  /** Application reconciliation; not a package API and never an automatic retry. */
  async reconcile(identity: RecipeIdentity, commandId: string): Promise<PaymentResult | null> {
    const { rows } = await this.pool.query<{ user_id: string; result: PaymentResult | null }>(
      `SELECT user_id, result FROM ${this.schema}.commands
       WHERE tenant_id = $1 AND kind = 'payment' AND command_id = $2`,
      [identity.tenantId, commandId],
    );
    if (!rows[0] || rows[0].user_id !== identity.userId) throw new ForbiddenException();
    if (rows[0].result) return rows[0].result;
    const result = this.provider.lookup(this.providerKey(identity, commandId));
    if (!result) return null; // Absence is insufficient evidence to charge again.
    await this.recordPayment(identity, commandId, result);
    return result;
  }

  async order(identity: RecipeIdentity, command: OrderCommand): Promise<{ orderId: string }> {
    return this.transaction(async (client) => {
      await this.acquire(client, identity, 'order', command.commandId, {
        orderId: command.orderId,
        sku: command.sku,
        quantity: command.quantity,
      });
      await client.query(
        `INSERT INTO ${this.schema}.orders (tenant_id, order_id, user_id, sku, quantity)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [identity.tenantId, command.orderId, identity.userId, command.sku, command.quantity],
      );
      const { rows } = await client.query<{ user_id: string; sku: string; quantity: number }>(
        `SELECT user_id, sku, quantity FROM ${this.schema}.orders
         WHERE tenant_id = $1 AND order_id = $2 FOR UPDATE`,
        [identity.tenantId, command.orderId],
      );
      if (rows[0].user_id !== identity.userId) throw new ForbiddenException();
      if (rows[0].sku !== command.sku || rows[0].quantity !== command.quantity) {
        throw new UnprocessableEntityException('Existing order parameters changed');
      }
      const result = { orderId: command.orderId };
      await client.query(
        `UPDATE ${this.schema}.commands SET state = 'succeeded', result = $3
         WHERE tenant_id = $1 AND kind = 'order' AND command_id = $2`,
        [identity.tenantId, command.commandId, result],
      );
      return result;
    });
  }

  async receive(accountId: string, event: RecipeEvent): Promise<{ accepted: true }> {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([event.id, event.type, event.objectId, event.version, event.state]))
      .digest('hex');
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO ${this.schema}.inbox (account_id, event_id, fingerprint)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [accountId, event.id, fingerprint],
      );
      if (inserted.rowCount === 0) {
        const { rows } = await client.query<{ fingerprint: string }>(
          `SELECT fingerprint FROM ${this.schema}.inbox WHERE account_id = $1 AND event_id = $2`,
          [accountId, event.id],
        );
        if (rows[0].fingerprint !== fingerprint) {
          throw new UnprocessableEntityException('Verified event payload changed');
        }
        return { accepted: true };
      }
      // Version is a contract of this simulator, not Stripe event.created.
      const applied = await client.query(
        `INSERT INTO ${this.schema}.order_projection (account_id, object_id, version, state)
         VALUES ($1, $2, $3, $4) ON CONFLICT (account_id, object_id) DO UPDATE
         SET version = EXCLUDED.version, state = EXCLUDED.state
         WHERE ${this.schema}.order_projection.version < EXCLUDED.version
         RETURNING object_id`,
        [accountId, event.objectId, event.version, event.state],
      );
      if (applied.rowCount === 1 && event.state === 'paid') {
        await client.query(
          `INSERT INTO ${this.schema}.fulfillments (account_id, object_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [accountId, event.objectId],
        );
      }
      return { accepted: true };
    });
  }
}
