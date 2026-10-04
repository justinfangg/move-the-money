import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { getAccount, listTransactions, openAccount } from "../ledger/accounts.js";
import { requireCents } from "../money.js";
import { idParams, optionalIdempotencyHeaders } from "./schemas.js";

export function accountRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post<{ Body: { initial_balance_cents: unknown }; Headers: { "idempotency-key"?: string } }>(
    "/accounts",
    {
      schema: {
        headers: optionalIdempotencyHeaders,
        body: {
          type: "object",
          required: ["initial_balance_cents"],
          additionalProperties: false,
          // Deliberately untyped: Fastify's Ajv coerces types by default, so
          // `type: "integer"` here would quietly turn "100" into 100.
          // requireCents does the real validation.
          properties: { initial_balance_cents: {} },
        },
      },
    },
    async (req, reply) => {
      const initialBalanceCents = requireCents(req.body.initial_balance_cents, "initial_balance_cents", 0);
      const { value, replayed } = await openAccount(pool, {
        initialBalanceCents,
        idempotencyKey: req.headers["idempotency-key"],
      });
      if (replayed) reply.header("idempotent-replay", "true");
      return reply.code(replayed ? 200 : 201).send(value);
    },
  );

  app.get<{ Params: { id: string } }>("/accounts/:id", { schema: { params: idParams } }, async (req) =>
    getAccount(pool, req.params.id),
  );

  app.get<{ Params: { id: string }; Querystring: { limit: number } }>(
    "/accounts/:id/transactions",
    {
      schema: {
        params: idParams,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
        },
      },
    },
    async (req) => ({ data: await listTransactions(pool, req.params.id, req.query.limit) }),
  );
}
