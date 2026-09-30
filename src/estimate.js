/**
 * Output-token estimation for streamed deltas.
 *
 * A stream reports text as it arrives and usage only at the end, so a cutoff
 * that must fire *before* the ceiling cannot wait for the provider's own count.
 * DSH's estimator uses a flat 4 characters per token, which is close enough for
 * English prose and badly wrong for CJK — one ideograph is roughly one token,
 * not a quarter of one. A plugin whose whole job is "stop just before the limit"
 * cannot inherit that error, so this module splits the two cases.
 *
 * @module dsh-auto-stop/estimate
 */

/**
 * One match per wide character: CJK ideographs and their extensions, kana,
 * Hangul, CJK punctuation and full-width forms.
 *
 * Emoji and other emoji-adjacent symbol blocks are deliberately *not* included:
 * they arrive as surrogate pairs, which the character count already
 * over-counts, so the default divisor alone keeps them pessimistic.
 */
const WIDE_CHARACTER = /[\u{1100}-\u{115F}\u{2E80}-\u{303E}\u{3041}-\u{33FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{A000}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE30}-\u{FE4F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{20000}-\u{2FA1F}]/gu

/**
 * Count how many of `text`'s UTF-16 units are wide characters.
 *
 * @param {string} text - the text to scan.
 * @returns {number} the number of wide characters in it.
 */
function countWide(text) {
  let wide = 0
  WIDE_CHARACTER.lastIndex = 0
  while (WIDE_CHARACTER.exec(text) !== null) wide += 1
  return wide
}

/**
 * Estimate the output tokens one piece of streamed text costs.
 *
 * @param {unknown} text - one chunk's text, or anything else.
 * @param {{ charsPerToken: number, cjkTokensPerChar: number }} options - the
 * resolved estimator settings.
 * @returns {number} the estimate, never negative; `0` for non-text input.
 */
export function estimateText(text, options) {
  if (typeof text !== 'string' || text.length === 0) return 0
  const wide = countWide(text)
  const narrow = text.length - wide
  return wide * options.cjkTokensPerChar + narrow / options.charsPerToken
}