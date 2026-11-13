import type { INestApplication } from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter.js';
import type { Logger } from './logger.js';
import { requestContext } from './request-id.js';

/**
 * Applies the cross-cutting HTTP behaviour: request identifiers and the standard error body.
 * Call it before the application starts listening, so the identifier is assigned before body
 * parsing and routing and is present on every response, including 404 and parse errors.
 */
export function configureApp<T extends INestApplication>(app: T, logger: Logger): T {
  app.use(requestContext(logger));
  app.useGlobalFilters(new ApiExceptionFilter(logger));
  return app;
}
