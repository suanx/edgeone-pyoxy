/**
 * Root catch-all proxy route: /proxy/<encoded-target-url>
 *
 * The target lives in the URL PATH instead of the query string, so GET form
 * submissions (which replace the whole query string) and page scripts that
 * rebuild the query cannot lose it. Example:
 *   /proxy/https%3A%2F%2Fwww.google.com%2Fsearch?q=hello
 *
 * Any path outside /proxy/ is answered with a plain 404.
 */
import { handle } from './proxy-lib.js';

export async function onRequest({ request, params }) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/proxy/')) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
    });
  }
  let raw = params && params.target ? params.target : '';
  if (Array.isArray(raw)) raw = raw.join('/');
  return handle(request, raw);
}
