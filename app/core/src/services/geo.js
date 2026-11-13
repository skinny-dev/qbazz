import { NotFoundError } from '../errors.js';

/**
 * Turning a point on a map into a place name, and back.
 *
 * Both surfaces have a location picker — Telegram's "share location" button and
 * a browser's geolocation/map widget — and both produce coordinates. Discovery
 * needs a city name ("Shops in Lagos"), so something has to bridge the two.
 * That bridge lives here rather than in either client, so a pin dropped in chat
 * and a pin dropped on the web resolve to the same city string.
 *
 * Providers:
 *   nominatim — OpenStreetMap's free geocoder (default; no API key)
 *   none      — offline: coordinates are kept, city is left null
 *   custom    — pass `config.geo.provider = fn` to use Google, Mapbox, etc.
 *
 * Results are cached and requests are serialised, because Nominatim's usage
 * policy allows one request per second and asks for a real User-Agent.
 */
export function createGeoService(ctx) {
  const { config, log } = ctx;
  const settings = config.geo || {};
  const cache = new Map();
  let lastCall = 0;

  const providerName = typeof settings.provider === 'function' ? 'custom' : settings.provider || 'nominatim';

  /**
   * Normalises whatever a picker produced into a full location.
   * Accepts `{ city }` (typed), `{ lat, lng }` (picker), or both.
   */
  async function resolve(value) {
    if (!value) return null;

    // Typed a place name: trust it, and do not spend a geocoding call.
    if (value.city && value.lat === null) return { ...value, source: 'typed' };

    if (value.lat !== null && value.lat !== undefined && value.lng !== null && value.lng !== undefined) {
      const place = await reverse(value.lat, value.lng);
      return {
        city: value.city || place?.city || null,
        // Offered to the user for confirmation; see toPlace() for why.
        candidates: place?.candidates || (place?.city ? [place.city] : []),
        country: value.country || place?.country || null,
        address: value.address || place?.address || null,
        label: place?.label || value.label || formatCoords(value.lat, value.lng),
        lat: round(value.lat),
        lng: round(value.lng),
        source: place ? providerName : 'coordinates',
      };
    }

    return { ...value, source: 'typed' };
  }

  async function reverse(lat, lng) {
    const key = `r:${round(lat)},${round(lng)}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;

    let place = null;
    try {
      if (typeof settings.provider === 'function') place = await settings.provider({ lat, lng });
      else if (providerName === 'nominatim') place = await nominatimReverse(lat, lng);
    } catch (err) {
      // Never fail a checkout or an onboarding step because a map service is
      // down — the coordinates are still good, the city is just unknown.
      log.warn(`reverse geocode failed for ${lat},${lng}: ${err.message}`);
    }

    cache.set(key, { value: place, expires: Date.now() + (settings.cacheTtlMs ?? 86400000) });
    return place;
  }

  /** Forward search, for a web picker's "type a city" autocomplete. */
  async function search(query, { limit = 5 } = {}) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];

    const key = `s:${q.toLowerCase()}:${limit}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;

    let results = [];
    try {
      if (typeof settings.provider === 'function') results = (await settings.provider({ query: q, limit })) || [];
      else if (providerName === 'nominatim') results = await nominatimSearch(q, limit);
    } catch (err) {
      log.warn(`geocode search failed for "${q}": ${err.message}`);
    }

    cache.set(key, { value: results, expires: Date.now() + (settings.cacheTtlMs ?? 86400000) });
    return results;
  }

  // -- Nominatim -------------------------------------------------------------

  async function nominatimReverse(lat, lng) {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lng));
    url.searchParams.set('zoom', '14'); // city / suburb level
    url.searchParams.set('addressdetails', '1');

    const data = await request(url);
    if (!data?.address) return null;
    return toPlace(data);
  }

  async function nominatimSearch(query, limit) {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('addressdetails', '1');

    const data = await request(url);
    return Array.isArray(data) ? data.map(toPlace).filter(Boolean) : [];
  }

  function toPlace(entry) {
    const address = entry.address || {};

    /**
     * There is no field that reliably holds the city people actually say.
     * OpenStreetMap's Nigerian data, for instance, returns Lagos as
     * county "Shomolu" / state "Lagos", Ibadan as "Ona Ara" / "Oyo" (neither
     * is Ibadan), and Abuja as a plain city. So rather than guess, return the
     * plausible names best-first and let the person confirm which one to show
     * buyers — the coordinates stay exact either way.
     */
    const candidates = [
      address.city,
      address.town,
      address.village,
      address.municipality,
      address.county,
      address.state_district,
      address.state,
    ].filter((name, index, all) => name && all.indexOf(name) === index);

    return {
      city: candidates[0] || null,
      candidates,
      country: address.country || null,
      countryCode: (address.country_code || '').toUpperCase() || null,
      address: entry.display_name || null,
      label: [candidates[0], address.country].filter(Boolean).join(', ') || entry.display_name || null,
      lat: entry.lat ? round(Number(entry.lat)) : null,
      lng: entry.lon ? round(Number(entry.lon)) : null,
    };
  }

  /** One request at a time, one per second, with a real User-Agent. */
  async function request(url) {
    const gap = settings.minIntervalMs ?? 1100;
    const wait = Math.max(0, lastCall + gap - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs ?? 5000);
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': settings.userAgent || `${config.platform.name}/1.0 (${config.platform.webBaseUrl})`,
          'accept-language': config.platform.defaultLocale || 'en',
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function lookupOrFail(lat, lng) {
    const place = await reverse(lat, lng);
    if (!place) throw new NotFoundError('Place');
    return place;
  }

  return { resolve, reverse, search, lookupOrFail, provider: providerName };
}

function round(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

export function formatCoords(lat, lng) {
  return `${round(lat)}, ${round(lng)}`;
}
