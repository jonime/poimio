/**
 * YouTube description boilerplate removal (spec 001, task 5).
 *
 * YouTube channel feeds put the real description in `media:description`, but
 * it is padded with promo material: "Subscribe to …" lines, "Related Videos:"
 * lists, affiliate links (Amazon Influencer, amzn.to, youtu.be), and social
 * media links. We work line-by-line on the already-cleaned plain text and
 * keep lines that carry descriptive information.
 */

/** Lines matching any of these patterns are promotional, not descriptive. */
const PROMO_LINE_PATTERNS: RegExp[] = [
  /subscribe/i,
  /related videos?/i,
  /suggested videos?/i,
  /follow (us|me|the channel)/i,
  /check out (my|our|the)/i,
  /don'?t forget to/i,
  /merch(andise)?(\s|:|$)/i,
  /amazon (influencer|partner|associate)/i,
  /affiliate/i,
  /sponsor/i,
];

/** Lines containing any URL are dropped (link and affiliate lines). */
const URL_LINE_PATTERN = /https?:\/\/\S+|\byoutu\.be\S*|\bamzn\.to\S*|\bwww\.\S+/i;

/**
 * Remove YouTube-style boilerplate lines from cleaned description text.
 *
 * A line is kept when it contains no URL and matches no promo pattern; this
 * keeps the descriptive prose while dropping subscribe, related-video,
 * affiliate, and social-link lines.
 */
export function removeYouTubeBoilerplate(text: string): string {
  if (!text) return "";

  const kept = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (line === "") return false;
      if (URL_LINE_PATTERN.test(line)) return false;
      return !PROMO_LINE_PATTERNS.some((pattern) => pattern.test(line));
    });

  return kept.join("\n");
}
