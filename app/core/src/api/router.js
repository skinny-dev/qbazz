/**
 * Minimal path router: `/stores/:slug/products` style patterns, compiled once
 * at registration. No dependency, no magic — enough for a REST surface.
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    this.routes.push({ method, ...compile(pattern), handler, options });
    return this;
  }

  get(pattern, handler, options) { return this.add('GET', pattern, handler, options); }
  post(pattern, handler, options) { return this.add('POST', pattern, handler, options); }
  patch(pattern, handler, options) { return this.add('PATCH', pattern, handler, options); }
  put(pattern, handler, options) { return this.add('PUT', pattern, handler, options); }
  delete(pattern, handler, options) { return this.add('DELETE', pattern, handler, options); }

  /** Mounts another router under a prefix. */
  use(prefix, router) {
    for (const route of router.routes) {
      this.add(route.method, joinPath(prefix, route.pattern), route.handler, route.options);
    }
    return this;
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const found = route.regex.exec(pathname);
      if (!found) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(found[i + 1]);
      });
      return { route, params };
    }
    // Distinguishes 405 from 404 for a caller using the wrong verb.
    return pathMatched ? { methodMismatch: true } : null;
  }
}

function compile(pattern) {
  const keys = [];
  const source = pattern
    .replace(/\/$/, '')
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '/([^/]+)';
      }
      if (segment === '*') return '/(.*)';
      return segment ? `/${escapeRegex(segment)}` : '';
    })
    .join('');
  return { pattern, keys, regex: new RegExp(`^${source || '/'}/?$`) };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function joinPath(prefix, pattern) {
  const left = prefix.replace(/\/$/, '');
  const right = pattern === '/' ? '' : pattern;
  return `${left}${right}` || '/';
}
