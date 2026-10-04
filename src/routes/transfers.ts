import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { getTransfer, transfer } from "../ledger/transfer.js";
import { requireCents } from "../money.js";
import { idParams, requiredIdempotencyHeaders } from "./schemas.js";

interface TransferBody {
  from_account_id: string;
  to_account_id: string;
  amount_cents: unknown;
}

export function transferRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post<{ Body: TransferBody; Headers: { "idempotency-key": string } }>(
    "/transfers",
    {
      schema: {
        headers: requiredIdempotencyHeaders,
        body: {
          type: "object",
          required: ["from_account_id", "to_account_id", "amount_cents"],
          additionalProperties: false,
          properties: {
            from_account_id: { type: "string", format: "uuid" },
            to_account_id: { type: "string", format: "uuid" },
            // Untyped on purpose; see routes/accounts.ts.
            amount_cents: {},
          },
        },
      },
    },
    async (req, reply) => {
      const { value, replayed } = await transfer(pool, {
        fromAccountId: req.body.from_account_id,
        toAccountId: req.body.to_account_id,
        amountCents: requireCents(req.body.amount_cents, "amount_cents", 1),
        idempotencyKey: req.headers["idempotency-key"],
      });
      if (replayed) reply.header("idempotent-replay", "true");
      return reply.code(replayed ? 200 : 201).send(value);
    },
  );

  app.get<{ Params: { id: string } }>("/transfers/:id", { schema: { params: idParams } }, async (req) =>
    getTransfer(pool, req.params.id),
  );
}
