// Express 4 does not forward rejected promises from async route handlers to the
// error middleware. Wrap async handlers with this so failures hit the central
// error handler instead of becoming unhandled rejections.

/**
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<unknown>} fn
 * @returns {import('express').RequestHandler}
 */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
