/**
 * Path-style proxy route (optional catch-all):
 *   /proxy/<encoded-target-url>
 *
 * The target lives in the URL PATH instead of the query string, so GET form
 * submissions (which replace the whole query string) and page scripts that
 * rebuild the query cannot lose it. Example:
 *   /proxy/https%3A%2F%2Fwww.google.com%2Fsearch?q=hello
 *
 * NOTE: the platform percent-decodes the path before routing, so the target
 * may arrive split into several segments ("https:", "www.google.com", ...);
 * the catch-all joins them back and handle() repairs the scheme slashes.
 */
import { handle } from '../proxy-lib.js';

export async function onRequest({ request, params }) {
  let raw = params && params.target ? params.target : '';
  if (Array.isArray(raw)) raw = raw.join('/');
  return handle(request, raw);
}
