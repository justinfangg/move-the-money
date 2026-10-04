import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { AppError, ValidationError } from "./errors.js";
import { parseJsonStrict } from "./money.js";
import { accountRoutes } from "./routes/accounts.js";
import { transferRoutes } from "./routes/transfers.js";

export interface AppOptions {
  pool: pg.Pool;
  logger?: boolean;
}

export function buildApp({ pool, logger = false }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger,
    // Fastify's Ajv defaults silently strip unknown body fields
    // (removeAdditional) — a typo like "ammount_cents" alongside a valid
    // field would be dropped, not reported. Reject instead.
    // coerceTypes stays on for querystrings; amount fields are left untyped in
    // their schemas so they're never coerced (see routes/accounts.ts).
    ajv: { customOptions: { removeAdditional: false } },
  });

  // Replace the default JSON parser so number literals are checked before
  // they're rounded into doubles. See src/money.ts.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, parseJsonStrict(body as string));
    } catch (err) {
      done(err instanceof SyntaxError ? new ValidationError(`malformed JSON: ${err.message}`) : (err as Error));
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: "invalid_request", message: (err as Error).message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "invalid_request", message: (err as Error).message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "internal_error", message: "internal error" });
  });

  accountRoutes(app, pool);
  transferRoutes(app, pool);
  return app;
}
