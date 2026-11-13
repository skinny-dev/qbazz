/**
 * Puts what a search engine reads into the page before it leaves the server: the head tags and structured data, and
 * a plain readable body inside #root. The browser's app then replaces the body; a crawler that never runs scripts
 * (and the preview a chat app builds from a link) still gets the whole page. Core decides what is in it
 * (`/seo/render`), so this file only moves the pieces.
 */
const CORE = (process.env.QBAZZ_CORE_URL || process.env.VITE_QBAZZ_API_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');

/** Returns `{ html, status }`; on any failure the page is served as it is, so a core hiccup never blanks the site. */
export async function inject(template, pathname) {
  try {
    const res = await fetch(`${CORE}/seo/render?path=${encodeURIComponent(pathname)}`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { html: template, status: 200 };
    const page = await res.json();
    if (!page.prerender) return { html: template, status: 200 };
    const html = template
      .replace(/<title>[\s\S]*?<\/title>/i, '')
      .replace('</head>', `    ${page.head}\n  </head>`)
      .replace('<div id="root"></div>', `<div id="root">${page.body}</div>`);
    return { html, status: page.status || 200 };
  } catch {
    return { html: template, status: 200 };
  }
}

export { CORE };
