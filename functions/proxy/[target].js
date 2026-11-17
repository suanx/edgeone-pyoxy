/**
 * Path-style proxy route (single dynamic segment):
 *   /proxy/<encoded-target-url>
 *
 * The target lives in the URL PATH instead of the query string, so GET form
 * submissions (which replace the whole query string) and page scripts that
 * rebuild the query cannot lose it. The target must be percent-encoded so it
 * stays a single path segment. Example:
 *   /proxy/https%3A%2F%2Fwww.google.com%2Fsearch?q=hello
 */
import { handle } from '../proxy-lib.js';

export async function onRequest({ request, params }) {
  let raw = params && params.target ? params.target : '';
  if (Array.isArray(raw)) raw = raw.join('/');
  return handle(request, raw);
}
