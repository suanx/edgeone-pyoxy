/**
 * Query-style proxy route: /proxy?url=<target-url>
 * The target is passed as the ?url= query parameter.
 */
import { handle } from './proxy-lib.js';

export async function onRequest({ request }) {
  const url = new URL(request.url);
  return handle(request, url.searchParams.get('url'));
}
