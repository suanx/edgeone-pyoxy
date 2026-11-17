/**
 * Shared core for the EdgeOne Pages reverse proxy.
 * Imported by both route files:
 *   functions/proxy.js         -> /proxy?url=<target>          (query style)
 *   functions/proxy/[[target]].js -> /proxy/<encoded-target>   (path style)
 *
 * The path style keeps the target in the URL PATH, so GET form submissions
 * (which replace the whole query string) cannot lose it — this is what
 * breaks search on proxied pages such as Google.
 */

// Hop-by-hop headers plus headers injected by the CDN/platform that must
// never be forwarded to the target site.
// NOTE: Authorization and Cookie are intentionally FORWARDED — apps calling
// authenticated APIs through the proxy need them to reach the target.
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
  'content-length', // recomputed for the (possibly rewritten) body
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

// Injected into proxied pages as an extra safety net for GET forms.
const FORM_FIX_SCRIPT = `<script>
(function () {
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    var method = (form.getAttribute('method') || 'get').toLowerCase();
    if (method !== 'get') return; // POST keeps the query string intact
    e.preventDefault();
    try {
      var action = form.getAttribute('action') || location.href;
      var target = new URL(action, document.baseURI);
      var params = new URLSearchParams(target.search);
      new FormData(form).forEach(function (value, key) {
        params.append(key, value);
      });
      target.search = params.toString();
      location.href = target.toString();
    } catch (err) {
      form.submit();
    }
  }, true);
})();
</script>`;

function textResponse(status, message) {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=UTF-8',
      'access-control-allow-origin': '*',
    },
  });
}

/**
 * Builds a function that turns any URL found inside a document into an
 * ABSOLUTE proxy address of the form https://<host>/proxy/<encoded-target>.
 * The target lives in the PATH, so browser form submissions and page scripts
 * that rebuild the query string cannot lose it. Relative URLs are resolved
 * against `baseUrl` (the target page for HTML, the stylesheet itself for CSS).
 */
function makeProxifier(baseUrl, proxyOrigin) {
  return function proxify(rawUrl) {
    if (rawUrl == null) return rawUrl;
    const trimmed = String(rawUrl).trim();
    if (!trimmed) return trimmed;
    if (/^(data:|javascript:|mailto:|tel:|sms:|about:|blob:|#)/i.test(trimmed)) {
      return trimmed;
    }
    let absolute;
    try {
      absolute = new URL(
        trimmed.startsWith('//') ? 'https:' + trimmed : trimmed,
        baseUrl
      );
    } catch (error) {
      return trimmed;
    }
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') {
      return trimmed;
    }
    return proxyOrigin + '/proxy/' + encodeURIComponent(absolute.href);
  };
}

/** Rewrites url() / @import references inside CSS text. */
function rewriteCss(cssText, proxify) {
  cssText = cssText.replace(
    /@import\s+(?:url\(\s*)?(['"]?)([^'";)]+)\1\s*\)?/gi,
    (match, quote, url) => {
      const trimmed = url.trim();
      if (/^(data:|about:|blob:)/i.test(trimmed)) return match;
      return match.replace(url, proxify(trimmed));
    }
  );
  cssText = cssText.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (match, quote, url) => {
    const trimmed = url.trim();
    if (/^(data:|about:|blob:)/i.test(trimmed)) return match;
    return 'url("' + proxify(trimmed) + '")';
  });
  return cssText;
}

/** Rewrites every URL-bearing attribute / style block inside an HTML document. */
function rewriteHtml(html, proxify, targetUrl) {
  // Subresource integrity hashes no longer match once URLs change.
  html = html.replace(/\sintegrity\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
  // Only the first <base> is honoured; drop the original one, inject ours below.
  html = html.replace(/<base[^>]*>/gi, '');

  // Responsive images: srcset holds a comma separated list of "url descriptor".
  html = html.replace(/\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (match, dq, sq) => {
    const value = dq !== undefined ? dq : sq;
    const rewritten = value
      .split(',')
      .map((candidate) => {
        const parts = candidate.trim().split(/\s+/);
        if (parts[0]) parts[0] = proxify(parts[0]);
        return parts.join(' ');
      })
      .join(', ');
    return ' srcset="' + rewritten.replace(/"/g, '&quot;') + '"';
  });

  // Plain URL attributes.
  html = html.replace(
    /\s(href|src|action|poster|formaction|data-src|data-href|data-url|data-original|data-background|data-background-image)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
    (match, attr, dq, sq) => {
      const value = dq !== undefined ? dq : sq;
      return ' ' + attr + '="' + proxify(value).replace(/"/g, '&quot;') + '"';
    }
  );

  // <style> blocks: url() references resolve against the page URL.
  html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, css) => {
    return '<style' + attrs + '>' + rewriteCss(css, proxify) + '</style>';
  });

  // Inline style attributes may contain url(...) too.
  html = html.replace(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (match, dq, sq) => {
    const value = dq !== undefined ? dq : sq;
    return ' style="' + rewriteCss(value, proxify).replace(/"/g, '&quot;') + '"';
  });

  // Safety net: any URL we could not rewrite statically (typically generated
  // by page JavaScript) resolves against the target origin instead of 404ing
  // on the proxy domain.
  const baseTag = '<base href="' + targetUrl.href + '">';
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, (m) => m + baseTag + FORM_FIX_SCRIPT);
  } else {
    html = baseTag + FORM_FIX_SCRIPT + html;
  }
  return html;
}

function sanitizeHeaders(source) {
  const headers = new Headers();
  for (const [name, value] of source.entries()) {
    if (!RESPONSE_HEADER_DENYLIST.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  headers.set('access-control-allow-origin', '*');
  return headers;
}

/**
 * Recovers the raw target string from a catch-all path parameter.
 * Depending on how the platform normalises the path it may arrive still
 * percent-encoded, decoded, or with the "//" after the scheme collapsed.
 */
function normalizeTargetFromPath(raw) {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (error) {
    decoded = raw;
  }
  if (!/:\/\//.test(decoded)) {
    try {
      const again = decodeURIComponent(decoded);
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(again)) decoded = again;
    } catch (error) {
      /* keep current value */
    }
  }
  // Repair "https:/example.com" back to "https://example.com".
  return decoded.replace(/^([a-z][a-z0-9+.-]*:)\/(?!\/)/i, '$1//');
}

/**
 * Main entry: `rawTarget` is the target URL taken either from the ?url=
 * query parameter or from the /proxy/<encoded> path segment.
 */
export async function handle(request, rawTarget) {
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
    if (!rawTarget) {
      return textResponse(400, "Missing target. Usage: /proxy?url=https://example.com");
    }
    const candidate = rawTarget.startsWith('/proxy/')
      ? normalizeTargetFromPath(rawTarget.slice('/proxy/'.length))
      : rawTarget;
    // Be forgiving: accept "example.com" as well as "https://example.com".
    target = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return textResponse(400, `Unsupported protocol '${target.protocol}' — only http and https are allowed.`);
    }
    // Preserve any extra query parameters (e.g. ?q=... appended by search
    // forms or API clients) and merge them into the target URL.
    // NOTE: forEach instead of for...of — URLSearchParams has no iterator in
    // the EdgeOne function runtime.
    requestUrl.searchParams.forEach((value, key) => {
      if (key !== 'url') target.searchParams.append(key, value);
    });
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

    const contentType = upstream.headers.get('content-type') || '';
    const proxyOrigin = new URL(request.url).origin;

    // 4a. HTML: rewrite URLs so every asset is fetched through the proxy.
    if (/text\/html/i.test(contentType)) {
      const html = await upstream.text();
      const rewritten = rewriteHtml(html, makeProxifier(target, proxyOrigin), target);
      const responseHeaders = sanitizeHeaders(upstream.headers);
      responseHeaders.set('content-type', 'text/html; charset=UTF-8');
      responseHeaders.set('cache-control', 'no-store');
      return new Response(rewritten, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    }

    // 4b. CSS: relative url()s resolve against the stylesheet's own address.
    if (/text\/css/i.test(contentType)) {
      const css = await upstream.text();
      const rewritten = rewriteCss(css, makeProxifier(target, proxyOrigin));
      const responseHeaders = sanitizeHeaders(upstream.headers);
      responseHeaders.set('content-type', 'text/css; charset=UTF-8');
      return new Response(rewritten, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    }

    // 4c. Everything else: stream through untouched.
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: sanitizeHeaders(upstream.headers),
    });
  } catch (error) {
    return textResponse(502, `Proxy Error: unable to reach ${target.href} — ${error.message}`);
  }
}
