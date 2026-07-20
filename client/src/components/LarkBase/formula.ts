// A tiny, self-contained formula engine — no dependencies.
//
//   {Nama Field} references              e.g. {Durasi (menit)} / 60 * {Rate / jam}
//   arithmetic  + - * / ( )  and unary -
//   comparison  = == != <> > >= < <=      (for IF conditions)
//   functions   CONCAT IF ROUND LEN UPPER LOWER TODAY
//
// Anything malformed resolves to the FORMULA_ERR sentinel ('#ERR') — the
// engine NEVER throws, so a bad formula can't crash a cell render.

import { Field, BaseRecord, CellValue, formatNumber } from './types';

export const FORMULA_ERR = '#ERR';
export type FormulaValue = number | string | boolean;

// ── Tokeniser ──────────────────────────────────────────────────────

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'field'; v: string }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'comma' };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '{') {
      const end = src.indexOf('}', i + 1);
      if (end === -1) throw new Error('unterminated field ref');
      toks.push({ t: 'field', v: src.slice(i + 1, end).trim() });
      i = end + 1; continue;
    }
    if (c === '"' || c === "'") {
      const quote = c; let j = i + 1; let s = '';
      while (j < n && src[j] !== quote) { s += src[j]; j++; }
      if (j >= n) throw new Error('unterminated string');
      toks.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i; let s = '';
      while (j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) { s += src[j]; j++; }
      toks.push({ t: 'num', v: parseFloat(s) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; let s = '';
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) { s += src[j]; j++; }
      toks.push({ t: 'ident', v: s }); i = j; continue;
    }
    if (c === '(') { toks.push({ t: 'lparen' }); i++; continue; }
    if (c === ')') { toks.push({ t: 'rparen' }); i++; continue; }
    if (c === ',') { toks.push({ t: 'comma' }); i++; continue; }
    // multi-char operators first
    const two = src.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '<>'].includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/=<>'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Error('unexpected char: ' + c);
  }
  return toks;
}

// ── Parser → AST ───────────────────────────────────────────────────

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'field'; v: string }
  | { k: 'unary'; op: string; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'call'; name: string; args: Node[] };

class Parser {
  toks: Tok[];
  pos = 0;
  constructor(toks: Tok[]) { this.toks = toks; }
  peek(): Tok | undefined { return this.toks[this.pos]; }
  next(): Tok | undefined { return this.toks[this.pos++]; }

  parse(): Node {
    const e = this.comparison();
    if (this.pos !== this.toks.length) throw new Error('trailing input');
    return e;
  }
  comparison(): Node {
    let l = this.additive();
    while (this.peek()?.t === 'op' && ['=', '==', '!=', '<>', '>', '>=', '<', '<='].includes((this.peek() as { v: string }).v)) {
      const op = (this.next() as { v: string }).v;
      l = { k: 'bin', op, l, r: this.additive() };
    }
    return l;
  }
  additive(): Node {
    let l = this.multiplicative();
    while (this.peek()?.t === 'op' && ['+', '-'].includes((this.peek() as { v: string }).v)) {
      const op = (this.next() as { v: string }).v;
      l = { k: 'bin', op, l, r: this.multiplicative() };
    }
    return l;
  }
  multiplicative(): Node {
    let l = this.unary();
    while (this.peek()?.t === 'op' && ['*', '/'].includes((this.peek() as { v: string }).v)) {
      const op = (this.next() as { v: string }).v;
      l = { k: 'bin', op, l, r: this.unary() };
    }
    return l;
  }
  unary(): Node {
    if (this.peek()?.t === 'op' && (this.peek() as { v: string }).v === '-') {
      this.next();
      return { k: 'unary', op: '-', e: this.unary() };
    }
    return this.primary();
  }
  primary(): Node {
    const tk = this.next();
    if (!tk) throw new Error('unexpected end');
    if (tk.t === 'num') return { k: 'num', v: tk.v };
    if (tk.t === 'str') return { k: 'str', v: tk.v };
    if (tk.t === 'field') return { k: 'field', v: tk.v };
    if (tk.t === 'lparen') {
      const e = this.comparison();
      if (this.next()?.t !== 'rparen') throw new Error('missing )');
      return e;
    }
    if (tk.t === 'ident') {
      if (this.peek()?.t === 'lparen') {
        this.next(); // (
        const args: Node[] = [];
        if (this.peek()?.t !== 'rparen') {
          args.push(this.comparison());
          while (this.peek()?.t === 'comma') { this.next(); args.push(this.comparison()); }
        }
        if (this.next()?.t !== 'rparen') throw new Error('missing )');
        return { k: 'call', name: tk.v.toUpperCase(), args };
      }
      // bare identifiers: TRUE/FALSE constants, else error
      const up = tk.v.toUpperCase();
      if (up === 'TRUE') return { k: 'num', v: 1 };
      if (up === 'FALSE') return { k: 'num', v: 0 };
      throw new Error('unknown identifier: ' + tk.v);
    }
    throw new Error('unexpected token');
  }
}

// ── Evaluator ──────────────────────────────────────────────────────

const toNum = (v: FormulaValue): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const toStr = (v: FormulaValue): string => (typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));

function evalNode(node: Node, resolve: (name: string) => FormulaValue): FormulaValue {
  switch (node.k) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'field': return resolve(node.v);
    case 'unary': return -toNum(evalNode(node.e, resolve));
    case 'bin': {
      const l = evalNode(node.l, resolve);
      const r = evalNode(node.r, resolve);
      switch (node.op) {
        case '+': return toNum(l) + toNum(r);
        case '-': return toNum(l) - toNum(r);
        case '*': return toNum(l) * toNum(r);
        case '/': { const d = toNum(r); if (d === 0) throw new Error('div by zero'); return toNum(l) / d; }
        case '=': case '==': return valuesEqual(l, r);
        case '!=': case '<>': return !valuesEqual(l, r);
        case '>': return toNum(l) > toNum(r);
        case '>=': return toNum(l) >= toNum(r);
        case '<': return toNum(l) < toNum(r);
        case '<=': return toNum(l) <= toNum(r);
        default: throw new Error('bad op');
      }
    }
    case 'call': return evalCall(node, resolve);
  }
}

function valuesEqual(l: FormulaValue, r: FormulaValue): boolean {
  if (typeof l === 'number' || typeof r === 'number') return toNum(l) === toNum(r);
  return toStr(l) === toStr(r);
}

function evalCall(node: Extract<Node, { k: 'call' }>, resolve: (name: string) => FormulaValue): FormulaValue {
  const a = node.args.map((x) => evalNode(x, resolve));
  switch (node.name) {
    case 'CONCAT': return a.map(toStr).join('');
    case 'IF': {
      if (a.length < 2) throw new Error('IF needs 2-3 args');
      const cond = typeof a[0] === 'boolean' ? a[0] : toNum(a[0]) !== 0;
      return cond ? a[1] : (a[2] ?? '');
    }
    case 'ROUND': {
      const digits = a.length > 1 ? toNum(a[1]) : 0;
      const f = Math.pow(10, digits);
      return Math.round(toNum(a[0]) * f) / f;
    }
    case 'LEN': return toStr(a[0] ?? '').length;
    case 'UPPER': return toStr(a[0] ?? '').toUpperCase();
    case 'LOWER': return toStr(a[0] ?? '').toLowerCase();
    case 'TODAY': { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
    default: throw new Error('unknown function: ' + node.name);
  }
}

// Cache parsed ASTs by source string — the same formula source is evaluated
// once per record per render pass, so parsing once pays off immediately.
const astCache = new Map<string, Node>();
function parseCached(src: string): Node {
  const hit = astCache.get(src);
  if (hit) return hit;
  const ast = new Parser(tokenize(src)).parse();
  astCache.set(src, ast);
  return ast;
}

export function evaluateFormula(src: string, resolve: (name: string) => FormulaValue): FormulaValue | typeof FORMULA_ERR {
  try {
    if (!src || !src.trim()) return '';
    return evalNode(parseCached(src), resolve);
  } catch {
    return FORMULA_ERR;
  }
}

// ── Field-value resolution (used by formula refs, filters, sort, SUM) ─
//
// Turns a record's raw cell into the "formula-space" value for a field,
// recursing into other formula fields with a cycle guard so
// {A} referencing {B} referencing {A} yields #ERR instead of a stack blow-up.

export function fieldFormulaValue(
  field: Field,
  record: BaseRecord,
  fields: Field[],
  visiting: Set<string> = new Set(),
): FormulaValue {
  const raw = record.cells[field.id];
  switch (field.type) {
    case 'number': case 'currency': case 'rating': {
      const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
      return Number.isFinite(n) ? n : 0;
    }
    case 'checkbox': return raw === true;
    case 'date': { const n = typeof raw === 'number' ? raw : Number(raw); return Number.isFinite(n) && raw != null && raw !== '' ? n : ''; }
    case 'select': {
      const o = field.options?.find((op) => op.id === raw);
      return o ? o.name : '';
    }
    case 'multiSelect': {
      const ids = Array.isArray(raw) ? raw : [];
      return ids.map((id) => field.options?.find((op) => op.id === id)?.name ?? '').filter(Boolean).join(', ');
    }
    case 'formula': {
      const r = computeFormula(field, record, fields, visiting);
      return r === FORMULA_ERR ? '' : r; // as a REFERENCE, an errored formula reads as empty
    }
    default: return raw == null ? '' : String(raw);
  }
}

// Compute a formula field's value for one record. Returns FORMULA_ERR on any
// problem. `visiting` tracks the formula fields currently being computed to
// break reference cycles.
export function computeFormula(
  field: Field,
  record: BaseRecord,
  fields: Field[],
  visiting: Set<string> = new Set(),
): FormulaValue | typeof FORMULA_ERR {
  if (field.type !== 'formula' || !field.formula) return '';
  if (visiting.has(field.id)) return FORMULA_ERR; // cycle
  const nextVisiting = new Set(visiting).add(field.id);
  const byName = new Map(fields.map((f) => [f.name, f]));
  const resolve = (name: string): FormulaValue => {
    const ref = byName.get(name);
    if (!ref) throw new Error('unknown field: ' + name);
    return fieldFormulaValue(ref, record, fields, nextVisiting);
  };
  return evaluateFormula(field.formula, resolve);
}

// Display string for a formula cell (numbers via id-ID formatting).
export function formulaDisplay(value: FormulaValue | typeof FORMULA_ERR): string {
  if (value === FORMULA_ERR) return FORMULA_ERR;
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value;
}
