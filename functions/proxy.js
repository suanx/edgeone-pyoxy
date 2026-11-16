/**
 * EdgeOne Pages universal reverse proxy function.
 * Route: /proxy?url=<target-url>
 *
 * Fix: the previous version forwarded every request through
 * https://cors-anywhere.herokuapp.com/ — that public demo service is
 * effectively dead (it requires manual opt-in via /corsdemo and hard
 * rate-limits), which made every proxied request fail. We now fetch the
 * target URL directly from the edge function, forwarding the original
 * request method/headers/body and returning a sanitized response.
 */

// Hop-by-hop headers plus headers injected by the CDN/platform that must
// never be forwarded to the target site.
const REQUEST_HEADER_DENYLIST = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cookie',
  'authorization',
  'accept-encoding', // let the runtime negotiate and decompress encoding itself
  // CDN / proxy injected headers
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-real-ip',
  'true-client-ip',
  'cdn-loop',
  'eo-geo',
  'eo-connecting-ip',
]);

// Response headers that break rendering or leak state when proxied.
const RESPONSE_HEADER_DENYLIST = new Set([
  'set-cookie',
  'content-encoding', // the runtime already decompressed the body
  'content-length', // recomputed for the streamed body
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'cross-origin-embedder-policy',
  'strict-transport-security',
  'report-to',
  'nel',
  'clear-site-data',
]);

function textResponse(status, message) {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=UTF-8',
      'access-control-allow-origin': '*',
    },
  });
}

export async function onRequest(context) {
  const { request } = context;

  // Support using the proxy from browser JavaScript as well.
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': '*',
        'access-control-max-age': '86400',
      },
    });
  }

  // 1. Resolve and validate the target URL.
  let target;
  try {
    const requestUrl = new URL(request.url);
    const raw = requestUrl.searchParams.get('url');
    if (!raw) {
      return textResponse(400, "Missing required query parameter 'url'. Usage: /proxy?url=https://example.com");
    }
    // Be forgiving: accept "example.com" as well as "https://example.com".
    target = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return textResponse(400, `Unsupported protocol '${target.protocol}' — only http and https are allowed.`);
    }
  } catch (error) {
    return textResponse(400, `Invalid target URL: ${error.message}`);
  }

  // 2. Forward the original request headers, minus hop-by-hop/platform ones.
  const headers = new Headers();
  for (const [name, value] of request.headers.entries()) {
    if (!REQUEST_HEADER_DENYLIST.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  // Pretend to come from the target site itself so hotlink/referrer checks pass.
  headers.set('referer', target.origin + '/');

  // 3. Build the upstream request. Buffer the body to stay compatible with
  //    runtimes that reject stream bodies in `new Request()` without duplex.
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let body;
  if (hasBody) {
    try {
      body = await request.arrayBuffer();
    } catch (error) {
      return textResponse(400, `Unable to read request body: ${error.message}`);
    }
  }

  try {
    const upstream = await fetch(target.href, {
      method: request.method,
      headers,
      body: hasBody ? body : undefined,
      redirect: 'follow',
    });

    // 4. Sanitize the upstream response headers before returning them.
    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers.entries()) {
      if (!RESPONSE_HEADER_DENYLIST.has(name.toLowerCase())) {
        responseHeaders.set(name, value);
      }
    }
    responseHeaders.set('access-control-allow-origin', '*');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    return textResponse(502, `Proxy Error: unable to reach ${target.href} — ${error.message}`);
  }
}
