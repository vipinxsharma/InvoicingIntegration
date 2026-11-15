import { Request, Response, NextFunction } from 'express';
import { logger } from '../modules/audit/logger';

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
}

export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  // Express requires the 4-argument signature even if next is unused
  _next: NextFunction,
): void {
  const statusCode = err.statusCode ?? 500;
  const isProduction = process.env['NODE_ENV'] === 'production';

  logger.error('Request error', {
    method: req.method,
    path: req.path,
    statusCode,
    error: err.message,
    ...(isProduction ? {} : { stack: err.stack }),
  });

  res.status(statusCode).json({
    error: isProduction && statusCode === 500 ? 'Internal server error' : err.message,
    ...(isProduction ? {} : { stack: err.stack }),
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
}
