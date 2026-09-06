import type { Budget } from './budget';
import type { Decision } from './types';

/** The subset of an HTTP request/response the middleware touches (Express-compatible). */
export interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
}
export interface MinimalResponse {
  status(code: number): MinimalResponse;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}
export type Next = (error?: unknown) => void;

export interface MiddlewareOptions<Req extends MinimalRequest> {
  /** Resolves the principal (user id, API key, team) from the request. */
  principal: (req: Req) => string | undefined | Promise<string | undefined>;
  /** Optional token estimate for the request body. */
  estimateTokens?: (req: Req) => number;
  /** Customize the 429 body (default: { error, reason, resetsAt }). */
  onExceeded?: (decision: Decision, req: Req, res: MinimalResponse) => unknown;
}

/**
 * Express-style middleware: rejects with 429 when the principal is over
 * budget and exposes the decision as `req.budget` for the handler to
 * record usage after the model call.
 */
export function budgetMiddleware<Req extends MinimalRequest>(budget: Budget, options: MiddlewareOptions<Req>) {
  return async (req: Req & { budget?: Decision }, res: MinimalResponse, next: Next): Promise<void> => {
    try {
      const principal = await options.principal(req);
      if (!principal) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      const decision = await budget.check(principal, options.estimateTokens?.(req) ?? 0);
      req.budget = decision;
      if (decision.warnings.length) res.setHeader('X-Budget-Warning', decision.warnings.join(','));
      if (!decision.allowed) {
        const reason = decision.reason!;
        const resetsAt = decision[reason].resetsAt;
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetsAt - Date.now()) / 1000))));
        if (options.onExceeded) {
          options.onExceeded(decision, req, res);
        } else {
          res.status(429).json({ error: 'budget exceeded', reason, resetsAt: new Date(resetsAt).toISOString() });
        }
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
