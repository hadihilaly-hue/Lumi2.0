// Hash router for the student-home redesign v1 (docs/STUDENT_HOME_REDESIGN.md §4.3).
// Session 1 knows two routes: `home` (default) and `class`.
//
// Route wire format (all client-side; no server rewrites):
//   `` or `#home`                       -> {name:'home'}
//   `#class/<courseB64>/<teacherEmailB64>` -> {name:'class', course, teacher}
// Anything else falls back to `home`.
//
// CRITICAL — preserving `?mode=test` (spec §4.5). Every pushState() call keeps
// `location.search` verbatim; a router that writes just `#hash` would strip the
// query and break TM-1..TM-4. The pure buildRouteUrl() below is the choke point.

// ── Base64URL for course/teacher segments ────────────────────────────────────
// Regular btoa/atob would emit `/` and `+` which conflict with the URL hash
// grammar. base64url swaps them for `-` and `_` and strips padding — matches
// how the rest of the modern web encodes ids in URLs.
function b64urlEncode(s) {
  // encodeURIComponent -> UTF-8 percent-escaping so btoa never chokes on
  // non-ASCII (e.g. em-dash in "Modernist Poetry Workshop (H)"). Then decode
  // back to raw bytes for btoa.
  const bytes = unescape(encodeURIComponent(String(s)));
  return btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return null;
  }
}

// ── Pure parsing / URL building (unit-tested; no DOM/history dependency) ─────

/** Parse a `location.hash` string into a route object. */
export function parseHash(hash) {
  const raw = String(hash || '');
  // Accept both `#foo` and `foo` (some callers strip the leading #).
  const h = raw.startsWith('#') ? raw.slice(1) : raw;
  if (h === '' || h === 'home') return { name: 'home' };
  if (h.startsWith('class/')) {
    const parts = h.split('/');
    if (parts.length !== 3) return { name: 'home' };
    const course = b64urlDecode(parts[1]);
    const teacher = b64urlDecode(parts[2]);
    if (!course || !teacher) return { name: 'home' };
    return { name: 'class', course, teacher };
  }
  return { name: 'home' };
}

/** Build the hash string for a route (no leading `#`). */
export function buildHash(route) {
  if (!route || route.name === 'home') return 'home';
  if (route.name === 'class') {
    return `class/${b64urlEncode(route.course)}/${b64urlEncode(route.teacher)}`;
  }
  return 'home';
}

/**
 * Build the full URL to push, PRESERVING `search` so `?mode=test` survives.
 * The `search` argument must include its leading `?` if present, or be `''`.
 */
export function buildRouteUrl(route, search) {
  const s = search && !search.startsWith('?') ? `?${search}` : (search || '');
  return `${s}#${buildHash(route)}`;
}

// ── DOM-side wire-up (skipped by the offline test suite) ─────────────────────

// The parseHash / buildHash / buildRouteUrl exports are the pure surface. The
// functions below touch window/history/location and are only ever called from
// live boot code, so they don't appear in unit tests.

let _handlers = { onHome: () => {}, onClass: () => {} };
let _wired = false;

function dispatch(route) {
  if (route.name === 'class') _handlers.onClass(route);
  else _handlers.onHome(route);
}

/** Wire the router to the current window. Idempotent — safe to call once. */
export function initRouter(handlers) {
  _handlers = { onHome: () => {}, onClass: () => {}, ..._handlers, ...handlers };
  if (!_wired) {
    window.addEventListener('hashchange', () => dispatch(parseHash(location.hash)));
    _wired = true;
  }
  dispatch(parseHash(location.hash));
}

/** Navigate to home, preserving the current query string. */
export function navHome() {
  const url = buildRouteUrl({ name: 'home' }, location.search);
  history.pushState({ route: 'home' }, '', url);
  dispatch({ name: 'home' });
}

/** Navigate to a class view, preserving the current query string. */
export function navClass(course, teacher) {
  const route = { name: 'class', course, teacher };
  const url = buildRouteUrl(route, location.search);
  history.pushState({ route: 'class' }, '', url);
  dispatch(route);
}
