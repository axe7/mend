// main.ts is mend, the CLI SPEC.md specifies (MIT). It does all ten sections of SPEC.md: the command line, the
// output and exit codes, safe paths, format detection, matching lines at three tiers, unified diffs, SEARCH/REPLACE
// blocks, V4A patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's text as lines, its line break, and whether it ends with one (SPEC.md section 3). */
function fileLines(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinLines(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Two lines equal at a matching tier (SPEC.md section 5): 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

const tiers = (strict: boolean): number[] => (strict ? [0] : [0, 1, 2]);

/** Every occurrence of O in F, at the first tier where one occurs. */
function findOccurrences(O: string[], F: string[], strict: boolean): { tier: number; positions: number[] } | null {
  for (const t of tiers(strict)) {
    const positions: number[] = [];
    for (let i = 0; i + O.length <= F.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!lineEq(O[j]!, F[i + j]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** The first occurrence of O in F at or after `from`, at the first tier with one; an end-of-file chunk only takes one ending at the last line. */
function findOccurrenceFrom(O: string[], F: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  for (const t of tiers(strict)) {
    if (eof) {
      const pos = F.length - O.length;
      if (pos >= from && pos >= 0) {
        let ok = true;
        for (let j = 0; j < O.length; j++) {
          if (!lineEq(O[j]!, F[pos + j]!, t)) {
            ok = false;
            break;
          }
        }
        if (ok) return { tier: t, pos };
      }
    } else {
      for (let i = Math.max(from, 0); i + O.length <= F.length; i++) {
        let ok = true;
        for (let j = 0; j < O.length; j++) {
          if (!lineEq(O[j]!, F[i + j]!, t)) {
            ok = false;
            break;
          }
        }
        if (ok) return { tier: t, pos: i };
      }
    }
  }
  return null;
}

/** The first line at or after `from` equal to one line, at the first tier where one is. */
function findSingleLine(line: string, F: string[], from: number, strict: boolean): number {
  for (const t of tiers(strict)) {
    for (let i = Math.max(from, 0); i < F.length; i++) {
      if (lineEq(line, F[i]!, t)) return i;
    }
  }
  return -1;
}

/** One line of N: `ctx` is its index in O when it is a context line, else null. */
interface NLine {
  text: string;
  ctx: number | null;
}

/** N's replacement lines: a context line is the file's own matched line; at tier 2 every other line is re-indented (section 5). */
function buildN(O: string[], N: NLine[], F: string[], pos: number, tier: number): string[] {
  if (tier !== 2) return N.map((n) => (n.ctx !== null ? F[pos + n.ctx]! : n.text));
  const leadF = leadingWs(F[pos] ?? '');
  const leadP = O.length > 0 ? leadingWs(O[0]!) : '';
  return N.map((n) => {
    if (n.ctx !== null) return F[pos + n.ctx]!;
    const t = n.text;
    if (t.trim() === '') return t;
    return t.startsWith(leadP) ? leadF + t.slice(leadP.length) : t;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  a: number;
  O: string[];
  N: NLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  backslashAfterLastCtxOrPlus: boolean;
  /** a `\` line follows the hunk's last `+` line */
  backslashAfterLastPlus: boolean;
}

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A hunk's body: the lines after its header that start with ` `, `-`, `+` or `\`, or are empty. */
function parseHunkBody(lines: string[], start: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      i++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1) });
      i++;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1) });
      i++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1) });
      i++;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'backslash', text: l.slice(1) });
      i++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it. SPEC.md section 6 defines an empty line as a
  // context line whose text is empty, so a trailing ' ' line is one too, as is a bare empty line; a
  // trailing context line whose text is only spaces, and a trailing '-' or '+' line, are not.
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  return { body, next: i };
}

function hunkFromBody(a: number, body: BodyLine[]): Hunk {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const bl of body) {
    if (bl.kind === 'ctx') {
      O.push(bl.text);
      N.push({ text: bl.text, ctx: O.length - 1 });
    } else if (bl.kind === 'old') O.push(bl.text);
    else if (bl.kind === 'new') N.push({ text: bl.text, ctx: null });
  }
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') lastCtxOrPlus = k;
    if (body[k]!.kind === 'new') lastPlus = k;
  }
  return {
    a,
    O,
    N,
    backslashAfterLastCtxOrPlus: lastCtxOrPlus >= 0 && body[lastCtxOrPlus + 1]?.kind === 'backslash',
    backslashAfterLastPlus: lastPlus >= 0 && body[lastPlus + 1]?.kind === 'backslash',
  };
}

/** A `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function parseDiffGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const idx = rest.indexOf(' b/', 2);
  if (idx < 0) return null;
  const x = rest.slice(2, idx);
  const y = rest.slice(idx + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

/** A `--- <path>` or `+++ <path>` line's path: after the four characters, up to the first tab, surrounding spaces removed. */
function parseHeaderPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim();
}

/** `/dev/null` means no file; a leading `a/` or `b/` is removed from either path. */
function stripPrefix(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

function applyUnifiedHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  let { lines, br, final } = fileLines(before);
  let d = 0;
  for (const h of hunks) {
    if (h.O.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = pos === lines.length;
      const added = h.N.map((n) => n.text);
      lines = [...lines.slice(0, pos), ...added, ...lines.slice(pos)];
      if (atEnd) final = !h.backslashAfterLastCtxOrPlus;
      d += added.length;
      continue;
    }
    const occ = findOccurrences(h.O, lines, strict);
    if (occ === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = occ.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of occ.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + h.O.length === lines.length;
    const repl = buildN(h.O, h.N, lines, best, occ.tier);
    lines = [...lines.slice(0, best), ...repl, ...lines.slice(best + h.O.length)];
    if (atEnd) final = !h.backslashAfterLastCtxOrPlus;
    d += h.N.length - h.O.length;
  }
  return joinLines(lines, br, final);
}

function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.oldPath;
  const newPath = s.newPath;
  const isCreate = (oldPath === null || s.create) && newPath !== null;
  const isDelete = !isCreate && (newPath === null || s.remove) && oldPath !== null;
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  return (tree) => {
    if (oldPath === null && newPath === null) return;
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      const np = newPath!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastPlusHunk: Hunk | null = null;
      for (const h of s.hunks) {
        let hasPlus = false;
        for (const n of h.N) {
          if (n.ctx === null) {
            plus.push(n.text);
            hasPlus = true;
          }
        }
        if (hasPlus) lastPlusHunk = h;
      }
      const endsBreak = lastPlusHunk === null ? true : !lastPlusHunk.backslashAfterLastPlus;
      tree.now.set(np, plus.length === 0 ? '' : `${plus.join('\n')}${endsBreak ? '\n' : ''}`);
      return;
    }
    if (isDelete) {
      const op = oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (isMove) {
      const op = oldPath!;
      const np = newPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyUnifiedHunks(tree.get(op)!, s.hunks, strict, op);
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.recordMove(op, np);
      return;
    }
    const p = oldPath!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyUnifiedHunks(before, s.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface Draft {
    diffGit: [string, string] | null;
    pairOld: string | null;
    pairNew: string | null;
    renameFrom: string | null;
    renameTo: string | null;
    create: boolean;
    remove: boolean;
    hunks: Hunk[];
  }
  const sections: Section[] = [];
  let cur: Draft | null = null;
  const fresh = (diffGit: [string, string] | null, pairOld: string | null, pairNew: string | null): Draft => ({
    diffGit,
    pairOld,
    pairNew,
    renameFrom: null,
    renameTo: null,
    create: false,
    remove: false,
    hunks: [],
  });
  const close = (): void => {
    if (cur === null) return;
    const oldRaw = cur.pairOld ?? cur.renameFrom ?? cur.diffGit?.[0] ?? null;
    const newRaw = cur.pairNew ?? cur.renameTo ?? cur.diffGit?.[1] ?? null;
    sections.push({
      oldPath: oldRaw === null ? null : stripPrefix(oldRaw),
      newPath: newRaw === null ? null : stripPrefix(newRaw),
      create: cur.create,
      remove: cur.remove,
      hunks: cur.hunks,
    });
    cur = null;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const dg = parseDiffGit(l);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      close();
      cur = fresh(dg, null, null);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = parseHunkBody(lines, i + 1);
      cur.hunks.push(hunkFromBody(Number(m[1]), body));
      i = next;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Inside a section's header: before its first hunk.
      if (l.startsWith('--- ')) {
        const nxt = lines[i + 1];
        if (nxt === undefined || !nxt.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.pairOld = parseHeaderPath(l);
        cur.pairNew = parseHeaderPath(nxt);
        i += 2;
        continue;
      }
      if (l.startsWith('+++ ')) {
        cur.pairNew = parseHeaderPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.remove = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (cur === null) {
      // Between sections: a `--- ` line followed by a `+++ ` line starts one; anything else is prose.
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = fresh(null, parseHeaderPath(l), parseHeaderPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // After a section's hunks: a `--- ` line followed by a `+++ ` line starts a new section; anything else is prose.
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      close();
      cur = fresh(null, parseHeaderPath(l), parseHeaderPath(lines[i + 1]!));
      i += 2;
      continue;
    }
    i++;
  }
  close();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  const N: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { lines, br, final } = fileLines(before);
    const occ = findOccurrences(oldLines, lines, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = occ.positions[0]!;
    const repl = buildN(oldLines, N, lines, pos, occ.tier);
    const out = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinLines(out, br, final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(searchIdx + 1, sep), lines.slice(sep + 1, rep), strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

function v4aSectionStart(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (line.startsWith('*** Add File: ')) return { kind: 'add', path: line.slice('*** Add File: '.length).trim() };
  if (line.startsWith('*** Delete File: ')) return { kind: 'delete', path: line.slice('*** Delete File: '.length).trim() };
  if (line.startsWith('*** Update File: ')) return { kind: 'update', path: line.slice('*** Update File: '.length).trim() };
  return null;
}

function parseV4aChunks(body: { text: string; idx: number }[], start: number): V4aChunk[] {
  const chunks: V4aChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; lines: { text: string; idx: number }[] } | null = null;
  const finish = (): void => {
    if (cur === null) return;
    let lo = 0;
    let hi = cur.lines.length;
    while (lo < hi && blank(cur.lines[lo]!.text)) lo++;
    while (hi > lo && blank(cur.lines[hi - 1]!.text)) hi--;
    const O: string[] = [];
    const N: NLine[] = [];
    for (const r of cur.lines.slice(lo, hi)) {
      const t = r.text;
      if (t === '' || t.startsWith(' ')) {
        const text = t === '' ? '' : t.slice(1);
        O.push(text);
        N.push({ text, ctx: O.length - 1 });
      } else if (t.startsWith('-')) O.push(t.slice(1));
      else if (t.startsWith('+')) N.push({ text: t.slice(1), ctx: null });
      else throw new Exit2(`error: parse ${r.idx + 1}`);
    }
    chunks.push({ anchor: cur.anchor, eof: cur.eof, O, N });
    cur = null;
  };
  for (let k = start; k < body.length; k++) {
    const r = body[k]!;
    const t = r.text;
    if (t.startsWith('@@')) {
      finish();
      const anchor = t.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, lines: [] };
      continue;
    }
    if (t === '*** End of File') {
      if (cur === null) cur = { anchor: null, eof: false, lines: [] };
      cur.eof = true;
      finish();
      continue;
    }
    if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${r.idx + 1}`);
        cur = { anchor: null, eof: false, lines: [] };
      }
      cur.lines.push(r);
      continue;
    }
    throw new Exit2(`error: parse ${r.idx + 1}`);
  }
  finish();
  return chunks;
}

function v4aSectionEdit(
  sec: { kind: 'add' | 'delete' | 'update'; path: string },
  raw: { text: string; idx: number }[],
  secLine: number,
  strict: boolean,
): Edit {
  // Blank lines at the end of a section are not part of it; the same holds at its start.
  let lo = 0;
  let hi = raw.length;
  while (lo < hi && blank(raw[lo]!.text)) lo++;
  while (hi > lo && blank(raw[hi - 1]!.text)) hi--;
  const body = raw.slice(lo, hi);
  if (sec.kind === 'add') {
    const fileLinesOut: string[] = [];
    for (const r of body) {
      if (r.text.startsWith('+')) fileLinesOut.push(r.text.slice(1));
      else if (r.text === '') fileLinesOut.push('');
      else throw new Exit2(`error: parse ${r.idx + 1}`);
    }
    const path = sec.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLinesOut.length === 0 ? '' : `${fileLinesOut.join('\n')}\n`);
    };
  }
  if (sec.kind === 'delete') {
    for (const r of body) throw new Exit2(`error: parse ${r.idx + 1}`);
    const path = sec.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let k = 0;
  if (body.length > 0 && body[0]!.text.startsWith('*** Move to: ')) {
    moveTo = body[0]!.text.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks = parseV4aChunks(body, k);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
  const path = sec.path;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const { lines, br, final } = fileLines(before);
    let cur = [...lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findSingleLine(ch.anchor, cur, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.O.length === 0) {
        const pos = ch.eof ? cur.length : cursor;
        const added = ch.N.map((n) => n.text);
        cur = [...cur.slice(0, pos), ...added, ...cur.slice(pos)];
        cursor = pos + added.length;
        continue;
      }
      const occ = findOccurrenceFrom(ch.O, cur, cursor, strict, ch.eof);
      if (occ === null) throw new Fail('no-match', path);
      const repl = buildN(ch.O, ch.N, cur, occ.pos, occ.tier);
      cur = [...cur.slice(0, occ.pos), ...repl, ...cur.slice(occ.pos + ch.O.length)];
      cursor = occ.pos + repl.length;
    }
    const out = joinLines(cur, br, final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const sec = v4aSectionStart(line);
    if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
    const raw: { text: string; idx: number }[] = [];
    let j = i + 1;
    while (j < last && v4aSectionStart(lines[j]!) === null) {
      raw.push({ text: lines[j]!, idx: j });
      j++;
    }
    edits.push(v4aSectionEdit(sec, raw, i + 1, strict));
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const after = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rRows = new Map<string, string>();
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) === null || after(oldP) !== null) continue;
    if (tree.original(newP) !== null || after(newP) === null) continue;
    if (rRows.has(newP)) continue;
    rRows.set(newP, `R ${oldP} -> ${newP}`);
    consumed.add(oldP);
    consumed.add(newP);
  }
  const rowList: { key: string; line: string }[] = [];
  for (const [newP, line] of rRows) rowList.push({ key: newP, line });
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowList.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowList.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rowList.map((r) => r.line), `ok: ${rowList.length} ${rowList.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
