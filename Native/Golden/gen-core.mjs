// OWNER: N0
// G1-core goldens and the generated ScrollsCore sources (IOS-SPEC §1.7, §2.2, §8.4.8).
//
// generate(ctx) writes, from the Node reference:
//   ScrollsKit/Sources/ScrollsCore/Text/TokenClassTable.swift   two-stage Unicode class table of Node's regex classes
//   ScrollsKit/Sources/ScrollsCore/Vocab.swift + Resources/vocab.json   every export of src/shared/vocab.mjs
//   ScrollsKit/Sources/ScrollsCore/Copy.swift                    the UI copy of vocab.mjs and evidence-style.mjs
// families (group g1.core) are the exact-comparison cases of the Core ports: token classes, tokenizer, fold, sentence
// breaks, day math, the date grammar and labels, bins, JSNumber and JS math, canonical JSON, ids, mulberry32, the view
// state, the evidence style, vocab templates, format and collation.
//
// Every input is deterministic: hand-written edge lists, snapshot rows read in a fixed order, and mulberry32 streams.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as dates from '../../src/shared/dates.mjs';
import * as evidence from '../../src/shared/evidence-style.mjs';
import * as format from '../../src/shared/format.mjs';
import * as ids from '../../src/shared/ids.mjs';
import * as tok from '../../src/shared/tokenize.mjs';
import * as viewstate from '../../src/shared/viewstate.mjs';
import * as vocab from '../../src/shared/vocab.mjs';
import { redactText, sha256Utf8 } from './lib/redact.mjs';
import { deltas } from './lib/normalize.mjs';

export const group = 'g1.core';
export const owner = 'N0';

const CORE = 'ScrollsKit/Sources/ScrollsCore';
const NOW = new Date('2026-10-04T12:00:00Z');  // the reference's own test clock (tests/dates.test.mjs)
const INPUT_SNAPSHOTS = ['m5r', 'm5-stemm', 'm1r', 'm1'];

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Unicode classes: the regex classes the reference uses anywhere (\p{…} and \s), one bit each.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export const CLASS_BITS = [
  ['letter', /^\p{L}$/u, '\\p{L}'],
  ['mark', /^\p{M}$/u, '\\p{M}'],
  ['number', /^\p{N}$/u, '\\p{N}'],
  ['privateUse', /^\p{Co}$/u, '\\p{Co}'],
  ['otherSymbol', /^\p{So}$/u, '\\p{So}'],
  ['uppercase', /^\p{Lu}$/u, '\\p{Lu}'],
  ['lowercase', /^\p{Ll}$/u, '\\p{Ll}'],
  ['titlecase', /^\p{Lt}$/u, '\\p{Lt}'],
  ['separator', /^\p{Z}$/u, '\\p{Z}'],
  ['punctuation', /^\p{P}$/u, '\\p{P}'],
  ['latin', /^\p{Script=Latin}$/u, '\\p{Script=Latin}'],
  ['devanagari', /^\p{Script=Devanagari}$/u, '\\p{Script=Devanagari}'],
  ['gujarati', /^\p{Script=Gujarati}$/u, '\\p{Script=Gujarati}'],
  ['whitespace', /^\s$/u, '\\s (JavaScript WhiteSpace + LineTerminator)'],
  ['cased', /^\p{Cased}$/u, '\\p{Cased} (ICU: the Final_Sigma context of toLowerCase)'],
  ['caseIgnorable', /^\p{Case_Ignorable}$/u, '\\p{Case_Ignorable} (ICU: skipped by the Final_Sigma context)'],
];

let classTableCache = null;
/** Uint16Array(0x110000) of class masks, from Node's own regular expressions. */
export function classTable() {
  if (classTableCache) return classTableCache;
  const t = new Uint16Array(0x110000);
  for (let cp = 0; cp < 0x110000; cp++) {
    if (cp >= 0xD800 && cp <= 0xDFFF) continue;  // lone surrogates match no class
    const s = String.fromCodePoint(cp);
    let m = 0;
    for (let b = 0; b < CLASS_BITS.length; b++) if (CLASS_BITS[b][1].test(s)) m |= 1 << b;
    t[cp] = m;
  }
  classTableCache = t;
  return t;
}

function twoStage(values) {
  const palette = [...new Set(values)].sort((a, b) => a - b);
  if (palette.length > 256) throw new Error(`class palette has ${palette.length} entries (> 256)`);
  const pIndex = new Map(palette.map((v, i) => [v, i]));
  let best = null;
  for (const shift of [5, 6, 7, 8]) {
    const B = 1 << shift;
    const blocks = new Map();
    const stage1 = new Uint16Array(0x110000 >> shift);
    const stage2 = [];
    for (let b = 0; b < stage1.length; b++) {
      const bytes = new Uint8Array(B);
      for (let i = 0; i < B; i++) bytes[i] = pIndex.get(values[(b << shift) | i]);
      const key = Buffer.from(bytes).toString('latin1');
      let idx = blocks.get(key);
      if (idx === undefined) { idx = blocks.size; blocks.set(key, idx); stage2.push(bytes); }
      stage1[b] = idx;
    }
    const size = stage1.length * 2 + stage2.length * B;
    if (!best || size < best.size) best = { shift, stage1, stage2: Buffer.concat(stage2.map((x) => Buffer.from(x))), size, blocks: stage2.length };
  }
  return { palette, ...best };
}

function base64Lines(buf, indent = '    ') {
  const s = Buffer.from(buf).toString('base64');
  const lines = [];
  for (let i = 0; i < s.length; i += 112) lines.push(`${indent}${s.slice(i, i + 112)}`);
  return lines.join('\n');
}

function genTokenClassTable() {
  const values = classTable();
  const t = twoStage(values);
  const le = Buffer.alloc(t.stage1.length * 2);
  t.stage1.forEach((v, i) => le.writeUInt16LE(v, i * 2));
  const bits = CLASS_BITS.map(([name, , doc], i) =>
    `  /// \`${doc}\`\n  public static let ${name} = UnicodeClass(rawValue: 1 << ${i})`).join('\n');
  return `// OWNER: N0
// GENERATED by Native/Golden/gen-core.mjs from Node ${process.version} (ICU ${process.versions.icu}, Unicode ${process.versions.unicode})
// regular-expression classes. Do not edit; regenerate with Tools/golden.sh. Frozen with tokenizer u61m-1: an iOS Unicode
// update cannot move a token boundary (IOS-SPEC §1.7). ${t.blocks} unique blocks of ${1 << t.shift}, ${t.size} bytes.

import Foundation

/// The Unicode classes of one scalar exactly as the reference's regular expressions see them (Node's ICU).
public struct UnicodeClass: OptionSet, Sendable, Hashable {
  public let rawValue: UInt16
  public init(rawValue: UInt16) { self.rawValue = rawValue }

${bits}

  /// \`[\\p{L}\\p{M}\\p{N}\\p{Co}]\`: the characters of a word token (u61m-1).
  public static let word: UnicodeClass = [.letter, .mark, .number, .privateUse]
}

/// Two-stage lookup of \`UnicodeClass\` for every scalar (Unicode ${process.versions.unicode} as shipped in Node's ICU ${process.versions.icu}).
public enum TokenClassTable {
  /// The Unicode version the table was generated from.
  public static let unicodeVersion = "${process.versions.unicode}"
  /// The ICU version of the generating Node.
  public static let icuVersion = "${process.versions.icu}"

  /// The classes of \`scalar\`; values outside the code space and surrogates have none.
  @inline(__always)
  public static func classes(_ scalar: UInt32) -> UnicodeClass { lookup.classes(scalar) }

  /// The decoded table; hoist it out of hot loops (\`let t = TokenClassTable.lookup\`).
  public static let lookup = Lookup()

  /// The decoded two-stage table.
  public struct Lookup: Sendable {
    let stage1: [UInt16]
    let stage2: [UInt8]
    let palette: [UInt16]

    init() {
      stage1 = Self.decode16(TokenClassTable.stage1Base64)
      stage2 = [UInt8](Data(base64Encoded: TokenClassTable.stage2Base64)!)
      palette = TokenClassTable.palette
      precondition(stage1.count == ${t.stage1.length} && stage2.count == ${t.stage2.length}, "TokenClassTable: corrupt data")
    }

    /// The classes of \`scalar\`.
    @inline(__always)
    public func classes(_ scalar: UInt32) -> UnicodeClass {
      guard scalar < 0x110000 else { return [] }
      let block = Int(stage1[Int(scalar >> ${t.shift})])
      return UnicodeClass(rawValue: palette[Int(stage2[block << ${t.shift} | Int(scalar & ${(1 << t.shift) - 1})])])
    }

    private static func decode16(_ b64: String) -> [UInt16] {
      let bytes = [UInt8](Data(base64Encoded: b64)!)
      return stride(from: 0, to: bytes.count, by: 2).map { UInt16(bytes[$0]) | UInt16(bytes[$0 + 1]) << 8 }
    }
  }

  static let palette: [UInt16] = [${t.palette.join(', ')}]

  static let stage1Base64 = """
${base64Lines(le)}
    """.filter { !$0.isWhitespace }

  static let stage2Base64 = """
${base64Lines(t.stage2)}
    """.filter { !$0.isWhitespace }
}
`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Vocab.swift, Copy.swift and vocab.json
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const STRUCTS = {
  REL_TYPES: 'RelType', REL_TYPE_BY_CODE: 'RelType', LANGUAGE_PERIODS: 'LanguagePeriod', CORPORA: 'CorpusInfo',
  VIRTUAL_CORPORA: 'CorpusInfo', RATE_UNITS: 'RateUnit', DIMENSIONS: 'Dimension', JOB_TYPES: 'JobTypeInfo',
  ISSUE_CODES: 'IssueCodeInfo', STEMM_LANES: 'StemmLane', TRAIL_LANES: 'TrailLane',
};
/** Exports that are UI copy (Copy.swift); everything else is vocabulary (Vocab.swift). */
const COPY_EXPORTS = new Set(['SCORE_KIND_LABELS', 'SAMPLING_LABELS', 'LANE_FACET_LABELS', 'LANE_ORDER_NOTE',
  'SHARE_LANE_NOTE', 'MENTAL_STATE_VERBS', 'FORBIDDEN_PHRASES']);
/** Exports derived from another export: emitted as an expression over it (still checked against vocab.json). */
const DERIVED = { REL_TYPE_BY_CODE: 'OrderedMap(relTypes.map { ($0.code, $0) })' };

const camel = (s) => (/^[A-Z0-9_]+$/.test(s) ? s.toLowerCase() : s).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

function swiftString(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (c < 0x20 || c === 0x7F || (c >= 0x80 && c < 0xA0) || c === 0x2028 || c === 0x2029 || c === 0xFEFF
      || (c >= 0x200B && c <= 0x200F) || c === 0x00AD) out += `\\u{${c.toString(16).toUpperCase()}}`;
    else out += ch;
  }
  return `${out}"`;
}

function kindOf(v) {
  if (v === undefined) return 'absent';
  if (v === null) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (Array.isArray(v)) {
    if (v.length === 0) return 'arrayEmpty';
    if (v.every((x) => typeof x === 'string')) return 'arrayString';
    if (v.every((x) => Number.isInteger(x))) return 'arrayInt';
    return 'json';
  }
  return 'json';
}

function fieldType(kinds) {
  const k = new Set(kinds);
  if (k.has('null') && k.has('absent')) throw new Error('a vocab field is both null and absent: cannot round-trip');
  const optional = k.has('null') || k.has('absent');
  const omitWhenNil = k.has('absent');
  k.delete('null'); k.delete('absent');
  if (k.has('arrayEmpty')) { k.delete('arrayEmpty'); if (k.size === 0) k.add('arrayString'); }
  let base;
  if (k.size === 1) {
    base = { string: 'String', bool: 'Bool', int: 'Int', double: 'Double', arrayString: '[String]', arrayInt: '[Int]', json: 'JSONValue' }[[...k][0]];
  } else if (k.size === 2 && k.has('int') && k.has('double')) base = 'Double';
  else base = 'JSONValue';
  if (base === 'JSONValue') return { type: 'JSONValue', optional: false, omitWhenNil: false, json: true };
  return { type: base, optional, omitWhenNil, json: false };
}

function swiftLiteral(v, t) {
  if (t === 'JSONValue') return jsonLiteral(v);
  if (v === null || v === undefined) return 'nil';
  if (t === 'String') return swiftString(v);
  if (t === 'Bool') return String(v);
  if (t === 'Int') return String(v);
  if (t === 'Double') return Number.isInteger(v) ? `${v}` : String(v);
  if (t === '[String]') return `[${v.map(swiftString).join(', ')}]`;
  if (t === '[Int]') return `[${v.join(', ')}]`;
  throw new Error(`no literal for ${t}`);
}

function jsonLiteral(v) {
  if (v === null || v === undefined) return '.null';
  if (typeof v === 'string') return `.string(${swiftString(v)})`;
  if (typeof v === 'boolean') return `.bool(${v})`;
  if (typeof v === 'number') return `.number(${v})`;
  if (Array.isArray(v)) return `.array([${v.map(jsonLiteral).join(', ')}])`;
  return `.object([${Object.entries(v).map(([k, x]) => `${swiftString(k)}: ${jsonLiteral(x)}`).join(', ') || ':'}])`;
}

function structDecl(name, objects) {
  const keys = [];
  for (const o of objects) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
  const fields = keys.map((k) => ({ key: k, prop: camel(k), ...fieldType(objects.map((o) => kindOf(o[k]))) }));
  const props = fields.map((f) => `  public let ${f.prop}: ${f.type}${f.optional ? '?' : ''}`).join('\n');
  const jsonParts = fields.filter((f) => !f.omitWhenNil).map((f) =>
    `${swiftString(f.key)}: ${f.optional ? `${f.prop}.map(\\.jsonValue) ?? .null` : `${f.prop}.jsonValue`}`);
  const omit = fields.filter((f) => f.omitWhenNil).map((f) => `    if let v = ${f.prop} { o[${swiftString(f.key)}] = v.jsonValue }`);
  const decl = `/// A row of a reference table (its JavaScript fields, camel-cased; \`jsonValue\` restores the original keys).
public struct ${name}: Sendable, Hashable, JSONRepresentable {
${props}

  public init(${fields.map((f) => `${f.prop}: ${f.type}${f.optional ? '? = nil' : ''}`).join(', ')}) {
${fields.map((f) => `    self.${f.prop} = ${f.prop}`).join('\n')}
  }

  /// The row as the reference's JSON object.
  public var jsonValue: JSONValue {
    ${omit.length ? 'var o' : 'let o'}: JSONObject = [${jsonParts.join(', ') || ':'}]
${omit.join('\n')}${omit.length ? '\n' : ''}    return .object(o)
  }
}`;
  return { decl, fields };
}

function structLiteral(name, fields, o) {
  return `${name}(${fields.map((f) => `${f.prop}: ${swiftLiteral(o[f.key], f.type)}`)
    .filter((s, i) => !(fields[i].optional && (o[fields[i].key] === undefined || o[fields[i].key] === null)))
    .join(', ')})`;
}

function genVocabSources(extra) {
  const names = Object.keys(vocab).filter((k) => typeof vocab[k] !== 'function');
  // struct shapes from every export that uses them
  const structObjs = {};
  for (const [exp, sname] of Object.entries(STRUCTS)) {
    const v = vocab[exp];
    (structObjs[sname] ??= []).push(...(Array.isArray(v) ? v : Object.values(v)));
  }
  for (const [sname, objs] of Object.entries(extra.structs)) (structObjs[sname] ??= []).push(...objs);
  const structs = {};
  for (const [sname, objs] of Object.entries(structObjs)) structs[sname] = structDecl(sname, objs);

  const emitted = { Vocab: [], Copy: [] };
  const exportCases = { Vocab: [], Copy: [] };
  const declOf = (exp, value, prop) => {
    const sname = STRUCTS[exp];
    if (DERIVED[exp]) return `public static let ${prop}: OrderedMap<${sname}> = ${DERIVED[exp]}`;
    if (typeof value === 'string') return `public static let ${prop}: String = ${swiftString(value)}`;
    if (Array.isArray(value)) {
      if (sname) {
        const { fields } = structs[sname];
        return `public static let ${prop}: [${sname}] = [\n${value.map((o) => `    ${structLiteral(sname, fields, o)},`).join('\n')}\n  ]`;
      }
      if (value.every((x) => typeof x === 'string')) return `public static let ${prop}: [String] = [${value.map(swiftString).join(', ')}]`;
      throw new Error(`vocab export ${exp}: unsupported array`);
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      let t, lit;
      if (sname) {
        const { fields } = structs[sname];
        t = sname; lit = (o) => structLiteral(sname, fields, o);
      } else if (entries.every(([, x]) => typeof x === 'string')) { t = 'String'; lit = swiftString; }
      else if (entries.every(([, x]) => Number.isInteger(x))) { t = 'Int'; lit = String; }
      else if (entries.every(([, x]) => Array.isArray(x) && x.every(Number.isInteger))) { t = '[Int]'; lit = (x) => `[${x.join(', ')}]`; }
      else throw new Error(`vocab export ${exp}: unsupported object`);
      return `public static let ${prop}: OrderedMap<${t}> = OrderedMap([\n${entries.map(([k, x]) => `    (${swiftString(k)}, ${lit(x)}),`).join('\n')}\n  ])`;
    }
    throw new Error(`vocab export ${exp}: unsupported value`);
  };
  for (const exp of names) {
    const target = COPY_EXPORTS.has(exp) ? 'Copy' : 'Vocab';
    const prop = camel(exp);
    emitted[target].push(`  /// \`${exp}\` of src/shared/vocab.mjs.\n  ${declOf(exp, vocab[exp], prop)}`);
    exportCases[target].push(`    case ${swiftString(exp)}: ${prop}.jsonValue`);
  }
  for (const x of extra.copy) {
    emitted.Copy.push(`  /// ${x.doc}\n  ${x.decl}`);
    exportCases.Copy.push(`    case ${swiftString(x.name)}: ${x.prop}.jsonValue`);
  }
  const header = (what) => `// OWNER: N0
// GENERATED by Native/Golden/gen-core.mjs from ${what}. Do not edit; regenerate with Tools/golden.sh.
// Byte-equal with the reference (golden g1.vocab and ScrollsCoreTests/VocabTests).
`;
  const exportFn = (target, list) => `
  /// The value of a reference export by its JavaScript name, as JSON (for parity tests and diagnostics).
  public static func jsonValue(ofExport name: String) -> JSONValue? {
    switch name {
${list.join('\n')}
    default: nil
    }
  }

  /// Every reference export this enum mirrors, by JavaScript name.
  public static let exportNames: [String] = [${list.map((l) => l.match(/case ("[^"]+")/)[1]).join(', ')}]`;

  const vocabSwift = `${header(`src/shared/vocab.mjs (sha256 ${sha256Utf8(readFileSync(new URL('../../src/shared/vocab.mjs', import.meta.url), 'utf8'))})`)}
// Closed vocabularies: every list mirrors a CHECK of server/db/schema.sql or a contract of SPEC §7.

/// The reference's closed vocabularies (src/shared/vocab.mjs): exports in alphabetical order, each list in the reference's order.
public enum Vocab {
${emitted.Vocab.join('\n\n')}
${exportFn('Vocab', exportCases.Vocab)}
}

${Object.entries(structs).filter(([n]) => !extra.copyStructs.includes(n)).map(([, s]) => s.decl).join('\n\n')}
`;
  const copySwift = `${header('src/shared/vocab.mjs and src/shared/evidence-style.mjs')}
// UI copy shared by every screen. Feature copy lives in each feature's own *Copy.swift; CopyLintTests scan them all.

/// Ported UI copy (labels, notes, badge words, legend text), byte-equal with the reference.
public enum Copy {
${emitted.Copy.join('\n\n')}
${exportFn('Copy', exportCases.Copy)}
}

${extra.copyStructs.map((n) => structs[n].decl).join('\n\n')}
`;
  const json = { '//': 'OWNER: N0 — GENERATED by Native/Golden/gen-core.mjs from src/shared/vocab.mjs (every export); do not edit' };
  for (const exp of names) json[exp] = vocab[exp];
  return { vocabSwift, copySwift, vocabJSON: `${JSON.stringify(json, null, 2)}\n` };
}

function evidenceCopy() {
  const badges = Object.entries(evidence.BADGES).map(([key, b]) => ({ key, text: b.text, title: b.title, description: b.description }));
  const badgeRows = badges.map(({ text, title, description }) => ({ text, title, description }));
  const legend = evidence.LEGEND_ROWS.map((r) => ({ group: r.group, key: r.key, label: r.label, description: r.description }));
  return {
    structs: { Badge: badgeRows, LegendText: legend },
    copyStructs: ['Badge', 'LegendText'],
    copy: [
      { name: 'BADGES', prop: 'badges', doc: '`BADGES` of src/shared/evidence-style.mjs: badge words with their meaning.',
        decl: `public static let badges: OrderedMap<Badge> = OrderedMap([\n${badges.map((b) =>
          `    (${swiftString(b.key)}, Badge(text: ${swiftString(b.text)}, title: ${swiftString(b.title)}, description: ${swiftString(b.description)})),`).join('\n')}\n  ])` },
      { name: 'LEGEND_TEXT', prop: 'legendText', doc: 'The text of `LEGEND_ROWS` (src/shared/evidence-style.mjs); `EvidenceStyle.legendRows` adds the styles.',
        decl: `public static let legendText: [LegendText] = [\n${legend.map((r) =>
          `    LegendText(group: ${swiftString(r.group)}, key: ${swiftString(r.key)}, label: ${swiftString(r.label)}, description: ${swiftString(r.description)}),`).join('\n')}\n  ]` },
    ],
  };
}

export async function generate(ctx) {
  ctx.writeGenerated(`${CORE}/Text/TokenClassTable.swift`, genTokenClassTable());
  const { vocabSwift, copySwift, vocabJSON } = genVocabSources(evidenceCopy());
  ctx.writeGenerated(`${CORE}/Vocab.swift`, vocabSwift);
  ctx.writeGenerated(`${CORE}/Copy.swift`, copySwift);
  ctx.writeGenerated(`${CORE}/Resources/vocab.json`, vocabJSON);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Inputs
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** A seeded stream (the reference's own mulberry32) for fuzz inputs. */
function rng(seed) {
  const next = ids.mulberry32(seed);
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

let snapshot = null;
/** One read-only clone of the first complete snapshot of INPUT_SNAPSHOTS, shared by every family of this run; the
 * family's manifest entry records which one (ctx.inputs). */
function inputsDb(ctx) {
  if (snapshot) {
    ctx.inputs = snapshot.inputs;
    return snapshot;
  }
  const name = ctx.findSnapshot(INPUT_SNAPSHOTS);
  if (!name) return null;
  const clone = ctx.cloneSnapshot(name);
  process.once('exit', () => clone.cleanup());
  const db = new DatabaseSync(clone.db, { readOnly: true });
  ctx.log(`inputs from snapshot ${name} (clone ${clone.dir})`);
  const info = ctx.snapshotInfo(name);
  const inputs = { snapshot: name, built_from: info?.built_from?.commit ?? null };
  snapshot = { name, db, inputs, openCollections: new Set(db.prepare('SELECT id FROM collection WHERE export_text_allowed = 1').all().map((r) => r.id)) };
  ctx.inputs = inputs;
  return snapshot;
}

/** String literals of a JavaScript source file (single, double and template-free), unescaped. */
function stringLiterals(src) {
  const out = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  for (const m of src.matchAll(re)) {
    const body = m[1] ?? m[2];
    out.push(body.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\(.)/g, (_, cp, u, x, c) => {
      if (cp) return String.fromCodePoint(parseInt(cp, 16));
      if (u) return String.fromCharCode(parseInt(u, 16));
      if (x) return String.fromCharCode(parseInt(x, 16));
      return { n: '\n', t: '\t', r: '\r', 0: '\0', b: '\b', f: '\f', v: '\v' }[c] ?? c;
    }));
  }
  return out;
}

const uniq = (list) => [...new Set(list)];

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Edge strings (hand-written; each names a trap of the port)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const EDGE_TEXTS = [
  '', ' ', 'a', 'A', 'Hello, World!', "don't stop", 'state-of-the-art', 'e-mail 3.14 1,000,000 ½ ⅓ ² ³',
  'ΟΔΟΣ ΣΑΣ', 'Σ', 'ΑΣ', 'ΑΣ­Α', 'ΑΣ­', 'ΑΣ‍', 'ΑΣ‍Α', 'ὈΔΥΣΣΕΎΣ', 'ΣΑΣ.', 'ἈΣ', 'Σ̈Σ',
  'İstanbul', 'İ', 'İ', 'ǅemal ǈ ǉ Ǉ', 'ﬁnancial ﬂow ﬀ ﬃ', 'Straße STRASSE ẞ', 'ŉ ΐ ᾈ ᾀ ﬓ', 'Ꭰ Cherokee ꭰ ᏸ',
  'क्‍ष क्‌ष', 'शून्य', 'શૂન્ય', '१९४७ ૧૯૪૭ ٣٤ ३', 'ज़ीरो ज़ ज़', 'ਪੰਜਾਬੀ', 'தமிழ்', 'ภาษาไทย', '中文字符，标点。',
  'カタカナ ひらがな', '한국어 ᄒᆞᆫ', 'עִבְרִית', 'العربية', 'Кириллица', 'Ա ա', 'ⓐⓑ 🄰 Ⅻ ⅻ',
  '◉ kiln eye ◉◉', '❤️ heart', '❤️️', '👨‍👩‍👧 family', '🇮🇳 flag', '☺︎ ☺', '᙭ chi sign ᙭a ᙭́',
  '©®™ ° ± § ¶', 'á', '́abc', '́', 'é vs é', 'Å Å Å', 'x‍y', 'x‍', '‍x',
  'x‌‍y', 'x‍ ‍y', 'soft­hyphen', 'soft­­hyphen', 'zero​width', 'a⁠b',
  ' private 󰀀', '𝐀𝐁𝐂 math bold 𝒜', '𝟏𝟐 digits', '…ellipsis…', 'tab\there\nnew\r\nline ls',
  'NBSP here', 'ideographic　space', 'MIXEDcase WoRdS', 'O’Brien’s', 'l’amour', 'n.d.', 'J. R. R. Tolkien',
  'Mr. Smith', 'café naïve résumé', 'Øresund Æble ŒUVRE', 'ı i İ I', 'ǰ ǰ̌', 'x² ½', '_under_score_', 'a-b—c–d',
  '\u0000\u0001ctrl', '﻿bom', 'emoji🙂inside', 'ab🙂🙂cd', '😀', 'Ⓐ', '㊙', '🀄', '⌚', '♪≈', '“quoted”',
];

const SENTENCE_TEXTS = [
  'Hello there. Mr. Smith went to Washington. He said "Hi!" Then left.  Next one…\nNew line here',
  'One. Two. Three.', 'No terminator', 'Ends with space. ', '  Leading spaces. Then more.', 'e.g. this is fine. i.e. ok.',
  'The U.S.A. is large. It is.', 'Pi is 3.14. Yes.', 'What? Really! Yes.', 'He said: “Go.” She went.', "It's 5 p.m. Now.",
  'Line one\nLine two\n\nParagraph two. Done.', 'Ellipsis... then text. More…', 'Dr. No. Mr. Yes.', '(Parens.) After.',
  'राम घर गया। सीता आई॥ फिर क्या?', 'એક। બે॥ ત્રણ.', '।।॥ start dandas', 'end dandas ।॥', 'mixed। English. हिन्दी।',
  '中文句子。第二句！第三句？', 'Árbol. Ñandú. ¿Qué? ¡Sí!', 'Ça va. Très bien.', 'Number 1. Number 2.', 'A.B.C. D.',
  'Quote ends."\nNext', 'Tabs.\tNext.', 'Form\ffeed. Next.', 'Emoji 🙂. Next.', '', '.', '।', ' ', 'a', 'a.', 'a. b',
  'CHAPTER I.\n\nIt was a dark night. The end.', 'Sentence one.Sentence two.', 'Lower. lower case after.',
  'Vol. 3. Page 4.', 'St. Paul. St. Peter.', 'one. two.', 'x\u0085y. z.', 'ΟΔΟΣ. ΣΑΣ.', 'Was it? It was.',
];

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Families
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

function tokenCase(text, extra = {}) {
  const t = tok.tokenize(text);
  return { ...extra, text, tokens: t.tokens, starts: [...t.starts], ends: [...t.ends] };
}

/** A compact tokenizer case: offsets as deltas and lengths, the norms as a count and the sha256 of normString. */
function compactTokenCase(text, extra = {}) {
  const t = tok.tokenize(text);
  return { ...extra, text, count: t.tokens.length, starts_delta: deltas([...t.starts]),
    lens: [...t.ends].map((e, i) => e - t.starts[i]), norms_sha256: sha256Utf8(t.tokens.join(' ')) };
}

let corpusPassages = null;
/** The first 60 sampled passages of each language: the committed part of the corpus sample. */
function committedCorpus(ctx) {
  const seen = new Map();
  return corpusTokenPassages(ctx).filter((p) => {
    const n = seen.get(p.lang) ?? 0;
    seen.set(p.lang, n + 1);
    return n < 60;
  });
}

/** The 5,000 sampled corpus passages (open collections only), split between the committed and the private family. */
function corpusTokenPassages(ctx) {
  const snap = inputsDb(ctx);  // also records the input snapshot for the calling family
  if (corpusPassages) return corpusPassages;
  if (!snap) { ctx.log('g1.tokenize: no snapshot found; corpus passages skipped'); return (corpusPassages = []); }
  const quotas = { en: 1400, 'und-Latn': 400, und: 400, fr: 500, es: 500, hi: 600, gu: 600, de: 300, '*': 100 };
  corpusPassages = samplePassages(snap, quotas, 1994).map((p) => ({ ...p, snapshot: snap.name }));
  return corpusPassages;
}

function fuzzTexts(n, seed) {
  const R = rng(seed);
  const pools = [
    'abcXYZ019', 'àéîõüñçÆØß', 'ΑΣΣΟΔσςω', 'शूनयक्षज्ञ', 'શૂન્યક્ષ', '٠١٢३४૫', '़઼्́̈',
    '‌‍­', ' \t\n 　 ', '.,;:!?\'"()-—–…', '◉❤☺©®™♪', '️⃣', '᙭',
    '', '中文한국', 'İıǅǈﬁﬂ', '🙂👨🇮𝐀𝟏🀄',
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = R.int(1, 40);
    let s = '';
    for (let k = 0; k < len; k++) {
      const chars = [...R.pick(pools)];
      s += R.pick(chars);
    }
    out.push(s);
  }
  return out;
}

/** Up to `quota` passages per language from collections whose text may be exported, with their text. */
function samplePassages(snap, quotas, seed) {
  const R = rng(seed);
  const open = [...snap.openCollections].join(',');
  const rows = snap.db.prepare(`SELECT p.id, p.document_id AS doc, p.field, p.start_off AS a, p.end_off AS b, p.lang,
      d.collection_id AS coll FROM passage p JOIN document d ON d.id = p.document_id
      WHERE p.id % 7 = 0 AND d.collection_id IN (${open}) ORDER BY p.id`).all();
  const byLang = new Map();
  for (const r of rows) { if (!byLang.has(r.lang)) byLang.set(r.lang, []); byLang.get(r.lang).push(r); }
  const picked = [];
  for (const [lang, list] of [...byLang].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const q = quotas[lang] ?? quotas['*'];
    const chosen = new Set();
    while (chosen.size < Math.min(q, list.length)) chosen.add(Math.floor(R.next() * list.length));
    for (const i of [...chosen].sort((x, y) => x - y)) picked.push(list[i]);
  }
  picked.sort((x, y) => x.doc - y.doc || x.id - y.id);
  const textOf = snap.db.prepare('SELECT original FROM document_text WHERE document_id = ?');
  const fieldOf = snap.db.prepare('SELECT value FROM document_field WHERE document_id = ? AND field = ?');
  const out = [];
  let doc = -1, text = null;
  for (const p of picked) {
    let src;
    if (p.field === 'body') {
      if (p.doc !== doc) { doc = p.doc; text = textOf.get(p.doc)?.original ?? null; }
      src = text;
    } else src = fieldOf.get(p.doc, p.field)?.value ?? null;
    if (src === null) continue;
    out.push({ passage: p.id, collection: p.coll, lang: p.lang, field: p.field, text: src.slice(p.a, p.b) });
  }
  return out.sort((x, y) => x.passage - y.passage);
}

function sentenceBoundaries(text, lang) {
  // Replica of server/text/segment.mjs sentenceBoundaries(text, 0, text.length, lang) (module-private there).
  let seg;
  try { seg = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' }); } catch { seg = new Intl.Segmenter(undefined, { granularity: 'sentence' }); }
  const out = new Set();
  for (const part of seg.segment(text)) if (part.index > 0) out.add(part.index);
  for (const m of text.matchAll(/[।॥]+/gu)) out.add(m.index + m[0].length);
  return [...out].filter((o) => o > 0 && o < text.length).sort((x, y) => x - y);
}

function bitsHex(x) {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return b.toString('hex');
}

function interestingDoubles(n, seed) {
  const R = rng(seed);
  const xs = [0, -0, 1, -1, 0.1, 0.2, 0.3, 1 / 3, 2 / 3, 5e-7, 5e-324, 1e-6, 1e-7, 1.5e-7, 123e-20, 1e21, 1e20, 9.99e20,
    1e-5, 0.000001, 0.0000001, 2 ** 53, 2 ** 53 + 2, 2 ** 53 - 1, -(2 ** 53), 2 ** 31, 2 ** 32, 2 ** 64, 1.7976931348623157e308,
    2.2250738585072014e-308, 2.225073858507201e-308, 4.9e-324, 1e308, 1e-308, 0.5, 1.5, 2.5, -0.5, -1.5, 1.005, 1.0005, 1.00005,
    123.456, 99.95, 99.96, 9.995, 0.045, 0.0045, 1234565, 12345650, 0.1 + 0.2, 100, 1000, 1e15, 1e16, 1e17, 123456789012345680000,
    Math.PI, Math.E, 7304.85, 1 / 40, 365.2425 / 0.05, 0.025, 50, 75];
  for (let e = -30; e <= 30; e++) {
    const p = 10 ** e;
    xs.push(p, -p, p * (1 - 2 ** -52), p * (1 + 2 ** -52), p * 0.5, p * 1.5, p * 9.5, p * 0.95);
  }
  for (let i = 0; i < n; i++) {
    switch (i % 5) {
      case 0: { // random bit patterns over finite doubles
        const b = Buffer.alloc(8);
        b.writeUInt32BE(Math.floor(R.next() * 0xFFE00000), 0);
        b.writeUInt32BE(Math.floor(R.next() * 2 ** 32), 4);
        xs.push(b.readDoubleBE(0));
        break;
      }
      case 1: xs.push(R.int(-1e6, 1e6) / 10 ** R.int(0, 8)); break;
      case 2: xs.push(R.next() * 10 ** R.int(-12, 22)); break;
      case 3: xs.push(R.int(0, 2 ** 31) * 2 ** R.int(-40, 40)); break;
      default: xs.push((R.int(0, 999999) + 0.5) / 10 ** R.int(0, 6)); break;
    }
  }
  return xs.filter(Number.isFinite);
}

function randomJSON(R, depth = 0) {
  const k = R.int(0, depth > 3 ? 4 : 7);
  const keyPool = ['a', 'b', 'Z', 'aa', 'é', 'é', '中', '🙂', '_', '1', '10', '2', '', ' ', 'key"q', 'k\\b', 'ctrl\u0001', '￿', 'ABC'];
  switch (k) {
    case 0: return null;
    case 1: return R.next() < 0.5;
    case 2: return R.pick([0, -0, 1, -1, 1e21, 1e-7, 5e-324, 2 ** 53 + 2, 0.1, 123.456, R.next() * 1e6, -R.next()]);
    case 3: return R.pick(['', 'x', 'line\nbreak', 'tab\t', 'quote"', 'back\\slash', '\u0000\u001f\u007f  ', 'ünï', '🙂', '﻿']);
    case 4: return R.int(-1000, 1000);
    case 5: case 6: { const a = []; const n = R.int(0, 4); for (let i = 0; i < n; i++) a.push(randomJSON(R, depth + 1)); return a; }
    default: { const o = {}; const n = R.int(0, 5); for (let i = 0; i < n; i++) o[R.pick(keyPool)] = randomJSON(R, depth + 1); return o; }
  }
}

function randomViewState(R) {
  const maybe = (p, f) => (R.next() < p ? f() : undefined);
  const s = {};
  const set = (k, v) => { if (v !== undefined) s[k] = v; };
  set('v', maybe(0.3, () => R.pick([1, 2, '1'])));
  set('corpus', maybe(0.8, () => R.pick(['demo', 'cipher', 'stemm', 'real', 'user', 'Bad Corpus', 'x'.repeat(60), 7])));
  set('strands', maybe(0.7, () => Array.from({ length: R.int(0, 6) }, () => ({
    type: R.pick([...vocab.STRAND_TYPES, 'nope']),
    id: R.pick([R.int(1, 99999), String(R.int(1, 999)), 'zero', '', 0, -3, 'a~b c', 'शून्य', null]),
    variants: R.pick([undefined, 'default', 'identity', 'all', 'bogus', [R.int(1, 50), R.int(1, 50), 0, '7'], []]),
  }))));
  set('lanes', maybe(0.6, () => ({ facet: R.pick([...vocab.LANE_FACETS, 'zzz']), sub: R.pick([null, ...vocab.LANE_FACETS]),
    run: R.pick([null, R.int(1, 500), '42', -1]), order: R.pick([...vocab.LANE_ORDERS, 'up']),
    manual: R.pick([[], ['b', 'a', 'a', 'shelf~x'], undefined]), max: R.pick([undefined, R.int(-5, 60), 3.5]) })));
  set('f', maybe(0.6, () => ({ lang: R.pick([[], ['en', 'fr'], ['fr', 'en', 'en'], ['bad,val']]), kind: R.pick([[], ['book']]),
    coll: R.pick([[], ['cipher-gutenberg']]), basis: R.pick([[], ['-estimated']]), syn: R.pick([0, 1, '0', 2]) })));
  set('toggles', maybe(0.5, () => ({ tr: R.pick([0, 1, true, '1']), est: R.pick([0, 1, false]), dup: R.pick([1, 'x']), zz: 1 })));
  set('timeBasis', maybe(0.3, () => R.pick(['publication', 'referenced', 'other'])));
  set('axis', maybe(0.6, () => R.pick([{ mode: 'folded' }, { mode: 'weird' },
    { mode: 'linear', centerDay: R.next() * 2e6 - 1e6, daysPerPx: R.pick([R.next() * 10000, 1e-9, -3, 7304.85, 1 / 3]), keepLinear: R.pick([true, false, 1]) },
    { centerDay: R.int(-4e6, 4e6), daysPerPx: R.next() * 100 }])));
  set('tier', maybe(0.3, () => R.pick(['auto', 'L0', 'L3', 'L9'])));
  set('vantage', maybe(0.5, () => ({ day: R.pick([R.next() * 1e5, R.int(-5e6, 5e6), 'x']), strict: R.pick([true, false, 'yes']) })));
  set('range', maybe(0.3, () => R.pick([[R.int(-1e5, 1e5), R.int(-1e5, 1e5)], [1, 2, 3], [1.5, 'x'], null])));
  set('evidence', maybe(0.4, () => ({ documented: R.pick([0, 1]), computed: R.pick([0, 1, true]), kindred: R.pick([0, 1]) })));
  set('layers', maybe(0.4, () => ({ arcs: R.pick([0, 1]), tone: R.pick([0, 1]), superseded: R.pick([0, 1, '1']) })));
  set('selection', maybe(0.4, () => ({ type: R.pick([...vocab.SELECTION_TYPES, 'x']), id: R.pick([R.int(1, 1e6), 'L3:12:x', '17', -1]) })));
  set('panels', maybe(0.3, () => ({ inspector: R.pick(['tnn', 'reader', null, 'x']), right: R.pick([...vocab.RIGHT_PANELS, null, 'x']) })));
  set('compare', maybe(0.3, () => ({ a: { years: [R.int(-3000, 2100), R.int(-3000, 2100)], f: R.pick(['', 'lang:en', 'bad']) },
    b: R.pick([{ years: [1900, 1950], f: 'kind:book;syn:0' }, { years: 'x' }]) })));
  set('constellation', maybe(0.3, () => ({ layoutKey: R.pick([null, '-', 'k:1', 'x'.repeat(130)]), size: R.pick([...vocab.CONSTELLATION_SIZES, 'q']),
    a: R.pick([null, [1900, 1800], [1, 'x']]), b: R.pick([null, [20000, -20000]]) })));
  set('lineage', maybe(0.3, () => ({ root: R.pick([null, 'passage:12', 'bad', 'etymon:sa:शून्य']), depth: R.pick([0, 3, 9, 2.5]),
    types: R.pick([[], ['exact_quotation', 'nope', 'exact_quotation', 'cover_of']]), status: R.pick([[], ['proposed', 'documented', 'x']]) })));
  set('runs', maybe(0.3, () => ({ materialize: R.pick([{}, { 12: 4, x: 1, 7: '9' }]), cluster: R.pick([null, 5, '6']), quotes: R.pick([null, 3]), vectors: R.pick([null, -1, 8]) })));
  set('asSaved', maybe(0.3, () => R.pick([true, false, 1])));
  set('reducedMotion', maybe(0.3, () => R.pick(['system', 'on', 'off', 'loud'])));
  return s;
}

function stripUndefined(v) { return JSON.parse(JSON.stringify(v)); }

const fam = (run, opts = {}) => ({ run, ...opts });

export const families = {
  'g1.token-classes': fam(() => {
    const t = classTable();
    const cases = [];
    let lo = 0;
    for (let cp = 1; cp <= 0x110000; cp++) {
      if (cp === 0x110000 || t[cp] !== t[lo]) { cases.push({ lo, hi: cp - 1, mask: t[lo] }); lo = cp; }
    }
    return cases;
  }, { note: `bits (LSB first): ${CLASS_BITS.map((b) => b[0]).join(',')}` }),

  'g1.tokenize': fam((ctx) => {
    const cases = EDGE_TEXTS.map((text) => tokenCase(text, { source: 'edge' }));
    for (const text of fuzzTexts(1000, 20261009)) cases.push(tokenCase(text, { source: 'fuzz' }));
    for (const p of committedCorpus(ctx)) cases.push(compactTokenCase(p.text, { source: `${p.snapshot}:passage:${p.passage}`, lang: p.lang }));
    return cases;
  }, { note: 'edge and fuzz cases in full; 60 sampled corpus passages per language in compact form (the rest: g1.tokenize-corpus)',
    attribution: ['Project Gutenberg texts (public domain in the USA) via the Cipher corpus',
    'Wikisource (hi, gu) texts, CC BY-SA 4.0, https://wikisource.org — excerpts as tokenizer inputs',
    'Synthetic demo world (CC0)', 'STEMM Gutenberg texts (public domain in the USA)'] }),

  'g1.tokenize-corpus': fam((ctx) => {
    const committed = new Set(committedCorpus(ctx).map((p) => p.passage));
    return corpusTokenPassages(ctx).filter((p) => !committed.has(p.passage))
      .map((p) => tokenCase(p.text, { source: `${p.snapshot}:passage:${p.passage}`, lang: p.lang }));
  }, { private: true, note: 'the sampled corpus passages not committed in g1.tokenize, in full (kept private for size)' }),

  'g1.fold': fam(() => {
    const cases = [];
    for (let cp = 0; cp < 0x110000; cp++) {
      if (cp >= 0xD800 && cp <= 0xDFFF) continue;
      const s = String.fromCodePoint(cp);
      const f = tok.foldToken(s);
      if (f !== s) cases.push({ cp, fold: f });
    }
    const words = ['ΟΔΟΣ', 'ΣΑΣ', 'Σ', 'ΑΣ', 'ΑΣ­', 'ΑΣ­Α', 'ΑΣ‍', 'ὈΔΥΣΣΕΎΣ', 'Σ̈Σ', 'ἈΣ', 'ΑΣ́', 'ΆΣ',
      'İSTANBUL', 'İ', 'İ', 'é', 'Å', 'Å', 'ǅ', 'ﬁ', 'ẞ', 'ß', 'क्‍ष', '१९४७', '૧૯૪૭', 'ज़', 'A­B', 'ŉ', 'ΐ',
      'ᾈ', 'ﬓ', 'Ꭰ', 'ᏸ', 'K', 'Ω', '𝐀', 'Ⅻ', 'Ⓐ', '🄰', 'ǰ', 'Ǆ', 'ABC‌def', 'ÀÉÎÕÜ', 'ΣΣΣ', 'aΣ', 'ΣaΣ', 'ͅΣ'];
    for (const w of words) cases.push({ text: w, fold: tok.foldToken(w) });
    return cases;
  }),

  'g1.sentences': fam((ctx) => {
    const cases = SENTENCE_TEXTS.map((text) => ({ source: 'edge', lang: 'en', text, starts: sentenceBoundaries(text, 'en') }));
    const demo = readFileSync(new URL('../../data/demo/documents.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean);
    for (const line of demo) {
      const d = JSON.parse(line);
      const text = d.text?.original;
      if (typeof text !== 'string') continue;
      cases.push({ source: `demo:${d.ext_id}`, lang: d.lang_declared ?? null, text, starts: sentenceBoundaries(text, d.lang_declared ?? null) });
    }
    return cases;
  }, { attribution: ['Synthetic demo world (CC0), data/demo/documents.jsonl'] }),

  'g1.sentences-books': fam((ctx) => {
    const snap = inputsDb(ctx);
    if (!snap) { ctx.log('g1.sentences-books: no snapshot; empty'); return []; }
    const pick = (slug, n) => snap.db.prepare(`SELECT d.id, d.ext_id, d.lang_declared AS lang, c.slug FROM document d
        JOIN collection c ON c.id = d.collection_id JOIN document_text t ON t.document_id = d.id
        WHERE c.slug = ? AND c.export_text_allowed = 1 ORDER BY d.id`).all(slug)
      .filter((_, i, all) => i % Math.max(1, Math.floor(all.length / n)) === 0).slice(0, n);
    const books = [...pick('cipher-gutenberg', 30), ...pick('cipher-wikisource-hi', 5), ...pick('cipher-wikisource-gu', 5),
      ...pick('stemm-gutenberg', 10)];
    const textOf = snap.db.prepare('SELECT original FROM document_text WHERE document_id = ?');
    return books.map((b) => {
      const text = textOf.get(b.id).original;
      const starts = sentenceBoundaries(text, b.lang);
      return { source: `${snap.name}:${b.slug}:${b.ext_id}`, lang: b.lang, len: text.length, text_sha256: sha256Utf8(text),
        text, count: starts.length, starts_delta: deltas(starts) };
    });
  }, { private: true, note: '30 Cipher Gutenberg + 10 Wikisource (hi, gu) + 10 STEMM Gutenberg books; text kept private (size)' }),

  'g1.daymath': fam(() => {
    const cases = [];
    const lo = dates.dayFromYMD(-10000, 1, 1), hi = dates.dayFromYMD(3000, 12, 31);
    // every 97th day of [-10000, 3000]: ymdFromDay packed as y·10000 + m·100 + d (sign on y), 2,000 days per case
    for (let from = lo; from <= hi; from += 97 * 2000) {
      const packed = [];
      for (let day = from; day <= hi && packed.length < 2000; day += 97) {
        const { y, m, d } = dates.ymdFromDay(day);
        packed.push(y * 10000 + Math.sign(y || 1) * (m * 100 + d));
      }
      cases.push({ sweep: { from, step: 97, count: packed.length }, packed });
    }
    const R = rng(4499);
    for (let i = 0; i < 3000; i++) {
      const y = R.pick([R.int(-10000, 3000), R.int(0, 99), R.int(1580, 1600), -4499, 0, 1900, 2000, 2100]);
      const m = R.pick([R.int(1, 12), R.int(-15, 27)]);
      const d = R.pick([R.int(1, 31), R.int(-40, 70)]);
      cases.push({ ymd: [y, m, d], day: dates.dayFromYMD(y, m, d) });
    }
    for (const y of [-4500, -4499, -401, -400, -100, -1, 0, 1, 4, 99, 100, 400, 1600, 1700, 1900, 2000, 2024, 2100]) {
      cases.push({ year: y, leap: dates.isLeapYear(y), months: Array.from({ length: 12 }, (_, i) => dates.daysInMonth(y, i + 1)) });
    }
    return cases;
  }),

  'g1.dates': fam((ctx) => {
    const fromTests = stringLiterals(readFileSync(new URL('../../tests/dates.test.mjs', import.meta.url), 'utf8'));
    const spec = readFileSync(new URL('../../Docs/SPEC.md', import.meta.url), 'utf8');
    const sec = spec.slice(spec.indexOf('### 5.3 Date grammar'), spec.indexOf('### 5.4'));
    const fromSpec = [...sec.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const raws = [];
    const snap = inputsDb(ctx);
    if (snap) {
      const bySource = new Map();
      for (const r of snap.db.prepare('SELECT asserted_by, raw FROM date_assertion WHERE raw IS NOT NULL ORDER BY id').iterate()) {
        const k = r.asserted_by.split('@')[0].replace(/^import:\d+$/, 'import');
        if (!bySource.has(k)) bySource.set(k, new Set());
        bySource.get(k).add(r.raw);
      }
      for (const [k, set] of [...bySource].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const list = [...set].sort();
        const step = Math.max(1, Math.ceil(list.length / 1500));
        for (let i = 0; i < list.length; i += step) raws.push(list[i]);
        ctx.log(`g1.dates: ${k}: ${list.length} distinct raw values, ${Math.ceil(list.length / step)} kept`);
      }
    } else ctx.log('g1.dates: no snapshot; corpus raw values skipped');
    const R = rng(1931);
    const years = () => R.pick([R.int(1, 2100), R.int(1, 99), R.int(1000, 2030), R.int(-500, 0), R.int(1, 9999), R.int(1, 99999)]);
    const months = ['January', 'jan', 'Feb.', 'mars', 'avril', 'abril', 'mayo', 'juin', 'JULY', 'août', 'sept', 'octobre',
      'nov', 'diciembre', 'अप्रैल', 'अगस्त', 'ઑગસ્ટ', 'જુલાઈ', 'dic', 'set', 'xyz'];
    const deva = (s) => String(s).replace(/[0-9]/g, (c) => String.fromCharCode(0x966 + Number(c)));
    const gujr = (s) => String(s).replace(/[0-9]/g, (c) => String.fromCharCode(0xAE6 + Number(c)));
    const templates = [
      () => `${years()}`, () => `${years()}-${R.int(0, 13)}-${R.int(0, 32)}`, () => `${R.int(1, 31)} ${R.pick(months)} ${years()}`,
      () => `${R.pick(months)} ${R.int(1, 31)}, ${years()}`, () => `${R.pick(months)} ${years()}`, () => `c. ${years()}`,
      () => `${years()}?`, () => `${years()}s`, () => `the ${R.int(1, 21)}${R.pick(['st', 'nd', 'rd', 'th'])} century`,
      () => `${R.pick(['early', 'mid', 'late', 'début du', 'finales del'])} ${R.int(1, 21)}th century`,
      () => `${years()}–${years()}`, () => `${years()}-${R.int(0, 99)}`, () => `between ${years()} and ${years()}`,
      () => `${R.pick(['before', 'after', 'antes de', 'avant', 'pre-', 'post-'])} ${years()}`, () => `${years()} ${R.pick(['BCE', 'BC', 'av. J.-C.', 'a. C.', 'ईसा पूर्व', 'CE', 'AD'])}`,
      () => `-${R.int(0, 9999)}`, () => `${R.pick(['संवत', 'VS', 'शक', 'Saka', 'સંવત'])} ${R.int(1, 2100)}`,
      () => deva(years()), () => gujr(`${R.int(1, 28)}/${R.int(1, 12)}/${years()}`), () => `${R.pick(['spring', 'winter', 'Easter', 'otoño'])} ${years()}`,
      () => `${R.pick(["'", ''])}${R.int(0, 9)}0s`, () => `${R.pick(['XIXe siècle', 'siglo XX', 's. V', 'Ier siècle av. J.-C.', '19वीं सदी', '19મી સદી'])}`,
      () => `${R.int(1, 3)}${R.pick(['st', 'nd', 'rd'])} millennium ${R.pick(['', 'BCE'])}`, () => `  ${years()} –— ${years()} `,
      () => `${R.int(1, 12)}/${R.int(1, 12)}/${years()}`, () => `${R.pick(['in', 'en', 'during', 'pendant'])} ${years()}`,
      () => `années ${R.int(100, 2000)}`, () => `${R.int(100, 2000)} का दशक`, () => `${years()}-${R.int(1, 12)}`,
      () => `${years()}-${R.int(1, 12)}-${R.int(1, 28)}T${R.int(0, 23)}:${R.int(10, 59)}:00Z`, () => R.pick(['n.d.', 's.d.', '?', '', '0', '00', 'unknown', 'अज्ञात']),
      () => `${R.pick(['circa', 'ca.', '~', 'लगभग', 'around', 'approx.'])} ${R.pick([years(), `${years()}s`, `${R.int(1, 21)}th century`])}`,
    ];
    const fuzz = Array.from({ length: 2000 }, () => R.pick(templates)());
    const inputs = uniq([...fromTests, ...fromSpec, ...raws, ...fuzz]);
    const cases = inputs.map((raw) => ({ raw, out: dates.parseDate(raw, { now: NOW }) }));
    const variants = [
      { twoDigitCentury: 19 }, { twoDigitCentury: 1900 }, { zeroIsUnknown: true }, { negativeYearConvention: 'astronomical' },
      { circaRadius: 10 }, { openRangeYears: 100 }, { circaRadius: 0, openRangeYears: 1 },
    ];
    const optInputs = uniq([...fromTests, ...fromSpec, "'90s", '60s', '0', '000', '-300', 'c. 1931', 'before 1850', 'after 1850',
      'the 90s', 'les années 60', 'los años 70', '1850 से पहले', '-0', '0 bc', 'circa 1900s']);
    for (const opts of variants) for (const raw of optInputs) cases.push({ raw, opts, out: dates.parseDate(raw, { ...opts, now: NOW }) });
    for (const raw of [null, undefined, 1931, 0]) cases.push({ raw: raw === undefined ? '$undefined' : raw, out: dates.parseDate(raw, { now: NOW }) });
    return cases;
  }),

  'g1.date-labels': fam(() => {
    const cases = [];
    const R = rng(1987);
    for (let y = -1100; y <= 2100; y += 7) cases.push({ fn: 'yearLabel', args: [y], out: dates.yearLabel(y) });
    for (let i = 0; i < 600; i++) {
      const a = R.int(-3000, 2100), b = a + R.pick([0, 1, 9, 33, 99, 100, 999, R.int(0, 3000)]);
      cases.push({ fn: 'yearRangeLabel', args: [a, b], out: dates.yearRangeLabel(a, b) });
    }
    for (const [a, b] of [[null, 5], [5, null], [null, null], [-499, -400], [1, 99], [0, 0], [-1, 1]]) {
      cases.push({ fn: 'yearRangeLabel', args: [a, b], out: dates.yearRangeLabel(a ?? NaN, b ?? NaN) });
    }
    const precisions = ['year', 'decade', 'century', 'millennium', 'range', 'period', undefined];
    for (let i = 0; i < 700; i++) {
      const lo = R.pick([R.int(-3000, 2100), R.int(1, 99), Math.floor(R.int(-30, 21)) * 100, Math.floor(R.int(-30, 21)) * 100 + 1, R.int(-12, 3) * 1000]);
      const hi = lo + R.pick([0, 1, 2, 9, 10, 33, 66, 99, 999, R.int(0, 500)]);
      const precision = R.pick(precisions);
      const rule = R.pick(['interval', 'circa', 'century_part', 'vikram_samvat', 'shaka_samvat', 'hundreds', 'decade', 'year+future']);
      const p = dates.fromInterval(lo, hi, { precision, basis: 'stated', rule, approx: R.pick([0, 1]) });
      cases.push({ fn: 'fromInterval', args: [lo, hi, { precision: precision ?? null, basis: 'stated', rule, approx: p.approx }], out: p });
    }
    for (let i = 0; i < 700; i++) {
      const lo = R.int(-800000, 60000), hi = lo + R.pick([0, 1, 27, 28, 29, 30, 31, 59, 89, 364, 365, R.int(0, 2000)]);
      const precision = R.pick(['day', 'month', 'range', 'year', 'unknown']);
      const rule = R.pick(['interval', 'open_range', 'circa', 'iso_day']);
      const raw = R.pick([null, 'before 1850', 'avant 1850', 'after 1850', '1850 से पहले', ' Before 1850 ', 'PRE 1850', 'x']);
      if (precision === 'unknown') continue;
      cases.push({ fn: 'fromDayInterval', args: [lo, hi, { precision, basis: 'stated', rule, raw, approx: 0 }],
        out: dates.fromDayInterval(lo, hi, { precision, basis: 'stated', rule, raw, approx: 0 }) });
    }
    for (const [lo, hi] of [[5, 4], [1.5, 2]]) {
      let err = null;
      try { dates.fromInterval(lo, hi, { basis: 'stated' }); } catch (e) { err = e.message; }
      cases.push({ fn: 'fromInterval', args: [lo, hi, { precision: null, basis: 'stated', rule: 'interval', approx: 0 }], error: err });
    }
    cases.push({ fn: 'formatDateLabel', args: [null], out: dates.formatDateLabel(null) });
    return cases;
  }),

  'g1.bins': fam(() => {
    const cases = [];
    const R = rng(1600);
    for (let i = 0; i < 2000; i++) {
      const y = R.pick([R.int(-10000, 3000), R.int(-20, 20), R.int(-1005, -995)]);
      const level = R.int(0, 3);
      const y2 = y + R.pick([0, 1, 9, 10, 99, 100, 999, 1000, R.int(0, 2000)]);
      cases.push({ fn: 'binOf', args: [y, level], out: dates.binOf(y, level) });
      cases.push({ fn: 'fits', args: [y, y2, level], out: dates.fits(y, y2, level) });
    }
    for (let i = 0; i < 2000; i++) {
      const d = R.int(-4000000, 400000), d2 = d + R.pick([0, 1, 27, 30, 31, 365, R.int(0, 400)]);
      const level = R.pick([4, 5]);
      cases.push({ fn: 'fitsDays', args: [d, d2, level], out: dates.fitsDays(d, d2, level) });
      cases.push({ fn: 'monthBinOfDay', args: [d], out: dates.monthBinOfDay(d) });
    }
    for (const ppy of [0, 0.01, 0.08, 0.0799, 0.5, 0.8, 0.79, 7.99, 8, 50, 95.99, 96, 1000, 2921.9, 2922, 1e6, R.next() * 100]) {
      cases.push({ fn: 'tierForPpy', args: [ppy], out: dates.tierForPpy(ppy) });
    }
    for (const level of [4, 5, 6, -1]) {
      let err = null;
      try { dates.binOf(10, level); } catch (e) { err = e.message; }
      cases.push({ fn: 'binOf', args: [10, level], error: err });
    }
    return cases;
  }),

  // JSON.stringify(x) === String(x) for every finite x except -0 ('0' both); non-finite numbers never reach JSON
  'g1.jsnumber': fam(() => interestingDoubles(20000, 21).map((x) => ({ b: bitsHex(x), s: String(x) }))),

  'g1.js-math': fam(() => {
    const xs = interestingDoubles(1000, 10).map(Math.abs).filter((x) => x > 0);
    const cases = [];
    for (const x of xs) {
      cases.push({
        bits: bitsHex(x), log10: bitsHex(Math.log10(x)), log: bitsHex(Math.log(x)), round: bitsHex(Math.round(x)),
        roundNeg: bitsHex(Math.round(-x)),
        toFixed: [0, 1, 2, 3, 6, 20].map((f) => x.toFixed(f)), toFixedNeg: [0, 1, 2].map((f) => (-x).toFixed(f)),
        toPrecision: [1, 2, 3, 6, 12, 17, 21].map((p) => x.toPrecision(p)),
      });
    }
    for (const x of [0, -0, NaN, Infinity, -Infinity, 1, 0.5, -0.5, 2.5, -2.5, -0.4, 0.49999999999999994, 4503599627370495.5]) {
      cases.push({ special: String(x), negZero: Object.is(x, -0), round: bitsHex(Math.round(x)), toFixed2: x.toFixed(2),
        toPrecision3: x.toPrecision(3), log10: bitsHex(Math.log10(x)) });
    }
    return cases;
  }),

  'g1.canonical-json': fam(() => {
    const R = rng(77);
    const cases = [];
    for (let i = 0; i < 1500; i++) {
      const v = randomJSON(R);
      const text = JSON.stringify(v, null, i % 3 === 0 ? 1 : undefined);
      cases.push({ json: text, canonical: ids.canonicalJson(JSON.parse(text)) });
    }
    for (const text of ['-0', '1e400', '-1e400', '0.1', '1E2', '1e-7', '[1e21,1e-6,123456789012345678901]', '"\\u00e9\\ud83d\\ude00"',
      '{"b":1,"a":2,"b":3}', '{"\\u0041":1,"A":2}', '"\\u2028\\u2029"', '{"":{"":[]}}', ' [ 1 , 2 ] ', '"\\/"', '9007199254740993']) {
      cases.push({ json: text, canonical: ids.canonicalJson(JSON.parse(text)) });
    }
    return cases;
  }),

  'g1.ids': fam(() => {
    const R = rng(48);
    const strs = uniq([...EDGE_TEXTS, ...fuzzTexts(400, 9), 'ગણિત પોથી', "Rock 'n' Roll", 'Ça va — très bien!', 'O’Brien', '---a---', 'Ω',
      'x'.repeat(100), 'word '.repeat(20), `${'ab-'.repeat(20)}`, '𝐀'.repeat(30), 'a'.repeat(47) + '𝐀𝐀', '中'.repeat(60), 'Ǆungla']);
    const cases = [];
    for (const s of strs) {
      cases.push({ fn: 'fnv1a32', s, out: ids.fnv1a32(s) });
      cases.push({ fn: 'shortHash', s, n: (cases.length % 16) + 1, out: ids.shortHash(s, (cases.length % 16) + 1) });
      const max = R.pick([48, 48, 10, 24, 1, 3, 100]);
      cases.push({ fn: 'slugify', s, max, out: ids.slugify(s, max) });
    }
    for (const s of ['passage:901', 'etymon:sa:शून्य', 'x:', ':1', 'Passage:1', 'passage:0012', 'passage:1234567890123456', 'a_b-c:9',
      'passage', '', 'p:1.5', 'p: 1', '-a:1', '_a:x']) {
      let out = null, err = null;
      try { out = ids.parseRef(s); } catch (e) { err = e.message; }
      cases.push({ fn: 'parseRef', s, out, error: err });
    }
    for (const [t, id] of [['passage', 901], ['etymon', 'sa:शून्य'], ['Bad', 1], ['ok', ''], ['a-b', 'x']]) {
      let out = null, err = null;
      try { out = ids.ref(t, id); } catch (e) { err = e.message; }
      cases.push({ fn: 'ref', args: [t, id], out, error: err });
    }
    return cases;
  }),

  'g1.mulberry32': fam(() => {
    const seeds = [0, 1, 2, 42, 1994, 2026, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF, -1, 2 ** 32 + 5, 12.7];
    const R = rng(5);
    for (let i = 0; i < 20; i++) seeds.push(Math.floor(R.next() * 2 ** 32));
    return seeds.map((seed) => {
      const next = ids.mulberry32(seed);
      return { seed, uint32: seed >>> 0, draws: Array.from({ length: 300 }, () => next()) };
    });
  }),

  'g1.viewstate': fam(() => {
    const cases = [];
    for (const c of ['demo', 'cipher', 'real', 'stemm', 'user']) cases.push({ fn: 'defaultState', corpus: c, out: viewstate.defaultState(c) });
    const R = rng(8);
    for (let i = 0; i < 500; i++) {
      const input = stripUndefined(randomViewState(R));
      const warnings = [];
      const canonical = viewstate.canonicalize(input, warnings);
      const hash = viewstate.encode(input);
      const back = viewstate.decodeHash(hash);
      const same = ids.canonicalJson(back.state) === ids.canonicalJson(canonical);
      cases.push({ fn: 'state', input, canonical, warnings, hash, ...(same ? {} : { decoded: back.state }), decodeWarnings: back.warnings,
        stateHash: viewstate.stateHash(input) });
    }
    const hashes = ['', '#', '#v=1&c=demo', '#v=2&c=cipher', '#c=demo', '#view=my-view&as=1&c=cipher', '#view=&as=1', '#v=1&c=demo&s=e12,e7-a,t%E0%A4%B6,w3-v1_2_3',
      '#v=1&c=demo&l=domain/kind:al:r5:m20', '#v=1&c=demo&l=bad', '#v=1&c=demo&lm=a~b%20c~', '#v=1&c=demo&f=lang:en,fr;syn:0',
      '#v=1&c=demo&f=%E0', '#v=1&c=demo&tg=tr1.est0.zz1', '#v=1&c=demo&tb=ref', '#v=1&c=demo&tb=xx', '#v=1&c=demo&x=fold',
      '#v=1&c=demo&x=lin:12345:0.5:k', '#v=1&c=demo&x=lin:1:1e-3', '#v=1&c=demo&x=lin:a:b', '#v=1&c=demo&ti=L3', '#v=1&c=demo&ti=L9',
      '#v=1&c=demo&t=-3000s', '#v=1&c=demo&t=5c', '#v=1&c=demo&rg=10:-5', '#v=1&c=demo&ev=dcp', '#v=1&c=demo&ev=0', '#v=1&c=demo&ly=afwcekbvts',
      '#v=1&c=demo&sel=occ:12', '#v=1&c=demo&sel=bin:L3%3A190%3Ax', '#v=1&c=demo&sel=zz:1', '#v=1&c=demo&p=-,compare', '#v=1&c=demo&p=reader',
      '#v=1&c=demo&cmp=1900-1950@lang%3Aen~1950-2000', '#v=1&c=demo&cmp=1900-1950', '#v=1&c=demo&k=layout~d~1900-1950~-',
      '#v=1&c=demo&lg=passage%3A12~3~exact_quotation,cover_of~proposed', '#v=1&c=demo&r=m12_4.c5.q3.v8.zz', '#v=1&c=demo&as=1',
      '#v=1&c=demo&as=2', '#v=1&c=demo&rm=on', '#v=1&c=demo&unknown=1', '#v=1&c=Bad', '#v=1&c=real', '#v=1&c=cipher&&&', '#a&b=&=c',
      '#v=1&c=demo&s=e', '#v=1&c=demo&s=x12', '#v=1&c=demo&sel=psg:%E0%A4', 'v=1&c=demo', '#v=1&c=demo&f=coll:a%2Cb'];
    for (const h of hashes) {
      const r = viewstate.decodeHash(h);
      cases.push({ fn: 'decodeHash', hash: h, out: r, reencoded: viewstate.encode(r.state) });
    }
    for (const f of ['lang:en,fr;kind:book,song;coll:cipher-gutenberg;basis:-estimated;syn:1', 'zz:1', 'syn:2', 'lang:,x;;', 'lang: a , b ']) {
      const warnings = [];
      const parsed = viewstate.parseFilter(f, warnings);
      cases.push({ fn: 'parseFilter', input: f, out: parsed, warnings, formatted: viewstate.formatFilter(parsed), withDefaults: viewstate.formatFilter(parsed, { withDefaults: true }) });
    }
    return cases;
  }),

  'g1.evidence-style': fam(() => {
    const cases = [];
    const relFamilies = ['quotation', 'parody', 'similarity', 'etymology', 'unknown', undefined];  // every hue, unknown, none
    for (const es of [...vocab.EVIDENCE_STATUS, 'bogus']) {
      for (const rs of [...vocab.REVIEW_STATUS, undefined, 'meh']) {
        for (const pq of es === 'documented' ? ['complete', 'source_unrecorded', undefined] : [undefined]) {
          for (const family of relFamilies) {
            for (const flags of [0, 1, 2, 4, 8, 15]) {
              const rel = stripUndefined({ evidence_status: es, review_status: rs, provenance_quality: pq, family,
                cue: Boolean(flags & 1), is_synthetic: (flags & 2) ? 1 : 0, date_conflict: Boolean(flags & 4), origin: (flags & 8) ? 'human' : 'algorithm' });
              let out = null, err = null;
              try { out = evidence.edgeStyle(rel); } catch (e) { err = e.message; }
              cases.push({ fn: 'edgeStyle', rel, out, error: err });
            }
          }
        }
      }
    }
    for (const state of [1, 2, 3, 4, 5, 6, 'observed', 'absent', 'low', 'uncovered', 'pending', 'nope']) {
      for (let flags = 0; flags < 128; flags += (typeof state === 'number' && state > 1 ? 37 : 1)) {
        let out = null, err = null;
        try { out = evidence.binStyle({ state, flags }); } catch (e) { err = e.message; }
        cases.push({ fn: 'binStyle', cell: { state, flags }, out, error: err });
      }
    }
    cases.push({ fn: 'BADGES', out: evidence.BADGES });
    cases.push({ fn: 'LEGEND_ROWS', out: evidence.LEGEND_ROWS });
    return cases;
  }),

  'g1.vocab': fam(() => {
    const cases = [];
    for (const k of Object.keys(vocab).filter((k) => typeof vocab[k] !== 'function')) cases.push({ export: k, value: vocab[k] });
    const samples = [{ line: 12, byte: '0xff', offset: 7 }, { line: 3, value: "12/'99", title: 'Ā’s', kind: 'link', end: 'dst', mix: 'en, fr' },
      { line: null, value: undefined, other: 0, jaccard: 0.875, scores: 'en 0.9', declared: 'fr', detected: 'en' }, {}];
    for (const [code, { template }] of Object.entries(vocab.ISSUE_CODES)) {
      for (const vars of samples) cases.push({ template, vars: stripUndefined(vars), out: vocab.fillTemplate(template, vars) });
    }
    for (const t of ['{a}{b}{}{A}{a_b}', 'no placeholders', '{x}', '{{x}}', 'trailing {']) {
      cases.push({ template: t, vars: { a: 1, b: true, a_b: 'z', x: -0.5 }, out: vocab.fillTemplate(t, { a: 1, b: true, a_b: 'z', x: -0.5 }) });
    }
    return cases;
  }),

  'g1.format': fam(() => {
    const cases = [];
    const xs = [...interestingDoubles(3000, 33), null, undefined, NaN, Infinity, -Infinity, 0.5, 1.5, 2.5, -2.5, 999.5, 999.4999, 9999.5,
      94385, 2850.5, 367.3, 84.25, 0.4123, 6200, 18000, 41200, 312000, 6100000, 68000000, 999950, 999949, 99950, 1e21, 1.5e21, 1e-7];
    for (const x of xs) {
      const arg = x === undefined ? '$undefined' : x === null ? null : Number.isFinite(x) ? x : String(x);
      cases.push({ fn: 'numbers', x: arg, count: format.formatCount(x), number: format.formatNumber(x), tokens: format.formatTokens(x),
        share: format.formatShare(x) });
    }
    for (const x of interestingDoubles(500, 34).slice(0, 600)) for (const sig of [1, 2, 4, 6]) cases.push({ fn: 'formatNumber', x, sig, out: format.formatNumber(x, sig) });
    const units = [...Object.keys(vocab.RATE_UNITS), 'tokens', 'works', 'entries', 'none', 'bogus', '', null];
    for (const u of units) {
      cases.push({ fn: 'unitLabel', unit: u, out: format.unitLabel(u) });
      for (const x of [367.3, 0.315, 12.5, 0, null, 1e6, 0.0004]) {
        cases.push({ fn: 'formatRate', x, unit: u, out: format.formatRate(x, u) });
        cases.push({ fn: 'formatCI', ci: [x, x === null ? 1 : x * 2], unit: u, out: format.formatCI([x, x === null ? 1 : x * 2], u) });
      }
    }
    for (const ci of [null, [1], [1, 2, 3], [NaN, 1]]) cases.push({ fn: 'formatCI', ci: ci && ci.map((v) => (Number.isNaN(v) ? 'NaN' : v)), unit: 'per_million_tokens', out: format.formatCI(ci, 'per_million_tokens') });
    for (const t of [null, { n: 1 }, { n: 1351 }, { n: 0 }, { n: 562, by_unit: { matches: 562, works: 789 }, units_mixed: true },
      { n: 789, by_unit: { matches: 0, works: 789 }, units_mixed: false }, { n: 1, by_unit: { matches: 1, works: 0 } }, { n: 2, by_unit: { matches: 0, works: 1 } }]) {
      cases.push({ fn: 'totalsText', totals: t, out: format.totalsText(t) });
    }
    for (const r of [null, '', 'passage:53', 'relationship:7', 'cluster:3', 'hypothesis_group:2', 'time_window:1', 'saved_view:x', 'expr_doc:9',
      'Passage:1', 'a:', 'no colon', 'x:y:z', 'a\nb:c', 'ab:c\nd', 'ab: ']) {
      cases.push({ fn: 'refWords', ref: r, out: format.refWords(r) });
    }
    return cases;
  }),

  'g1.collation': fam((ctx) => {
    const words = new Set(['a', 'B', 'b', 'A', 'é', 'e', 'f', 'Ä', 'z', 'Z', '1', '10', '2', '_x', '-y', 'ä', 'ß', 'ss', 'शून्य', 'શૂન્ય',
      'résumé', 'resume', 'Resume', 'co-op', 'coop', '  x', 'x ', 'a b', 'ab', 'Æ', 'ae', 'ǆ', 'dz', 'ﬁ', 'fi', 'ñ', 'n', 'o', 'ö', 'œ', 'oe',
      'İ', 'i', 'ı', 'I', 'Ω', 'ω', '中', '日', '가', '🙂', '#', '$', '@', '&', '', 'é', 'Å', 'Å']);
    for (const v of Object.values(vocab.LANE_FACET_LABELS)) words.add(v);
    for (const r of vocab.REL_TYPES) { words.add(r.label); words.add(r.short); }
    for (const l of vocab.TRAIL_LANES) words.add(l.label);
    for (const line of readFileSync(new URL('../../data/demo/documents.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean)) {
      const d = JSON.parse(line);
      for (const s of [d.title, d.author, d.community]) if (typeof s === 'string') words.add(s);
    }
    const snap = inputsDb(ctx);
    if (snap) {
      for (const r of snap.db.prepare("SELECT title FROM document WHERE title IS NOT NULL AND id % 211 = 0 ORDER BY id LIMIT 600").all()) words.add(r.title);
    }
    const list = [...words];
    const sorted = [...list].sort((x, y) => x.localeCompare(y, 'en'));
    const R = rng(3);
    const pairs = [];
    for (let i = 0; i + 1 < sorted.length; i++) pairs.push([sorted[i], sorted[i + 1]]);
    for (let i = 0; i < 2000; i++) pairs.push([R.pick(list), R.pick(list)]);
    return pairs.map(([a, b]) => ({ a, b, cmp: Math.sign(a.localeCompare(b, 'en')) }));
  }, { note: 'DV-4 measurement: sign of a.localeCompare(b, "en")' }),

  'g1.text-helpers': fam(() => {
    const cases = [];
    const R = rng(11);
    const vocabW = ['the', 'zero', 'carry', 'a', 'of', 'x'];
    for (let i = 0; i < 500; i++) {
      const tokens = Array.from({ length: R.int(0, 30) }, () => R.pick(vocabW));
      const seq = Array.from({ length: R.int(0, 3) }, () => R.pick(vocabW));
      const from = R.pick([0, 0, R.int(-3, 35)]);
      cases.push({ fn: 'findSequence', tokens, seq, from, out: tok.findSequence(tokens, seq, from) });
    }
    for (const s of ['carry the zero', 'Zero', 'a "quoted" word', '◉', '', '  ', 'शून्य कुछ']) {
      let out = null, err = null;
      try { out = tok.ftsPhrase(s); } catch (e) { err = e.message; }
      cases.push({ fn: 'ftsPhrase', s, out, error: err });
    }
    for (const t of [...SENTENCE_TEXTS, ...EDGE_TEXTS.slice(0, 40), 'He met J. Smith. Then Mr. Jones arrived.\n\nNew para "Quoted." Next',
      'Yes.\fPage', 'A. B. C', 'see p. 4. Then', 'dña. María', '(Hi.) [There.] {Ok.} "Yes." «Oui.» „Ja.“ ‚x.‘ ‹y.› *z.* _w._ —v.— -u.-']) {
      const toks = tok.tokenize(t);
      for (const start of toks.starts) cases.push({ fn: 'isSentenceInitial', text: t, start, out: tok.isSentenceInitial(t, start) });
    }
    return cases;
  }),
};
