export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, "invalid_request", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, "not_found", message);
  }
}

export class InsufficientFundsError extends AppError {
  constructor(message = "insufficient funds") {
    super(422, "insufficient_funds", message);
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(message = "idempotency key was already used with a different request") {
    super(409, "idempotency_key_conflict", message);
  }
}
