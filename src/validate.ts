import { ValidationError } from "./errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ValidationError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ValidationError(`idempotency key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  return value;
}
