/**
 * Query-style proxy route: /proxy?url=<target-url>
 * (functions/proxy/index.js maps to the /proxy path)
 */
import { handle } from '../proxy-lib.js';

export async function onRequest({ request }) {
  const url = new URL(request.url);
  return handle(request, url.searchParams.get('url'), true);
}
