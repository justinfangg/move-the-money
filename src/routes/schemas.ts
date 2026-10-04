export const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

const idempotencyKey = { type: "string", minLength: 1, maxLength: 255 } as const;

export const optionalIdempotencyHeaders = {
  type: "object",
  properties: { "idempotency-key": idempotencyKey },
} as const;

export const requiredIdempotencyHeaders = {
  type: "object",
  required: ["idempotency-key"],
  properties: { "idempotency-key": idempotencyKey },
} as const;
