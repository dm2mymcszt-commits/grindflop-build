/**
 * What is drawn in place of a photo the explicit-photo filter is holding
 * back: a plain dark tile with a crossed-out eye.
 *
 * A picture rather than a missing one on purpose. Leaving hidden photos out
 * made an album of five read "0" and "no media", which looks like a bug; a
 * tile in each one's place keeps the count true and says something is there.
 * Being an ordinary image, it also drops into every grid, carousel and
 * full-screen viewer as it is, with every position unchanged.
 */

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">
<rect width="240" height="240" fill="#1b2330"/>
<g transform="translate(84 84) scale(3)" fill="none" stroke="#8b96a8" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/>
<path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/>
<path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/>
<path d="m2 2 20 20"/>
</g>
</svg>`;

export const HIDDEN_MEDIA_MIME = "image/svg+xml";
export const HIDDEN_MEDIA_PLACEHOLDER = `data:${HIDDEN_MEDIA_MIME};utf8,${encodeURIComponent(SVG)}`;
