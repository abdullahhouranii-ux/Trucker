import diagnostics from 'node:diagnostics_channel';
import type { IncomingMessage } from 'node:http';
import { classifyArrival, VISITOR_HEADER } from './visitor.ts';

// Runs once when the web server starts (see src/instrumentation.ts). Node publishes every
// incoming request on this channel before any handler runs, with the real connection. The
// visitor kind is written into the request here, replacing whatever the visitor sent under the
// same name, so later code reads this server's own observation and nothing else.
let subscribed = false;

export function stampArrivals(): void {
  if (subscribed) return;
  subscribed = true;
  diagnostics.subscribe('http.server.request.start', (message) => {
    const { request } = message as { request?: IncomingMessage };
    if (!request) return;
    const kind = classifyArrival(request.socket?.remoteAddress, request.headers);
    request.headers[VISITOR_HEADER] = kind;
    // The raw list is what some code reads instead; remove the visitor's own copies there too.
    const raw = request.rawHeaders;
    for (let index = raw.length - 2; index >= 0; index -= 2)
      if (raw[index]?.toLowerCase() === VISITOR_HEADER) raw.splice(index, 2);
    raw.push(VISITOR_HEADER, kind);
  });
}
