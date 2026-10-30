/**
 * Mystery Item's own images: the script the apps run in Google Images (on the player's own phone, never here) to find
 * the results' thumbnails. Served at GET /api/mystery/scraper, so a change in Google's page is fixed here without a new
 * app (the app keeps a copy of it for when this can't be read). It returns up to 12 sources: data: URIs (the first
 * thumbnails, inlined) and encrypted-tbn*.gstatic.com links, skipping the page's small icons.
 */
export const SCRAPER = `(() => {
  const out = [];
  for (const img of document.querySelectorAll("img")) {
    const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
    const thumb = (src.startsWith("data:image/") && src.length > 2500) || /^https:\\/\\/encrypted-tbn\\d?\\.gstatic\\.com\\//.test(src);
    if (!thumb || (img.naturalWidth && img.naturalWidth < 48)) continue;
    if (!out.includes(src)) out.push(src);
    if (out.length >= 12) break;
  }
  return JSON.stringify(out);
})()`;
