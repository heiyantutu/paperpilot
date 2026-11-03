/**
 * Dependency-free HTML -> { title, paragraphs } extractor for the paper reader.
 * Pure ESM, no third-party imports.
 *
 * - strips script/style/nav/header/footer/aside/svg/form/iframe/noscript and comments
 * - blocks: h1-h6, p, li, blockquote, dt/dd, figcaption, caption
 * - decodes named and numeric HTML entities
 * - collapses whitespace, drops blocks shorter than 2 chars
 * - title: <title> first, then the first <h1>
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×',
  divide: '÷', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
  micro: 'µ', para: '¶', sect: '§', dagger: '†', Dagger: '‡',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ',
  lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ',
  Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  infin: '∞', ne: '≠', le: '≤', ge: '≥', asymp: '≈', equiv: '≡',
  rarr: '→', larr: '←', harr: '↔', rArr: '⇒', lArr: '⇐', hArr: '⇔',
  sum: '∑', prod: '∏', radic: '√', part: '∂', nabla: '∇', isin: '∈',
  lowast: '∗', minus: '−', shy: '\u00ad', zwj: '\u200d', zwnj: '\u200c',
  thinsp: ' ', ensp: ' ', emsp: ' ', hairsp: ' ',
  aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', iacute: 'í',
  igrave: 'ì', icirc: 'î', iuml: 'ï', ntilde: 'ñ', oacute: 'ó', ograve: 'ò',
  ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', uacute: 'ú', ugrave: 'ù',
  ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß',
  Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
  AElig: 'Æ', Ccedil: 'Ç', Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Euml: 'Ë',
  Iacute: 'Í', Igrave: 'Ì', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ', Oacute: 'Ó',
  Ograve: 'Ò', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Uacute: 'Ú',
  Ugrave: 'Ù', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
  eth: 'ð', ETH: 'Ð', thorn: 'þ', THORN: 'Þ', iexcl: '¡', iquest: '¿',
  larr: '←', uarr: '↑', darr: '↓', crarr: '↵', lArr: '⇐', uArr: '⇑', dArr: '⇓',
  forall: '∀', exist: '∃', empty: '∅', isin: '∈', notin: '∉', sub: '⊂',
  sup: '⊃', sube: '⊆', supe: '⊇', and: '∧', or: '∨', cap: '∩', cup: '∪',
  int: '∫', there4: '∴', sim: '∼', cong: '≅', asymp: '≈', ne: '≠',
  le: '≤', ge: '≥', sdot: '⋅', loz: '◊', spades: '♠', clubs: '♣',
  hearts: '♥', diams: '♦', bull: '•', hellip: '…', prime: '′', Prime: '″',
  oline: '‾', frasl: '⁄', weierp: '℘', image: 'ℑ', real: 'ℜ', trade: '™',
  alefsym: 'ℵ', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
  lang: '〈', rang: '〉', bull: '•', dagger: '†', Dagger: '‡',
};

function safeCodePoint(cp) {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return null;
  try { return String.fromCodePoint(cp); } catch { return null; }
}

export function decodeHtmlEntities(text) {
  return text.replace(/&(#[xX]?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]{1,31});/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      const decoded = safeCodePoint(cp);
      return decoded === null ? match : decoded;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : match;
  });
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ');
}

function normalizeFragment(fragment) {
  const decoded = decodeHtmlEntities(stripTags(fragment));
  return decoded.replace(/\s+/g, ' ').trim();
}

const NOISE_WITH_CONTENT = /<(script|style|noscript|template|svg|nav|header|footer|aside|form|iframe|object|canvas|audio|video)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const NOISE_SELF_CLOSING = /<(script|style|noscript|template|svg|nav|header|footer|aside|form|iframe|object|canvas|audio|video)\b[^>]*\/?>/gi;
const BLOCK_RE = /<(h[1-6]|p|li|blockquote|dt|dd|figcaption|caption)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;

/**
 * Extract title and paragraphs from an HTML document.
 * @param {string} html
 * @returns {{ title?: string, paragraphs: string[] }}
 */
export function extractHtmlText(html) {
  if (typeof html !== 'string') throw new TypeError('[html:input] expected a string');

  const doc = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const cleaned = doc.replace(NOISE_WITH_CONTENT, ' ').replace(NOISE_SELF_CLOSING, ' ');

  const blocks = [];
  let match;
  BLOCK_RE.lastIndex = 0;
  while ((match = BLOCK_RE.exec(cleaned))) {
    const text = normalizeFragment(match[2]);
    if (text.length >= 2) blocks.push(text);
  }

  if (blocks.length === 0) {
    // Malformed / fragment HTML: fall back to splitting the stripped text.
    const plain = decodeHtmlEntities(stripTags(
      cleaned
        .replace(/<br\b[^>]*\/?>/gi, '\n')
        .replace(/<\/?(?:p|div|li|h[1-6]|tr|section|article|blockquote|dt|dd|ul|ol|table)\b[^>]*>/gi, '\n'),
    ));
    for (const part of plain.split(/\n+/)) {
      const text = part.replace(/\s+/g, ' ').trim();
      if (text.length >= 2 && blocks[blocks.length - 1] !== text) blocks.push(text);
    }
  }

  let title = '';
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(doc);
  if (titleMatch) title = normalizeFragment(titleMatch[1]);
  if (!title) {
    const h1Match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(cleaned);
    if (h1Match) title = normalizeFragment(h1Match[1]);
  }

  const paragraphs = [];
  for (const block of blocks) if (paragraphs[paragraphs.length - 1] !== block) paragraphs.push(block);

  const result = { paragraphs };
  if (title && title.length >= 2) result.title = title;
  return result;
}

export default extractHtmlText;
