/** A refusal the caller can act on, as opposed to a bug. `code` is stable for scripts. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super("invalid_request", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super("not_found", message);
  }
}

export class InsufficientFundsError extends AppError {
  constructor(message = "insufficient funds") {
    super("insufficient_funds", message);
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(message = "idempotency key was already used with a different request") {
    super("idempotency_key_conflict", message);
  }
}
