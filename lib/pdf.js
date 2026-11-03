/**
 * Zero-dependency PDF text extraction for the DSH paper reader plugin.
 * Pure ESM, Node built-ins only (node:zlib). No third-party imports.
 *
 * Pipeline: header -> xref/objects -> page tree -> content stream tokens
 *           -> text items (font decode + coordinates) -> layout (lines,
 *           columns, noise) -> paragraphs.
 *
 * Every thrown Error is prefixed with the stage that failed, e.g.
 * "[pdf:xref] ..." so failures are easy to locate.
 *
 * Public API:
 *   extractPdfText(bytes: Uint8Array | Buffer)
 *     : Promise<{ title?: string, paragraphs: string[] }>
 */

import { inflateRawSync, inflateSync, constants as zlibConstants } from 'node:zlib';

// ---------------------------------------------------------------------------
// Small PDF object model
// ---------------------------------------------------------------------------

class Name { constructor(name) { this.name = name; } }
class Ref { constructor(num, gen) { this.num = num; this.gen = gen; } }
class Op { constructor(op) { this.op = op; } }
class PdfStream { constructor(dict, start, end) { this.dict = dict; this.start = start; this.end = end; } }

const EOF = Symbol('EOF');
const IDENT = [1, 0, 0, 1, 0, 0];

const HEX = new Int16Array(256).fill(-1);
for (let i = 0; i < 10; i++) HEX[0x30 + i] = i;
for (let i = 0; i < 6; i++) { HEX[0x41 + i] = 10 + i; HEX[0x61 + i] = 10 + i; }

const isWsByte = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelimByte = (c) => c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b
  || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

function fail(stage, message, cause) {
  const err = new Error(`[pdf:${stage}] ${message}`);
  if (cause) err.cause = cause;
  return err;
}

const asDict = (v) => (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === null ? v : null);
const nameOf = (v) => (v instanceof Name ? v.name : null);
const numOf = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const codeOf = (v) => (typeof v === 'string' ? v : null);

// ---------------------------------------------------------------------------
// Tokenizer / object parser (works on raw bytes; strings stay as byte arrays)
// ---------------------------------------------------------------------------

class Lexer {
  constructor(bytes, pos = 0) { this.bytes = bytes; this.pos = pos; }

  skipWs() {
    const b = this.bytes;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWsByte(c)) { this.pos++; continue; }
      if (c === 0x25) { // % comment until end of line
        this.pos++;
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
        continue;
      }
      break;
    }
  }

  readValue() {
    this.skipWs();
    const b = this.bytes;
    if (this.pos >= b.length) return EOF;
    const c = b[this.pos];
    if (c === 0x2f) return this.readName();
    if (c === 0x28) return this.readLiteralString();
    if (c === 0x3c) return b[this.pos + 1] === 0x3c ? this.readDict() : this.readHexString();
    if (c === 0x5b) return this.readArray();
    if (c === 0x3e) { this.pos += b[this.pos + 1] === 0x3e ? 2 : 1; return new Op('>'); }
    if (c === 0x5d) { this.pos++; return new Op(']'); }
    if (c === 0x7b) { this.pos++; return new Op('{'); }
    if (c === 0x7d) { this.pos++; return new Op('}'); }
    if (c === 0x29) { this.pos++; return new Op(')'); }
    if (c === 0x2b || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39)) return this.readNumberOrRef();
    return this.readKeyword();
  }

  readNumber() {
    const b = this.bytes;
    let sign = 1;
    if (b[this.pos] === 0x2d) { sign = -1; this.pos++; } else if (b[this.pos] === 0x2b) this.pos++;
    let int = 0; let any = false;
    while (this.pos < b.length && b[this.pos] >= 0x30 && b[this.pos] <= 0x39) { int = int * 10 + (b[this.pos] - 0x30); this.pos++; any = true; }
    let frac = 0;
    if (b[this.pos] === 0x2e) {
      this.pos++;
      let scale = 0.1;
      while (this.pos < b.length && b[this.pos] >= 0x30 && b[this.pos] <= 0x39) { frac += (b[this.pos] - 0x30) * scale; scale *= 0.1; this.pos++; any = true; }
    }
    return any ? sign * (int + frac) : 0;
  }

  readNumberOrRef() {
    const num = this.readNumber();
    if (!Number.isInteger(num) || num < 0) return num;
    const save = this.pos;
    this.skipWs();
    let c = this.bytes[this.pos];
    if (c >= 0x30 && c <= 0x39) {
      const gen = this.readNumber();
      if (Number.isInteger(gen) && gen >= 0) {
        this.skipWs();
        if (this.bytes[this.pos] === 0x52) { // 'R'
          const next = this.bytes[this.pos + 1];
          if (next === undefined || isWsByte(next) || isDelimByte(next)) { this.pos++; return new Ref(num, gen); }
        }
      }
    }
    this.pos = save;
    return num;
  }

  readName() {
    const b = this.bytes;
    this.pos++;
    let s = '';
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWsByte(c) || isDelimByte(c)) break;
      if (c === 0x23) { // '#'
        const h = HEX[b[this.pos + 1]]; const h2 = HEX[b[this.pos + 2]];
        if (h >= 0 && h2 >= 0) { s += String.fromCharCode(h * 16 + h2); this.pos += 3; continue; }
      }
      s += String.fromCharCode(c);
      this.pos++;
    }
    return new Name(s);
  }

  readLiteralString() {
    const b = this.bytes;
    this.pos++;
    const out = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x5c) { // backslash
        const n = b[this.pos];
        if (n === undefined) break;
        if (n === 0x6e) { out.push(10); this.pos++; }
        else if (n === 0x72) { out.push(13); this.pos++; }
        else if (n === 0x74) { out.push(9); this.pos++; }
        else if (n === 0x62) { out.push(8); this.pos++; }
        else if (n === 0x66) { out.push(12); this.pos++; }
        else if (n === 0x28) { out.push(0x28); this.pos++; }
        else if (n === 0x29) { out.push(0x29); this.pos++; }
        else if (n === 0x5c) { out.push(0x5c); this.pos++; }
        else if (n >= 0x30 && n <= 0x37) {
          let oct = 0; let k = 0;
          while (k < 3 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37) { oct = oct * 8 + (b[this.pos] - 0x30); this.pos++; k++; }
          out.push(oct & 0xff);
        } else if (n === 0x0d) { this.pos++; if (b[this.pos] === 0x0a) this.pos++; }
        else if (n === 0x0a) { this.pos++; }
        else { out.push(n); this.pos++; }
        continue;
      }
      if (c === 0x28) { depth++; out.push(c); continue; }
      if (c === 0x29) { depth--; if (depth === 0) break; out.push(c); continue; }
      out.push(c);
    }
    return new Uint8Array(out);
  }

  readHexString() {
    const b = this.bytes;
    this.pos++;
    const out = [];
    let hi = -1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x3e) break;
      const v = HEX[c];
      if (v < 0) continue;
      if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
    }
    if (hi >= 0) out.push(hi * 16);
    return new Uint8Array(out);
  }

  readArray() {
    this.pos++;
    const arr = [];
    for (;;) {
      const v = this.readValue();
      if (v === EOF) break;
      if (v instanceof Op) { if (v.op === ']') break; continue; }
      arr.push(v);
    }
    return arr;
  }

  readDict() {
    this.pos += 2;
    const dict = Object.create(null);
    for (;;) {
      const key = this.readValue();
      if (key === EOF) break;
      if (key instanceof Op) { if (key.op === '>') break; continue; }
      if (!(key instanceof Name)) { continue; }
      const value = this.readValue();
      if (value === EOF) break;
      if (value instanceof Op && value.op === '>') { dict[key.name] = null; break; }
      dict[key.name] = value;
    }
    return dict;
  }

  readKeyword() {
    const b = this.bytes;
    const start = this.pos;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWsByte(c) || isDelimByte(c)) break;
      this.pos++;
    }
    const word = start === this.pos
      ? String.fromCharCode(b[this.pos++]) // safety: never loop forever on junk delimiters
      : String.fromCharCode(...b.subarray(start, this.pos));
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new Op(word);
  }
}

// ---------------------------------------------------------------------------
// Matrix helpers (PDF row-vector convention: point' = point * M)
// ---------------------------------------------------------------------------

function mul(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

const translate = (tx, ty) => [1, 0, 0, 1, tx, ty];
const transformPoint = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// ---------------------------------------------------------------------------
// Stream filters
// ---------------------------------------------------------------------------

function inflateBytes(data) {
  try { return inflateSync(data); } catch (e1) {
    try { return inflateSync(data, { finishFlush: zlibConstants.Z_SYNC_FLUSH }); } catch (e2) {
      try { return inflateRawSync(data, { finishFlush: zlibConstants.Z_SYNC_FLUSH }); } catch (e3) {
        throw fail('stream', `FlateDecode failed: ${e1.message}`, e1);
      }
    }
  }
}

function asciiHexDecode(data) {
  const out = [];
  let hi = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x3e) break;
    const v = HEX[c];
    if (v < 0) continue;
    if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
}

function ascii85Decode(data) {
  const out = [];
  let group = [];
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // '~>' end marker
    if (isWsByte(c)) continue;
    if (c === 0x7a && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    for (let k = 0; k < n - 1; k++) out.push(bytes[k]);
  }
  return Uint8Array.from(out);
}

function runLengthDecode(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const len = data[i++];
    if (len === 128) break;
    if (len < 128) { for (let k = 0; k <= len && i < data.length; k++) out.push(data[i++]); }
    else { const b = data[i++] ?? 0; for (let k = 0; k < 257 - len; k++) out.push(b); }
  }
  return Uint8Array.from(out);
}

function applyPredictor(data, parms) {
  const pred = numOf(parms.Predictor, 1);
  if (pred <= 1) return data;
  const colors = numOf(parms.Colors, 1);
  const bpc = numOf(parms.BitsPerComponent, 8);
  const columns = numOf(parms.Columns, 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (rowLen <= 0) return data;
  if (pred === 2) { // TIFF predictor (8bpc only)
    if (bpc !== 8) return data;
    const out = Uint8Array.from(data);
    for (let row = 0; row * rowLen < out.length; row++) {
      for (let i = bpp; i < rowLen; i++) {
        const idx = row * rowLen + i;
        if (idx < out.length) out[idx] = (out[idx] + out[idx - bpp]) & 255;
      }
    }
    return out;
  }
  const rows = Math.ceil(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let p = 0;
  for (let r = 0; r < rows; r++) {
    const filter = data[p++] ?? 0;
    const rowStart = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const raw = data[p++] ?? 0;
      const left = i >= bpp ? out[rowStart + i - bpp] : 0;
      const up = r > 0 ? out[rowStart - rowLen + i] : 0;
      const upLeft = r > 0 && i >= bpp ? out[rowStart - rowLen + i - bpp] : 0;
      let v;
      switch (filter) {
        case 1: v = raw + left; break;
        case 2: v = raw + up; break;
        case 3: v = raw + ((left + up) >> 1); break;
        case 4: {
          const pa = Math.abs(up - upLeft); const pb = Math.abs(left - upLeft);
          const pc = Math.abs(left + up - 2 * upLeft);
          v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: v = raw;
      }
      out[rowStart + i] = v & 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text encoding tables (ASCII + WinAnsi + common TeX / Adobe glyph names)
// ---------------------------------------------------------------------------

const WIN_ANSI_EXTRA = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function encodingLookup(name, code) {
  if (name === 'StandardEncoding') {
    if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code);
    if (code === 0x27) return '’';
    if (code === 0x60) return '‘';
    if (code >= 0xa0 && code <= 0xff) return String.fromCharCode(code);
    return null;
  }
  if (name === 'MacRomanEncoding') return code >= 0x20 ? String.fromCharCode(code) : null;
  // WinAnsiEncoding (default for anything unknown)
  if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code);
  if (WIN_ANSI_EXTRA[code]) return WIN_ANSI_EXTRA[code];
  if (code >= 0xa0) return String.fromCharCode(code);
  return null;
}

const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
  ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*',
  plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', zero: '0', one: '1',
  two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>',
  question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']',
  asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|',
  braceright: '}', asciitilde: '~', exclamdown: '¡', cent: '¢', sterling: '£',
  currency: '¤', yen: '¥', brokenbar: '¦', section: '§', dieresis: '¨',
  copyright: '©', ordfeminine: 'ª', guillemotleft: '«', logicalnot: '¬',
  sfthyphen: '-', registered: '®', fraction: '⁄', macron: '¯', degree: '°', plusminus: '±',
  twosuperior: '²', threesuperior: '³', acute: '´', paragraph: '¶',
  periodcentered: '·', cedilla: '¸', onesuperior: '¹', ordmasculine: 'º',
  guillemotright: '»', onequarter: '¼', onehalf: '½', threequarters: '¾',
  questiondown: '¿', multiply: '×', divide: '÷',
  ff: 'ff', fi: 'fi', fl: 'fl', ffi: 'ffi', ffl: 'ffl',
  quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”',
  quotesinglbase: '‚', quotedblbase: '„', guilsinglleft: '‹', guilsinglright: '›',
  endash: '–', emdash: '—', bullet: '•', ellipsis: '…', dagger: '†',
  daggerdbl: '‡', perthousand: '‰', trademark: '™', minute: '′', second: '″',
  Euro: '€', florin: 'ƒ', dotlessi: 'ı', dotlessj: 'ȷ', germandbls: 'ß',
  ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', oslash: 'ø', Oslash: 'Ø', lslash: 'ł',
  Lslash: 'Ł', agrave: 'à', aacute: 'á', acircumflex: 'â', atilde: 'ã',
  adieresis: 'ä', aring: 'å', ccedilla: 'ç', egrave: 'è', eacute: 'é',
  ecircumflex: 'ê', edieresis: 'ë', igrave: 'ì', iacute: 'í', icircumflex: 'î',
  idieresis: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocircumflex: 'ô',
  otilde: 'õ', odieresis: 'ö', ugrave: 'ù', uacute: 'ú', ucircumflex: 'û',
  udieresis: 'ü', yacute: 'ý', ydieresis: 'ÿ', Agrave: 'À', Aacute: 'Á',
  Acircumflex: 'Â', Atilde: 'Ã', Adieresis: 'Ä', Aring: 'Å', Ccedilla: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecircumflex: 'Ê', Edieresis: 'Ë', Igrave: 'Ì',
  Iacute: 'Í', Icircumflex: 'Î', Idieresis: 'Ï', Ntilde: 'Ñ', Ograve: 'Ò',
  Oacute: 'Ó', Ocircumflex: 'Ô', Otilde: 'Õ', Odieresis: 'Ö', Ugrave: 'Ù',
  Uacute: 'Ú', Ucircumflex: 'Û', Udieresis: 'Ü', Yacute: 'Ý',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Alpha: 'Α', Beta: 'Β', Gamma: 'Γ',
  Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ', Eta: 'Η', Theta: 'Θ', Iota: 'Ι',
  Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ', Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π',
  Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ',
  Omega: 'Ω', epsilon1: 'ϵ', theta1: 'ϑ', phi1: 'ϕ', sigma1: 'ς', rho1: 'ϱ',
  omega1: 'ϖ', Upsilon1: 'ϒ', minus: '−', asteriskmath: '∗', dotmath: '⋅',
  summationtext: '∑', summationdisplay: '∑', integraltext: '∫', integraldisplay: '∫',
  producttext: '∏', productdisplay: '∏', radical: '√', radicalbig: '√',
  infinity: '∞', partialdiff: '∂', nabla: '∇', gradient: '∇', element: '∈',
  notelement: '∉', suchthat: '∋', union: '∪', intersection: '∩',
  propersubset: '⊂', propersuperset: '⊃', reflexsubset: '⊆', reflexsuperset: '⊇',
  emptyset: '∅', logicaland: '∧', logicalor: '∨', universal: '∀',
  existential: '∃', therefore: '∴', similar: '∼', approxequal: '≈',
  equivalence: '≡', lessequal: '≤', greaterequal: '≥', notequal: '≠',
  proportional: '∝', angle: '∠', perpendicular: '⊥', arrowleft: '←',
  arrowright: '→', arrowup: '↑', arrowdown: '↓', arrowboth: '↔',
  arrowdblleft: '⇐', arrowdblright: '⇒', arrowdblboth: '⇔', arrowdblup: '⇑',
  arrowdbldown: '⇓', circlemultiply: '⊗', circleplus: '⊕', circledot: '⊙',
  circleminus: '⊖', openbullet: '◦', diamondmath: '⋄', triangle: '△',
  triangleinv: '▽', floorleft: '⌊', floorright: '⌋', ceilingleft: '⌈',
  ceilingright: '⌉', angbracketleft: '⟨', angbracketright: '⟩', bardbl: '‖',
  prime: '′', backslashmath: '∖', latticetop: '⊤', aleph: 'ℵ', Ifraktur: 'ℑ',
  Rfraktur: 'ℜ', weierstrass: '℘', club: '♣', diamond: '♦', heart: '♥',
  spade: '♠', dotaccent: '˙', ring: '˚', hungarumlaut: '˝', ogonek: '˛',
  caron: 'ˇ', breve: '˘', circumflex: 'ˆ', tilde: '˜', suppress: '',
  compwordmark: '', visiblespace: ' ', dotlessjmath: 'ȷ',
};
for (let i = 0; i < 26; i++) {
  GLYPHS[String.fromCharCode(97 + i)] = String.fromCharCode(97 + i);
  GLYPHS[String.fromCharCode(65 + i)] = String.fromCharCode(65 + i);
}

function glyphNameToUnicode(rawName) {
  if (!rawName) return null;
  if (Object.prototype.hasOwnProperty.call(GLYPHS, rawName)) return GLYPHS[rawName];
  const dot = rawName.indexOf('.');
  if (dot > 0) return glyphNameToUnicode(rawName.slice(0, dot));
  const under = rawName.indexOf('_');
  if (under > 0) {
    const a = glyphNameToUnicode(rawName.slice(0, under));
    const b = glyphNameToUnicode(rawName.slice(under + 1));
    if (a !== null && b !== null) return a + b;
  }
  if (rawName.length === 1) return rawName;
  let m = /^uni([0-9A-Fa-f]{4,6})$/.exec(rawName);
  if (m) return safeCodePoint(parseInt(m[1], 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(rawName);
  if (m) return safeCodePoint(parseInt(m[1], 16));
  return null;
}

function safeCodePoint(cp) {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return null;
  try { return String.fromCodePoint(cp); } catch { return null; }
}

// ---------------------------------------------------------------------------
// ToUnicode CMap parsing (bfchar / bfrange, incl. double-byte codes)
// ---------------------------------------------------------------------------

function bytesToInt(bytes) {
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
}

function utf16beToString(bytes) {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  if (bytes.length % 2) s += String.fromCharCode(bytes[bytes.length - 1]);
  return s;
}

function incrementBytes(bytes, add) {
  if (bytes.length === 0) return bytes;
  let v = bytesToInt(bytes) + add;
  const out = new Uint8Array(bytes.length);
  for (let i = bytes.length - 1; i >= 0; i--) { out[i] = v & 255; v = Math.floor(v / 256); }
  return out;
}

function hexToBytes(str) {
  const out = [];
  let hi = -1;
  for (let i = 0; i < str.length; i++) {
    const v = HEX[str.charCodeAt(i)];
    if (v < 0) continue;
    if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) out.push(hi * 16);
  return new Uint8Array(out);
}

function tokenizeCMap(text) {
  const tokens = [];
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0') { i++; continue; }
    if (c === '%') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '(') {
      let depth = 1; let j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '(') depth++;
        else if (text[j] === ')') depth--;
        j++;
      }
      i = j;
      continue;
    }
    if (c === '<') {
      const j = text.indexOf('>', i + 1);
      if (j < 0) break;
      tokens.push({ t: 'hex', bytes: hexToBytes(text.slice(i + 1, j)) });
      i = j + 1;
      continue;
    }
    if (c === '[' || c === ']') { tokens.push({ t: 'delim', v: c }); i++; continue; }
    if (c === '/') {
      const m = /^\/[^\s<>\[\]()\/%{}]+/.exec(text.slice(i));
      tokens.push({ t: 'name', v: m ? m[0].slice(1) : '' });
      i += m ? m[0].length : 1;
      continue;
    }
    const m = /^[^\s<>\[\]()\/%{}]+/.exec(text.slice(i));
    tokens.push({ t: 'word', v: m ? m[0] : c });
    i += m ? m[0].length : 1;
  }
  return tokens;
}

function parseToUnicodeCMap(bytes) {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const tokens = tokenizeCMap(text);
  const map = new Map();
  let codeBytes = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.t !== 'word') continue;
    if (tk.v === 'begincodespacerange') {
      let j = i + 1;
      while (j + 1 < tokens.length && !(tokens[j].t === 'word' && tokens[j].v === 'endcodespacerange')) {
        const lo = tokens[j];
        if (lo.t === 'hex' && lo.bytes.length) codeBytes = Math.max(codeBytes, lo.bytes.length);
        j += 2;
      }
      i = j;
    } else if (tk.v === 'beginbfchar') {
      let j = i + 1;
      while (j + 1 < tokens.length && !(tokens[j].t === 'word' && tokens[j].v === 'endbfchar')) {
        const src = tokens[j]; const dst = tokens[j + 1];
        if (src.t === 'hex' && dst.t === 'hex' && src.bytes.length) map.set(bytesToInt(src.bytes), utf16beToString(dst.bytes));
        j += 2;
      }
      i = j;
    } else if (tk.v === 'beginbfrange') {
      let j = i + 1;
      while (j < tokens.length && !(tokens[j].t === 'word' && tokens[j].v === 'endbfrange')) {
        const lo = tokens[j]; const hi = tokens[j + 1];
        if (!lo || !hi || lo.t !== 'hex' || hi.t !== 'hex') { j++; continue; }
        const start = bytesToInt(lo.bytes);
        const end = bytesToInt(hi.bytes);
        const dst = tokens[j + 2];
        if (dst && dst.t === 'hex') {
          const base = dst.bytes;
          const total = Math.min(end - start, 65535);
          for (let k = 0; k <= total; k++) map.set(start + k, utf16beToString(incrementBytes(base, k)));
          j += 3;
        } else if (dst && dst.t === 'delim' && dst.v === '[') {
          let k = 0; let p = j + 3;
          while (p < tokens.length && !(tokens[p].t === 'delim' && tokens[p].v === ']')) {
            if (tokens[p].t === 'hex') map.set(start + k, utf16beToString(tokens[p].bytes));
            k++; p++;
          }
          j = p + 1;
        } else {
          j += 2;
        }
      }
      i = j;
    }
  }
  return { map, codeBytes };
}

// ---------------------------------------------------------------------------
// Font handling (simple fonts + Type0/CID, ToUnicode + /Encoding fallback)
// ---------------------------------------------------------------------------

class FontInfo {
  constructor(doc, dict) {
    this.doc = doc;
    this.dict = dict;
    this.isType0 = nameOf(doc.resolve(dict.Subtype)) === 'Type0';
    this.codeBytes = this.isType0 ? 2 : 1;
    this.toUnicode = null;
    this.ready = false;
    this.encBase = 'WinAnsiEncoding';
    this.encDiffs = null;
    this.firstChar = 0;
    this.widths = null;
    this.missingWidth = 500;
    this.cidWidths = null;
    this.defaultWidth = 1000;
    this.unmapped = 0;
  }

  ensure() {
    if (this.ready) return this;
    this.ready = true;
    try {
      const tu = this.doc.resolve(this.dict.ToUnicode);
      if (tu instanceof PdfStream) {
        const cmap = parseToUnicodeCMap(this.doc.decodeStream(tu));
        this.toUnicode = cmap.map.size ? cmap.map : null;
        if (this.isType0 && cmap.codeBytes) this.codeBytes = cmap.codeBytes;
      }
    } catch { this.toUnicode = null; }
    try {
      if (this.isType0) this.loadType0(); else this.loadSimple();
    } catch { /* keep defaults */ }
    return this;
  }

  loadSimple() {
    const doc = this.doc;
    const encRaw = doc.resolve(this.dict.Encoding);
    const encDict = asDict(encRaw);
    if (encRaw instanceof Name) this.encBase = encRaw.name;
    else if (encDict) {
      const base = doc.resolve(encDict.BaseEncoding);
      if (base instanceof Name) this.encBase = base.name;
      const diffs = doc.resolve(encDict.Differences);
      if (Array.isArray(diffs)) {
        this.encDiffs = new Map();
        let code = 0;
        for (const item of diffs) {
          const resolved = doc.resolve(item);
          if (typeof resolved === 'number') { code = resolved; continue; }
          const nm = nameOf(resolved);
          if (nm !== null) {
            const uni = glyphNameToUnicode(nm);
            this.encDiffs.set(code, uni === null ? '' : uni);
            code++;
          } else code++;
        }
      }
    }
    const first = doc.resolve(this.dict.FirstChar);
    if (typeof first === 'number') this.firstChar = first;
    const widths = doc.resolve(this.dict.Widths);
    if (Array.isArray(widths)) this.widths = widths.map((w) => numOf(doc.resolve(w), 0));
    const desc = asDict(doc.resolve(this.dict.FontDescriptor));
    if (desc) {
      const mw = doc.resolve(desc.MissingWidth);
      if (typeof mw === 'number') this.missingWidth = mw;
    }
  }

  loadType0() {
    const doc = this.doc;
    const descArr = doc.resolve(this.dict.DescendantFonts);
    const cidFont = asDict(doc.resolve(Array.isArray(descArr) ? descArr[0] : descArr));
    if (!cidFont) return;
    const dw = doc.resolve(cidFont.DW);
    if (typeof dw === 'number') this.defaultWidth = dw;
    const w = doc.resolve(cidFont.W);
    if (!Array.isArray(w)) return;
    const widths = new Map();
    let i = 0;
    while (i < w.length) {
      const firstRaw = doc.resolve(w[i]);
      const first = typeof firstRaw === 'number' ? firstRaw : null;
      if (first === null) { i++; continue; }
      const next = doc.resolve(w[i + 1]);
      if (Array.isArray(next)) {
        for (let k = 0; k < next.length; k++) {
          const v = doc.resolve(next[k]);
          if (typeof v === 'number') widths.set(first + k, v);
        }
        i += 2;
      } else if (typeof next === 'number') {
        const width = doc.resolve(w[i + 2]);
        if (typeof width === 'number') for (let c = first; c <= next && c - first < 65536; c++) widths.set(c, width);
        i += 3;
      } else i += 2;
    }
    this.cidWidths = widths;
  }

  lookupEncoding(code) {
    if (this.encDiffs && this.encDiffs.has(code)) {
      const v = this.encDiffs.get(code);
      return v === '' ? null : v;
    }
    return encodingLookup(this.encBase, code);
  }

  widthOf(code) {
    if (this.isType0) {
      const w = this.cidWidths ? this.cidWidths.get(code) : undefined;
      return typeof w === 'number' ? w : this.defaultWidth;
    }
    if (this.widths) {
      const idx = code - this.firstChar;
      if (idx >= 0 && idx < this.widths.length) return this.widths[idx];
    }
    return this.missingWidth;
  }

  decode(bytes) {
    this.ensure();
    const out = [];
    const step = this.codeBytes;
    for (let i = 0; i < bytes.length;) {
      let code;
      let consumed;
      if (step === 2 && i + 1 < bytes.length) { code = (bytes[i] << 8) | bytes[i + 1]; consumed = 2; }
      else { code = bytes[i]; consumed = 1; }
      let text;
      if (this.toUnicode) text = this.toUnicode.get(code);
      if (text === undefined && !this.isType0) text = this.lookupEncoding(code) ?? undefined;
      if (text === undefined && !this.toUnicode && !this.isType0) text = encodingLookup('WinAnsiEncoding', code) ?? undefined;
      if (text === undefined) { this.unmapped++; text = ''; }
      out.push({ code, text, width: this.widthOf(code) });
      i += consumed;
    }
    return out;
  }
}

class PlainLatinFont {
  constructor() { this.isType0 = false; this.unmapped = 0; }
  decode(bytes) {
    const out = [];
    for (const b of bytes) {
      let text = encodingLookup('WinAnsiEncoding', b);
      if (text === null) { this.unmapped++; text = ''; }
      out.push({ code: b, text, width: 500 });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Document: xref, objects, page tree, streams
// ---------------------------------------------------------------------------

class PdfDocument {
  constructor(bytes) {
    this.bytes = bytes;
    this.xref = new Map();
    this.trailer = Object.create(null);
    this.cache = new Map();
    this.objStmCache = new Map();
    this.loadingObjStm = new Set();
    this.scanMap = null;
    this.fontCache = new WeakMap();
    this.encrypted = false;
    this.xrefError = null;
    this.pages = null;

    this.checkHeader();
    try { this.readXrefChain(); } catch (e) { this.xrefError = e; }
    if (this.encrypted) throw fail('parse', 'encrypted PDF not supported');
    if (this.xref.size === 0 || !this.trailer.Root) this.recoverByScan();
    if (this.encrypted) throw fail('parse', 'encrypted PDF not supported');
    if (!this.trailer.Root) {
      const hint = this.xrefError ? ` (${this.xrefError.message})` : '';
      throw fail('xref', `could not locate the document catalog; missing or corrupt xref${hint}`);
    }
    this.catalog = asDict(this.resolve(this.trailer.Root));
    if (!this.catalog) throw fail('pages', 'document catalog (/Root) is not a dictionary or cannot be parsed');
  }

  checkHeader() {
    const head = this.bytes.subarray(0, Math.min(1024, this.bytes.length));
    const text = head.toString('latin1');
    if (text.indexOf('%PDF-') < 0) throw fail('header', 'not a PDF file: missing %PDF- header');
  }

  startsWithAt(pos, token) {
    if (pos + token.length > this.bytes.length) return false;
    for (let i = 0; i < token.length; i++) if (this.bytes[pos + i] !== token.charCodeAt(i)) return false;
    return true;
  }

  findStartXref() {
    const idx = this.bytes.lastIndexOf('startxref');
    if (idx < 0) return null;
    let p = idx + 9;
    while (p < this.bytes.length && isWsByte(this.bytes[p])) p++;
    let num = 0; let any = false;
    while (p < this.bytes.length && this.bytes[p] >= 0x30 && this.bytes[p] <= 0x39) {
      num = num * 10 + (this.bytes[p] - 0x30); p++; any = true;
    }
    return any ? num : null;
  }

  readXrefChain() {
    let offset = this.findStartXref();
    if (offset === null) throw fail('xref', 'startxref marker not found');
    const visited = new Set();
    for (let step = 0; step < 64; step++) {
      if (!Number.isFinite(offset) || offset <= 0 || offset >= this.bytes.length) {
        if (step === 0) throw fail('xref', `startxref offset ${offset} is outside the file`);
        break;
      }
      if (visited.has(offset)) break;
      visited.add(offset);
      let section;
      try { section = this.parseXrefSection(offset); } catch (e) {
        if (step === 0) throw e;
        break;
      }
      for (const [num, entry] of section.entries) if (!this.xref.has(num)) this.xref.set(num, entry);
      this.mergeTrailer(section.trailer);
      // Hybrid reference files: classic xref + XRefStm stream with compressed entries
      const trailerDict = asDict(section.trailer) || section.trailer || {};
      const xrefStm = this.resolve(xrefValue(trailerDict, 'XRefStm'));
      if (typeof xrefStm === 'number' && !visited.has(xrefStm)) {
        try {
          visited.add(xrefStm);
          const hybrid = this.parseXrefSection(xrefStm);
          for (const [num, entry] of hybrid.entries) if (!this.xref.has(num)) this.xref.set(num, entry);
          this.mergeTrailer(hybrid.trailer);
        } catch { /* hybrid table is optional */ }
      }
      const prev = this.resolve(xrefValue(trailerDict, 'Prev'));
      if (typeof prev !== 'number') break;
      offset = prev;
    }
    if (this.xref.size === 0) throw fail('xref', 'cross-reference table is empty');
  }

  mergeTrailer(trailer) {
    const dict = asDict(trailer);
    if (!dict) return;
    for (const key of Object.keys(dict)) if (!(key in this.trailer)) this.trailer[key] = dict[key];
    if (dict.Encrypt) this.encrypted = true;
  }

  parseXrefSection(offset) {
    const lx = new Lexer(this.bytes, offset);
    lx.skipWs();
    if (this.startsWithAt(lx.pos, 'xref')) {
      lx.pos += 4;
      return this.parseClassicXref(lx);
    }
    const parsed = this.parseIndirectObjectAt(offset);
    const dict = parsed.stream ? parsed.stream.dict : asDict(parsed.value);
    if (!dict || nameOf(this.resolve(dict.Type)) !== 'XRef') {
      throw fail('xref', `no xref table or xref stream at offset ${offset}`);
    }
    return this.parseXrefStream(parsed.stream, dict);
  }

  parseClassicXref(lx) {
    const entries = new Map();
    let trailer = null;
    for (;;) {
      lx.skipWs();
      if (lx.pos >= this.bytes.length) break;
      if (this.startsWithAt(lx.pos, 'trailer')) {
        lx.pos += 7;
        const dict = asDict(lx.readValue());
        trailer = dict || Object.create(null);
        break;
      }
      const start = lx.readValue();
      const count = lx.readValue();
      if (typeof start !== 'number' || typeof count !== 'number') {
        throw fail('xref', 'malformed classic xref subsection header');
      }
      for (let i = 0; i < count; i++) {
        const off = lx.readValue();
        const gen = lx.readValue();
        const flag = lx.readValue();
        if (typeof off !== 'number' || typeof gen !== 'number') {
          throw fail('xref', 'malformed classic xref entry');
        }
        const free = flag instanceof Op && flag.op === 'f';
        if (!free && off > 0) entries.set(start + i, { type: 1, offset: off, gen });
      }
    }
    if (!trailer) throw fail('xref', 'classic xref has no trailer dictionary');
    return { entries, trailer };
  }

  parseXrefStream(stream, dict) {
    if (!(stream instanceof PdfStream)) throw fail('xref', 'xref stream object is not a stream');
    const data = this.decodeStream(stream);
    const w = this.resolve(dict.W);
    if (!Array.isArray(w) || w.length < 3) throw fail('xref', 'xref stream has invalid /W array');
    const widths = w.map((x) => numOf(this.resolve(x), 0));
    let index = this.resolve(dict.Index);
    if (!Array.isArray(index) || index.length < 2) index = [0, numOf(this.resolve(dict.Size), 0)];
    const readField = (pos, width) => {
      let v = 0;
      for (let i = 0; i < width; i++) v = v * 256 + (data[pos + i] ?? 0);
      return v;
    };
    const entries = new Map();
    let p = 0;
    for (let k = 0; k + 1 < index.length; k += 2) {
      const start = numOf(this.resolve(index[k]), 0);
      const count = numOf(this.resolve(index[k + 1]), 0);
      for (let i = 0; i < count; i++) {
        const type = widths[0] ? readField(p, widths[0]) : 1;
        p += widths[0];
        const f2 = readField(p, widths[1]); p += widths[1];
        const f3 = readField(p, widths[2]); p += widths[2];
        const num = start + i;
        if (type === 1 && f2 > 0) entries.set(num, { type: 1, offset: f2, gen: f3 });
        else if (type === 2) entries.set(num, { type: 2, objstm: f2, index: f3 });
      }
    }
    return { entries, trailer: dict };
  }

  parseIndirectObjectAt(offset) {
    const lx = new Lexer(this.bytes, offset);
    lx.skipWs();
    const num = lx.readValue();
    if (typeof num !== 'number' || !Number.isInteger(num)) throw fail('object', `no object header at offset ${offset}`);
    const gen = lx.readValue();
    const kw = lx.readValue();
    if (!(kw instanceof Op) || kw.op !== 'obj') throw fail('object', `object ${num} at offset ${offset} has no "obj" keyword`);
    const value = lx.readValue();
    if (value === EOF) throw fail('object', `object ${num} at offset ${offset} has no value`);
    let stream = null;
    lx.skipWs();
    if (this.startsWithAt(lx.pos, 'stream')) {
      let p = lx.pos + 6;
      while (p < this.bytes.length && (this.bytes[p] === 0x20 || this.bytes[p] === 0x09)) p++;
      if (this.bytes[p] === 0x0d) { p++; if (this.bytes[p] === 0x0a) p++; }
      else if (this.bytes[p] === 0x0a) p++;
      const dict = asDict(value);
      let end = null;
      if (dict) {
        const declared = this.resolve(dict.Length);
        if (typeof declared === 'number' && declared >= 0 && p + declared <= this.bytes.length) {
          let q = p + declared;
          while (q < this.bytes.length && isWsByte(this.bytes[q])) q++;
          if (this.startsWithAt(q, 'endstream')) end = p + declared;
        }
      }
      if (end === null) {
        const idx = this.bytes.indexOf('endstream', p);
        end = idx >= 0 ? idx : this.bytes.length;
        while (end > p && (this.bytes[end - 1] === 0x0a || this.bytes[end - 1] === 0x0d)) end--;
      }
      stream = new PdfStream(dict || Object.create(null), p, end);
    }
    return { num, gen: typeof gen === 'number' ? gen : 0, value, stream };
  }

  getScanMap() {
    if (this.scanMap) return this.scanMap;
    const text = this.bytes.toString('latin1');
    const map = new Map();
    const re = /(\d{1,7})\s+(\d{1,5})\s+obj\b/g;
    let m;
    while ((m = re.exec(text))) map.set(Number(m[1]), m.index);
    this.scanMap = map;
    return map;
  }

  recoverByScan() {
    const text = this.bytes.toString('latin1');
    if (/\/Encrypt\s*(?:<<|\d+\s+\d+\s+R)/.test(text)) this.encrypted = true;
    if (!this.trailer.Root) {
      let last = null; let m;
      const rootRe = /\/Root\s+(\d+)\s+(\d+)\s+R/g;
      while ((m = rootRe.exec(text))) last = m;
      if (last) this.trailer.Root = new Ref(Number(last[1]), Number(last[2]));
    }
    if (!this.trailer.Root) {
      let catalogPos = -1; let m;
      const catRe = /\/Type\s*\/Catalog/g;
      while ((m = catRe.exec(text))) catalogPos = m.index;
      if (catalogPos >= 0) {
        const head = text.slice(Math.max(0, catalogPos - 4096), catalogPos);
        let lastObj = null; let om;
        const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
        while ((om = objRe.exec(head))) lastObj = om;
        if (lastObj) this.trailer.Root = new Ref(Number(lastObj[1]), Number(lastObj[2]));
      }
    }
  }

  resolve(value) {
    let v = value;
    let depth = 0;
    while (v instanceof Ref && depth++ < 32) {
      const next = this.getObject(v.num);
      if (next === null || next === undefined) return null;
      v = next;
    }
    return v;
  }

  getObject(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    this.cache.set(num, null); // cycle guard: default to "missing"
    let result = null;
    const entry = this.xref.get(num);
    if (entry) {
      try {
        result = this.loadEntry(num, entry);
      } catch (e) {
        result = null;
      }
    }
    if (result === null) {
      const scanOffset = this.getScanMap().get(num);
      if (scanOffset !== undefined) {
        try {
          const parsed = this.parseIndirectObjectAt(scanOffset);
          if (parsed.num === num) result = parsed.stream || parsed.value;
        } catch { result = null; }
      }
    }
    this.cache.set(num, result);
    return result;
  }

  loadEntry(num, entry) {
    if (entry.type === 1) {
      const parsed = this.parseIndirectObjectAt(entry.offset);
      if (parsed.num !== num) throw fail('object', `xref points at object ${parsed.num}, expected ${num}`);
      return parsed.stream || parsed.value;
    }
    const table = this.loadObjStm(entry.objstm);
    const byNum = table.byNum.get(num);
    if (byNum !== undefined) return byNum;
    const byIndex = table.list[entry.index];
    return byIndex ? byIndex.value : null;
  }

  loadObjStm(containerNum) {
    if (this.objStmCache.has(containerNum)) return this.objStmCache.get(containerNum);
    if (this.loadingObjStm.has(containerNum)) throw fail('object', `recursive object stream ${containerNum}`);
    this.loadingObjStm.add(containerNum);
    try {
      const stream = this.getObject(containerNum);
      if (!(stream instanceof PdfStream)) throw fail('object', `object stream ${containerNum} is not a stream`);
      const data = this.decodeStream(stream);
      const lexer = new Lexer(data, 0);
      const n = numOf(this.resolve(stream.dict.N), 0);
      const first = numOf(this.resolve(stream.dict.First), 0);
      const pairs = [];
      for (let i = 0; i < n; i++) {
        const objNum = lexer.readValue();
        const off = lexer.readValue();
        if (typeof objNum !== 'number' || typeof off !== 'number') break;
        pairs.push({ objNum, off });
      }
      const list = pairs.map(({ objNum, off }) => {
        const sub = new Lexer(data, first + off);
        return { objNum, value: sub.readValue() };
      });
      const byNum = new Map();
      for (const item of list) {
        byNum.set(item.objNum, item.value);
        if (!this.cache.has(item.objNum) || this.cache.get(item.objNum) === null) {
          this.cache.set(item.objNum, item.value);
        }
      }
      const table = { list, byNum };
      this.objStmCache.set(containerNum, table);
      return table;
    } finally {
      this.loadingObjStm.delete(containerNum);
    }
  }

  decodeStream(stream) {
    if (stream._decoded) return stream._decoded;
    const dict = stream.dict;
    const raw = this.bytes.subarray(stream.start, stream.end);
    const filterRaw = this.resolve(dict.Filter);
    const filters = filterRaw === null || filterRaw === undefined
      ? []
      : (Array.isArray(filterRaw) ? filterRaw : [filterRaw]).map((f) => nameOf(this.resolve(f))).filter(Boolean);
    if (!filters.length) { stream._decoded = raw; return raw; }
    let parmsRaw = this.resolve(dict.DecodeParms);
    let parmsList;
    if (Array.isArray(parmsRaw)) parmsList = parmsRaw.map((p) => asDict(this.resolve(p)) || {});
    else if (asDict(parmsRaw)) parmsList = filters.map(() => asDict(parmsRaw));
    else parmsList = filters.map(() => ({}));
    let data = raw;
    for (let i = 0; i < filters.length; i++) {
      const name = filters[i];
      const parms = parmsList[i] || {};
      switch (name) {
        case 'FlateDecode': case 'Fl': data = applyPredictor(inflateBytes(data), parms); break;
        case 'ASCIIHexDecode': case 'AHx': data = asciiHexDecode(data); break;
        case 'ASCII85Decode': case 'A85': data = ascii85Decode(data); break;
        case 'RunLengthDecode': case 'RL': data = runLengthDecode(data); break;
        case 'Crypt': break; // identity: only reachable for unencrypted docs
        default: throw fail('stream', `unsupported stream filter /${name}`);
      }
    }
    stream._decoded = data;
    return data;
  }

  pageContents(page) {
    const raw = this.resolve(page.dict.Contents);
    if (raw === null || raw === undefined) return null;
    const streams = Array.isArray(raw) ? raw.map((r) => this.resolve(r)) : [raw];
    const parts = [];
    for (const item of streams) {
      if (!(item instanceof PdfStream)) continue;
      try { parts.push(this.decodeStream(item)); } catch (e) { throw fail('content', `cannot decode page content stream: ${e.message}`, e); }
    }
    if (!parts.length) return null;
    if (parts.length === 1) return parts[0];
    let total = 0;
    for (const p of parts) total += p.length + 1;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; out[off++] = 0x0a; }
    return out;
  }

  getPages() {
    if (this.pages) return this.pages;
    const pages = [];
    const seen = new WeakSet();
    const walk = (ref, inherited) => {
      const node = asDict(this.resolve(ref));
      if (!node || seen.has(node)) return;
      seen.add(node);
      const type = nameOf(this.resolve(node.Type));
      const resources = this.resolve(node.Resources) || inherited.resources;
      const box = asBox(this.resolve(node.MediaBox), inherited.box);
      const kids = this.resolve(node.Kids);
      if (Array.isArray(kids) && type !== 'Page') {
        for (const kid of kids) {
          try { walk(kid, { resources, box }); } catch { /* skip corrupt branch */ }
        }
        return;
      }
      pages.push({ dict: node, resources, box });
    };
    if (this.catalog.Pages) {
      try { walk(this.catalog.Pages, { resources: null, box: [0, 0, 612, 792] }); } catch { /* fall back to scan */ }
    }
    if (!pages.length) pages.push(...this.scanPages());
    if (!pages.length) throw fail('pages', 'no pages found in the page tree');
    for (let i = 0; i < pages.length; i++) pages[i].index = i;
    this.pages = pages;
    return pages;
  }

  scanPages() {
    const pages = [];
    const nums = new Set([...this.xref.keys(), ...this.getScanMap().keys()]);
    const sorted = [...nums].sort((a, b) => a - b);
    for (const num of sorted) {
      let obj;
      try { obj = this.getObject(num); } catch { continue; }
      const dict = asDict(obj instanceof PdfStream ? obj.dict : obj);
      if (!dict) continue;
      const type = nameOf(this.resolve(dict.Type));
      if (type !== 'Page') continue;
      pages.push({
        dict,
        resources: this.resolve(dict.Resources),
        box: asBox(this.resolve(dict.MediaBox), [0, 0, 612, 792]),
      });
    }
    return pages;
  }

  getInfoTitle() {
    try {
      const info = asDict(this.resolve(this.trailer.Info));
      if (!info) return null;
      const raw = this.resolve(info.Title);
      if (!(raw instanceof Uint8Array)) return null;
      let s;
      if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
        s = utf16beToString(raw.subarray(2));
      } else if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
        let t = '';
        for (let i = 2; i + 1 < raw.length; i += 2) t += String.fromCharCode(raw[i] | (raw[i + 1] << 8));
        s = t;
      } else {
        s = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('latin1');
      }
      s = s.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (s.length < 3 || s.length > 300) return null;
      if (/^(untitled|microsoft\s+(word|powerpoint)\b|.*\.(?:dvi|tex|docx?|pptx?|pdf)$)/i.test(s)) return null;
      return s;
    } catch { return null; }
  }
}

function xrefValue(dict, key) {
  const v = dict[key];
  return v instanceof Ref ? v : v;
}

function asBox(v, fallback) {
  if (!Array.isArray(v) || v.length < 4) return fallback || [0, 0, 612, 792];
  const nums = v.map((x) => numOf(x, 0));
  return [
    Math.min(nums[0], nums[2]), Math.min(nums[1], nums[3]),
    Math.max(nums[0], nums[2]), Math.max(nums[1], nums[3]),
  ];
}

// ---------------------------------------------------------------------------
// Content stream -> positioned text items
// ---------------------------------------------------------------------------

function extractPageItems(doc, page) {
  const box = page.box;
  const width = Math.max(1, box[2] - box[0]);
  const height = Math.max(1, box[3] - box[1]);
  const items = [];
  const data = doc.pageContents(page);
  if (!data) return { width, height, items };
  const baseCtm = translate(-box[0], -box[1]);
  const runContent = (content, resources, baseMatrix, depth) => {
    const resourceDict = asDict(doc.resolve(resources));
    const fontDict = resourceDict ? asDict(doc.resolve(resourceDict.Font)) : null;
    const xobjDict = resourceDict ? asDict(doc.resolve(resourceDict.XObject)) : null;

    const fontFor = (name) => {
      if (!fontDict) return null;
      const ref = fontDict[name];
      if (ref === undefined) return null;
      const fd = asDict(doc.resolve(ref));
      if (!fd) return null;
      let font = doc.fontCache.get(fd);
      if (!font) { font = new FontInfo(doc, fd); doc.fontCache.set(fd, font); }
      return font;
    };

    const lexer = new Lexer(content, 0);
    const operands = [];
    let ctm = baseMatrix;
    const ctmStack = [];
    let tm = IDENT;
    let tlm = IDENT;
    let fontSize = 0;
    let font = null;
    let leading = 0;
    let charSpacing = 0;
    let wordSpacing = 0;
    let hScale = 1;
    let lastItem = null;
    const fallbackFont = new PlainLatinFont();

    const pushSpaceBefore = (x0, y0, size, text) => {
      if (!lastItem || !text) return text;
      const lineTol = Math.max(1.5, 0.35 * Math.max(size, lastItem.size));
      if (Math.abs(y0 - lastItem.y) > lineTol) return text;
      const gap = x0 - lastItem.x1;
      if (gap > Math.max(0.2 * size, 0.8) && !/^\s/.test(text)) return ' ' + text;
      return text;
    };

    const show = (bytes) => {
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) return;
      const m = mul(tm, ctm);
      const x0 = m[4];
      const y0 = m[5];
      const size = Math.max(0.1, fontSize * Math.hypot(m[2], m[3]));
      const activeFont = font || fallbackFont;
      const codes = activeFont.decode(bytes);
      let text = '';
      let advance = 0;
      for (const ch of codes) {
        text += ch.text;
        advance += (ch.width / 1000) * fontSize * hScale + charSpacing;
        if (ch.code === 32 && !activeFont.isType0) advance += wordSpacing;
      }
      text = pushSpaceBefore(x0, y0, size, text);
      const end = transformPoint(m, advance, 0);
      const item = { text, x0, x1: Math.max(x0, end[0]), y: y0, size };
      items.push(item);
      lastItem = item;
      tm = mul(translate(advance, 0), tm);
    };

    const nextLine = () => { tm = tlm = mul(translate(0, -leading), tlm); };

    for (let guard = 0; guard < 8_000_000; guard++) {
      const v = lexer.readValue();
      if (v === EOF) break;
      if (!(v instanceof Op)) { operands.push(v); if (operands.length > 128) operands.splice(0, operands.length - 128); continue; }
      const op = v.op;
      switch (op) {
        case 'q': ctmStack.push(ctm); break;
        case 'Q': ctm = ctmStack.pop() || baseMatrix; break;
        case 'cm': {
          if (operands.length >= 6 && operands.every((n) => typeof n === 'number')) {
            ctm = mul(operands.slice(-6), ctm);
          }
          break;
        }
        case 'BT': tm = tlm = IDENT; break;
        case 'Tf': {
          const name = operands[0];
          const size = operands[1];
          if (name instanceof Name) font = fontFor(name.name);
          if (typeof size === 'number') fontSize = size;
          break;
        }
        case 'Tc': if (typeof operands[0] === 'number') charSpacing = operands[0]; break;
        case 'Tw': if (typeof operands[0] === 'number') wordSpacing = operands[0]; break;
        case 'Tz': if (typeof operands[0] === 'number') hScale = operands[0] / 100; break;
        case 'TL': if (typeof operands[0] === 'number') leading = operands[0]; break;
        case 'Td': {
          const tx = operands[0]; const ty = operands[1];
          if (typeof tx === 'number' && typeof ty === 'number') { tm = tlm = mul(translate(tx, ty), tlm); }
          break;
        }
        case 'TD': {
          const tx = operands[0]; const ty = operands[1];
          if (typeof tx === 'number' && typeof ty === 'number') {
            leading = -ty;
            tm = tlm = mul(translate(tx, ty), tlm);
          }
          break;
        }
        case 'Tm': {
          if (operands.length >= 6 && operands.slice(-6).every((n) => typeof n === 'number')) {
            tm = tlm = operands.slice(-6);
          }
          break;
        }
        case 'T*': nextLine(); break;
        case 'Tj': {
          const str = operands[operands.length - 1];
          if (str instanceof Uint8Array) show(str);
          break;
        }
        case 'TJ': {
          const arr = operands[operands.length - 1];
          if (Array.isArray(arr)) {
            for (const el of arr) {
              if (typeof el === 'number') {
                const tx = (-el / 1000) * fontSize * hScale;
                tm = mul(translate(tx, 0), tm);
              } else if (el instanceof Uint8Array) show(el);
            }
          }
          break;
        }
        case "'": {
          nextLine();
          const str = operands[operands.length - 1];
          if (str instanceof Uint8Array) show(str);
          break;
        }
        case '"': {
          if (typeof operands[0] === 'number') wordSpacing = operands[0];
          if (typeof operands[1] === 'number') charSpacing = operands[1];
          nextLine();
          const str = operands[operands.length - 1];
          if (str instanceof Uint8Array) show(str);
          break;
        }
        case 'Do': {
          const name = operands[operands.length - 1];
          if (!(name instanceof Name) || !xobjDict || depth >= 6) break;
          const ref = xobjDict[name.name];
          if (ref === undefined) break;
          const xobj = doc.resolve(ref);
          if (!(xobj instanceof PdfStream)) break;
          if (nameOf(doc.resolve(xobj.dict.Subtype)) !== 'Form') break;
          let formData;
          try { formData = doc.decodeStream(xobj); } catch { break; }
          const head = Buffer.from(formData.buffer, formData.byteOffset, Math.min(formData.byteLength, 4096)).toString('latin1');
          if (head.indexOf('BT') < 0 && head.indexOf('Tj') < 0 && head.indexOf('TJ') < 0) break;
          const matrixRaw = doc.resolve(xobj.dict.Matrix);
          const fm = Array.isArray(matrixRaw) && matrixRaw.length >= 6
            ? matrixRaw.slice(0, 6).map((n) => numOf(n, 0)) : IDENT;
          const childRes = doc.resolve(xobj.dict.Resources) || resources;
          runContent(formData, childRes, mul(fm, ctm), depth + 1);
          break;
        }
        case 'BI': {
          // inline image: skip dictionary up to ID, then binary data up to EI
          for (;;) {
            const iv = lexer.readValue();
            if (iv === EOF) break;
            if (iv instanceof Op && iv.op === 'ID') break;
          }
          const b = content;
          let p = lexer.pos;
          while (p + 1 < b.length) {
            if (b[p] === 0x45 && b[p + 1] === 0x49) {
              const before = p === 0 ? 0x20 : b[p - 1];
              const after = p + 2 >= b.length ? 0x20 : b[p + 2];
              if (isWsByte(before) && isWsByte(after)) { p += 2; break; }
            }
            p++;
          }
          lexer.pos = p;
          break;
        }
        default: break;
      }
      operands.length = 0;
    }
  };
  runContent(data, page.resources, baseCtm, 0);
  return { width, height, items };
}

// ---------------------------------------------------------------------------
// Layout: items -> lines -> columns -> paragraphs
// ---------------------------------------------------------------------------

function normalizeText(s) {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bodyFontSize(pages) {
  const hist = new Map();
  for (const page of pages) {
    for (const item of page.items) {
      if (!item.text.trim()) continue;
      const key = Math.round(item.size * 2) / 2;
      hist.set(key, (hist.get(key) || 0) + item.text.length);
    }
  }
  let best = 10; let bestCount = -1;
  for (const [size, count] of hist) if (count > bestCount) { best = size; bestCount = count; }
  return best > 0 ? best : 10;
}

function buildLines(items, bodySize) {
  const tolerance = Math.max(1.5, Math.min(0.45 * bodySize, 6));
  const sorted = [...items].filter((i) => i.text.trim()).sort((a, b) => (b.y - a.y) || (a.x0 - b.x0));
  const groups = [];
  for (const item of sorted) {
    const group = groups[groups.length - 1];
    if (group && Math.abs(group.y - item.y) <= tolerance) group.items.push(item);
    else groups.push({ y: item.y, items: [item] });
  }
  const lines = [];
  for (const group of groups) {
    group.items.sort((a, b) => a.x0 - b.x0);
    let current = null;
    const flush = () => {
      if (!current || !current.items.length) { current = null; return; }
      const itemsInLine = current.items;
      let text = '';
      let prevEnd = null;
      for (const item of itemsInLine) {
        if (prevEnd !== null) {
          const gap = item.x0 - prevEnd;
          if (gap > Math.max(0.18 * item.size, 0.8) && !/^\s/.test(item.text) && !/\s$/.test(text)) text += ' ';
        }
        text += item.text;
        prevEnd = prevEnd === null ? item.x1 : Math.max(prevEnd, item.x1);
      }
      text = normalizeText(text);
      if (text.length >= 1) {
        lines.push({
          y: group.y,
          x0: Math.min(...itemsInLine.map((i) => i.x0)),
          x1: Math.max(...itemsInLine.map((i) => i.x1)),
          size: Math.max(...itemsInLine.map((i) => i.size)),
          text,
        });
      }
      current = null;
    };
    for (const item of group.items) {
      const gap = current ? item.x0 - current.x1 : 0;
      if (current && gap > Math.max(0.9 * Math.max(item.size, current.size), 5)) flush();
      if (current && current.items.length) {
        const prev = current.items[current.items.length - 1];
        if (prev.text === item.text && Math.abs(prev.x0 - item.x0) < 0.6) continue; // double-struck duplicate
      }
      if (!current) current = { items: [], x0: item.x0, x1: item.x1, size: item.size };
      current.items.push(item);
      current.x0 = Math.min(current.x0, item.x0);
      current.x1 = Math.max(current.x1, item.x1);
      current.size = Math.max(current.size, item.size);
    }
    flush();
  }
  return lines;
}

function modeOf(numbers) {
  const hist = new Map();
  let best = numbers[0] ?? 0; let bestCount = -1;
  for (const n of numbers) {
    const key = Math.round(n);
    const count = (hist.get(key) || 0) + 1;
    hist.set(key, count);
    if (count > bestCount) { best = key; bestCount = count; }
  }
  return best;
}

function medianOf(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function detectGutter(lines, pageWidth) {
  if (lines.length < 6) return null;
  let totalChars = 0;
  for (const line of lines) totalChars += line.text.length;
  if (totalChars < 300) return null;
  let best = null;
  const steps = 80;
  for (let k = 0; k <= steps; k++) {
    const x = pageWidth * (0.3 + (0.4 * k) / steps);
    let covered = 0;
    for (const line of lines) if (line.x0 <= x && line.x1 >= x) covered++;
    const ratio = covered / lines.length;
    if (!best || ratio < best.ratio) best = { x, ratio };
  }
  if (!best || best.ratio > 0.16) return null;
  let leftChars = 0; let rightChars = 0; let fullChars = 0;
  for (const line of lines) {
    if (line.x1 <= best.x + 3) leftChars += line.text.length;
    else if (line.x0 >= best.x - 3) rightChars += line.text.length;
    else fullChars += line.text.length;
  }
  if (leftChars < totalChars * 0.2 || rightChars < totalChars * 0.2) return null;
  if (fullChars > totalChars * 0.75) return null;
  return best.x;
}

function orderPageLines(lines, pageWidth) {
  const sorted = [...lines].sort((a, b) => (b.y - a.y) || (a.x0 - b.x0));
  const gutter = detectGutter(sorted, pageWidth);
  if (gutter === null) {
    for (const line of sorted) line.col = 0;
    return sorted;
  }
  const cols = { left: [], right: [], full: [] };
  for (const line of sorted) {
    if (line.x1 <= gutter + 3) { line.col = 0; cols.left.push(line); }
    else if (line.x0 >= gutter - 3) { line.col = 1; cols.right.push(line); }
    else { line.col = 2; cols.full.push(line); }
  }
  const byYDesc = (a, b) => b.y - a.y;
  cols.left.sort(byYDesc);
  cols.right.sort(byYDesc);
  cols.full.sort(byYDesc);
  const inBand = (list, lo, hi) => list.filter((l) => l.y < hi && l.y > lo);
  const out = [];
  let hi = Infinity;
  for (const full of cols.full) {
    out.push(...inBand(cols.left, full.y, hi), ...inBand(cols.right, full.y, hi), full);
    hi = full.y;
  }
  out.push(...inBand(cols.left, -Infinity, hi), ...inBand(cols.right, -Infinity, hi));
  return out;
}

function filterNoise(pages) {
  const n = pages.length;
  const signature = (text) => text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  const counts = new Map();
  if (n >= 3) {
    for (let i = 1; i < n; i++) {
      const page = pages[i];
      const seen = new Set();
      for (const line of page.lines) {
        const yTop = page.height - line.y;
        if (yTop < page.height * 0.075 || yTop > page.height * 0.925) {
          const sig = signature(line.text);
          if (sig.length >= 3 && sig.length <= 120 && !seen.has(sig)) { seen.add(sig); counts.set(sig, (counts.get(sig) || 0) + 1); }
        }
      }
    }
  }
  const needed = Math.max(2, Math.ceil((n - 1) * 0.5));
  const noise = new Set();
  for (const [sig, count] of counts) if (count >= needed) noise.add(sig);
  for (let i = 0; i < n; i++) {
    const page = pages[i];
    page.lines = page.lines.filter((line) => {
      const text = line.text.trim();
      if (!text) return false;
      if (/^[-–—\s]*\d{1,4}[-–—\s]*$/.test(text)) return false; // bare page number
      if (/^(?:page\s+)?\d{1,4}(?:\s+of\s+\d{1,4})?$/i.test(text)) return false;
      if (/^arXiv:\s*\d{4}\.\d{4,5}v?\d*(?:\s|$)/.test(text) && text.length < 80) return false; // arXiv margin stamp
      if ((line.x1 - line.x0) < 2 && text.length >= 8) return false; // rotated margin stamp / vertical label
      if (i > 0 && noise.has(signature(text))) return false;
      return true;
    });
  }
}

function detectTitle(pages, metaTitle, bodySize) {
  const first = pages[0];
  if (first && first.lines.length) {
    const topRegion = first.lines
      .filter((line) => first.height - line.y < first.height * 0.5 && line.text.length >= 3)
      .sort((a, b) => b.y - a.y);
    const bigLines = topRegion.filter((line) => line.size >= bodySize * 1.2);
    if (bigLines.length) {
      const maxSize = Math.max(...bigLines.map((line) => line.size));
      const startIndex = topRegion.findIndex((line) => line.size >= maxSize * 0.97);
      if (startIndex >= 0) {
        const collected = [];
        let prevY = null;
        for (let i = startIndex; i < topRegion.length && collected.length < 4; i++) {
          const line = topRegion[i];
          if (line.size < maxSize * 0.97) break;
          if (prevY !== null && prevY - line.y > maxSize * 2.2) break;
          if (/^arXiv:/.test(line.text) || /^\d+(?:\.\d+)*\s+[A-Z]/.test(line.text)) break;
          collected.push(line);
          prevY = line.y;
        }
        const title = normalizeText(collected.map((line) => line.text).join(' '));
        if (title.length >= 3 && /[A-Za-z\u00c0-\u024f]/.test(title)) {
          for (const line of collected) line.isTitle = true;
          if (/[a-z]/.test(title)) return title;
        }
      }
    }
  }
  return metaTitle || null;
}

// Row segments (author columns, table cells, annotation labels) share a
// baseline but were split while looking for a two-column gutter; stitch them
// back when they are in the same column.
function coalesceRowSegments(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const sameRow = prev
      && Math.abs(prev.y - line.y) <= Math.max(1.2, 0.35 * Math.max(prev.size, line.size))
      && (prev.col ?? 0) === (line.col ?? 0);
    if (!sameRow) { out.push({ ...line }); continue; }
    const sep = line.x0 - prev.x1 > 0.2 * Math.max(prev.size, line.size) ? ' ' : '';
    prev.text = normalizeText(prev.text + sep + line.text);
    prev.x0 = Math.min(prev.x0, line.x0);
    prev.x1 = Math.max(prev.x1, line.x1);
    prev.size = Math.max(prev.size, line.size);
  }
  return out;
}

function mergeParagraphs(pages, bodySize, title) {
  for (const page of pages) page.lines = coalesceRowSegments(page.lines);

  const gaps = [];
  const maxWidth = new Map();
  for (const page of pages) {
    for (let i = 0; i < page.lines.length; i++) {
      const line = page.lines[i];
      const key = `${page.index}:${line.col ?? 0}`;
      const width = line.x1 - line.x0;
      if (!maxWidth.has(key) || maxWidth.get(key) < width) maxWidth.set(key, width);
      if (i === 0) continue;
      const prev = page.lines[i - 1];
      if ((prev.col ?? 0) !== (line.col ?? 0)) continue;
      const gap = prev.y - line.y;
      if (gap > 0 && gap < 3 * bodySize) gaps.push(gap);
    }
  }
  const medianGap = medianOf(gaps) || bodySize * 1.2;

  const paragraphs = [];
  let current = null;
  let prevLine = null;
  const flush = () => {
    if (current) {
      const text = normalizeText(current.text);
      if (isContentParagraph(text)) paragraphs.push(text);
      current = null;
    }
  };

  for (const page of pages) {
    for (const line of page.lines) {
      if (line.isTitle) { prevLine = { ...line, page: page.index }; continue; }
      const text = normalizeText(line.text);
      if (!text) continue;
      const key = `${page.index}:${line.col ?? 0}`;
      const colWidth = maxWidth.get(key) || (line.x1 - line.x0);
      const numberedHeading = !/[.,;]$/.test(text) && /^(?:\d+(?:\.\d+)*|[IVXLC]+\.|[A-Z]\.)\s+\S/.test(text);
      const knownHeading = text.length <= 30 && line.size >= bodySize * 0.9
        && /^(?:abstract|references|bibliography|acknowledg(?:e)?ments?|appendix|conclusions?|introduction|related work)$/i.test(text);
      const heading = knownHeading || (line.size > bodySize * 1.12
        ? (text.length <= 60 || numberedHeading)
        : (line.size >= bodySize * 0.98 && numberedHeading && text.length < 90));
      let newParagraph;
      if (!prevLine || prevLine.isTitle) newParagraph = true;
      else if (heading || prevLine.heading) newParagraph = true;
      else if (prevLine.page !== page.index || (prevLine.col ?? 0) !== (line.col ?? 0)) {
        newParagraph = /[.!?:;]['")\]]?$/.test(prevLine.text);
      } else {
        const gap = prevLine.y - line.y;
        const prevWidth = prevLine.x1 - prevLine.x0;
        const prevShort = prevWidth < 0.55 * colWidth && prevLine.text.length < 90;
        const indented = line.x0 > prevLine.x0 + Math.max(0.8 * bodySize, 4);
        const bullet = /^(?:[•‣▪◦·⁃]|\(?\d{1,2}[.)]|[a-zA-Z][.)])\s+\S/.test(text) && prevLine.text.length > 20;
        if (gap > medianGap * 1.45 + 0.5) newParagraph = true;
        else if (indented) newParagraph = true;
        else if (prevShort) newParagraph = true;
        else if (bullet) newParagraph = true;
      }
      line.heading = heading;
      if (newParagraph) {
        flush();
        if (heading) {
          if (isContentParagraph(text)) paragraphs.push(text);
        } else {
          current = { text, page: page.index };
        }
      } else if (!current) current = { text, page: page.index };
      else if (/[A-Za-z][-‐]$/.test(current.text) && /^[a-z]/.test(text)) current.text = current.text.slice(0, -1) + text;
      else current.text += ' ' + text;
      prevLine = { ...line, page: page.index };
    }
  }
  flush();

  if (title) {
    const normTitle = normalizeText(title).toLowerCase();
    while (paragraphs.length && normalizeText(paragraphs[0]).toLowerCase() === normTitle) paragraphs.shift();
  }
  const deduped = [];
  for (const p of paragraphs) if (deduped[deduped.length - 1] !== p) deduped.push(p);
  return deduped;
}

function isContentParagraph(text) {
  if (!text || text.length < 2) return false;
  return /[\p{L}\p{N}]/u.test(text);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('[pdf:input] expected a Uint8Array or Buffer');
}

/**
 * Extract the title and readable paragraphs from a PDF file.
 * @param {Uint8Array|Buffer} bytes
 * @returns {Promise<{title?: string, paragraphs: string[]}>}
 */
export async function extractPdfText(bytes) {
  const buffer = toBuffer(bytes);
  const doc = new PdfDocument(buffer);
  const pages = doc.getPages();
  const extracted = [];
  let firstPageError = null;
  for (const page of pages) {
    try {
      extracted.push({ index: page.index, ...extractPageItems(doc, page) });
    } catch (e) {
      if (!firstPageError) firstPageError = e;
      const box = page.box;
      extracted.push({ index: page.index, width: box[2] - box[0], height: box[3] - box[1], items: [] });
    }
  }
  let totalChars = 0;
  for (const page of extracted) for (const item of page.items) totalChars += item.text.length;
  if (totalChars === 0) {
    const hint = firstPageError ? `; first error: ${firstPageError.message}` : '';
    throw fail('extract', `no text found in ${pages.length} page(s) — scanned/image-only PDF or unsupported font encoding${hint}`);
  }
  const bodySize = bodyFontSize(extracted);
  for (const page of extracted) page.lines = buildLines(page.items, bodySize);
  filterNoise(extracted);
  const title = detectTitle(extracted, doc.getInfoTitle(), bodySize);
  for (const page of extracted) page.lines = orderPageLines(page.lines, page.width);
  const paragraphs = mergeParagraphs(extracted, bodySize, title);
  if (!paragraphs.length) {
    throw fail('extract', `text was found (${totalChars} chars on ${pages.length} pages) but no readable paragraphs could be assembled`);
  }
  const result = { paragraphs };
  if (title) result.title = title;
  return result;
}
