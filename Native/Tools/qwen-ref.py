#!/usr/bin/env python3
# OWNER: Q (created by the bring-up, B2)
"""The Python reference for Scrolls' Qwen layer (IOS-SPEC-QWEN §2.1, §6.2 Q1).

Run with ~/Developer/cipher-llm/venv/bin/python -I (mlx 0.32.3, mlx-lm 0.31.3, tokenizers).
Reads only an APFS clone of a snapshot (opened immutable, read-only); never the live atlas.

  demo-passages   --db CLONE --out bank-demo.json [--n 60]
        Real public-domain passages that contain 'bank' (any inflected form), Project Gutenberg books of the Cipher
        collection, English running text; a seeded sample, at most one occurrence per book; with title, author, years.
  occurrences     --db CLONE --out parity-occurrences.json [--per-word 40]
        Occurrences of bank, current, charge, spring and key (40 each, at most 3 per book), for the S6 parity set.
  embed           --model DIR --in inputs.json --out vectors.json [--batch 8] [--dims 256]
        The reference embedding of exactly the given input strings: tokenizer post-processor appends <|endoftext|>,
        sorted by length, right padding, last-token pooling, L2, Matryoshka cut to `dims`, L2 again (QWEN-LAB §1.1).
  compare         --a vectors-a.json --b vectors-b.json [--min 0.999]
        Per-input cosine between two vector files (Swift against Python); exits 1 below the bar.
"""
import argparse, hashlib, json, os, random, re, sqlite3, subprocess, sys, time

SQLITE = '/usr/bin/sqlite3'          # 3.5x: knows the FTS5 contentless_delete option the atlas uses
EOS = 151643
ASTRAL = re.compile('[\U00010000-\U0010FFFF]')
WORDS = re.compile(r"[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)   # only for clipping excerpts; the app windows by u61m-1


def uri(path):
    return f'file:{os.path.abspath(path)}?mode=ro&immutable=1'


def fts_pids(db, terms, collections):
    match = ' OR '.join(f'"{t}"' for t in terms)
    cols = ','.join(str(c) for c in collections)
    sql = (f"select p.id from passage p join document d on d.id=p.document_id "
           f"where p.id in (select rowid from passage_fts where passage_fts match '{match}') "
           f"and d.collection_id in ({cols}) and p.lang='en' and p.field='body' and p.field_class='text' "
           f"and p.quality='ok' and d.dup_of is null and d.deleted_at is null and d.is_translation=0;")
    out = subprocess.run([SQLITE, uri(db), sql], capture_output=True, text=True, check=True).stdout
    return [int(x) for x in out.split()]


def en_forms(w):
    base = [w, w + "'s", w + '’s']
    if w.endswith('e'):
        base += [w + 's', w + 'd', w[:-1] + 'ing']
    elif w.endswith(('s', 'sh', 'ch', 'x')):
        base += [w + 'es', w + 'ed', w + 'ing']
    elif w.endswith('y') and w[-2] not in 'aeiou':
        base += [w[:-1] + 'ies', w[:-1] + 'ied', w + 'ing']
    else:
        base += [w + 's', w + 'ed', w + 'ing']
    return base


def word_regex(forms):
    alt = '|'.join(sorted((re.escape(f) for f in forms), key=len, reverse=True))
    return re.compile(rf'(?<![\w])({alt})(?![\w])', re.IGNORECASE)


class Corpus:
    def __init__(self, db):
        self.db = db
        self.c = sqlite3.connect(uri(db), uri=True)
        self.docs = {}

    def doc_text(self, doc):
        if doc not in self.docs:
            if len(self.docs) > 300:
                self.docs.clear()
            s = self.c.execute('select original from document_text where document_id=?', (doc,)).fetchone()[0]
            self.docs[doc] = (s, bool(ASTRAL.search(s)))
        return self.docs[doc]

    def passage(self, pid):
        doc, a, b = self.c.execute('select document_id, start_off, end_off from passage where id=?', (pid,)).fetchone()
        s, astral = self.doc_text(doc)
        if astral:
            e = s.encode('utf-16-le')
            return doc, e[2 * a:2 * b].decode('utf-16-le')
        return doc, s[a:b]

    def meta(self, doc):
        return self.c.execute('select title, author, y_lo, y_hi, ext_id, license, date_label from document where id=?',
                              (doc,)).fetchone()

    def occurrences(self, word, collections=(2,)):
        forms = en_forms(word)
        terms = sorted({re.sub(r"['’]s$", '', f).lower() for f in forms})
        rx = word_regex(forms)
        out = []
        for pid in fts_pids(self.db, terms, collections):
            doc, text = self.passage(pid)
            for m in rx.finditer(text):
                out.append(dict(pid=pid, doc=doc, s=m.start(), e=m.end(), text=text))
        return out


def u16(s):
    return len(s.encode('utf-16-le')) // 2


def excerpt(text, s, e, words=60):
    """Clip a passage to <= `words` words on each side of [s, e) (code-point offsets), at word starts/ends.
    Returns (excerpt, start, end, clipped_left, clipped_right); offsets are UTF-16 units into the excerpt."""
    left = [m for m in WORDS.finditer(text, 0, s)]
    right = [m for m in WORDS.finditer(text, e)]
    a = left[-words].start() if len(left) > words else 0
    b = right[words - 1].end() if len(right) > words else len(text)
    ex = text[a:b]
    return ex, u16(text[a:s]), u16(text[a:e]), a > 0, b < len(text)


def sample(occ, n, per_doc, key):
    rng = random.Random(int(hashlib.sha256(key.encode()).hexdigest()[:8], 16))
    by = {}
    for o in occ:
        by.setdefault(o['doc'], []).append(o)
    docs = sorted(by)
    rng.shuffle(docs)
    for d in docs:
        by[d].sort(key=lambda o: (o['pid'], o['s']))
        rng.shuffle(by[d])
    out = []
    for r in range(per_doc):
        for d in docs:
            if len(out) >= n:
                return out
            if r < len(by[d]):
                out.append(by[d][r])
    return out


def record(cx, o, word, words=60):
    title, author, ylo, yhi, ext, lic, label = cx.meta(o['doc'])
    ex, a, b, cl, cr = excerpt(o['text'], o['s'], o['e'], words)
    return dict(id=f"p{o['pid']}-{a}", word=word, passage_id=o['pid'], document_id=o['doc'], ext_id=ext,
                title=title, author=author, year_lo=ylo, year_hi=yhi, date_label=label, license=lic,
                text=ex, match_start=a, match_end=b, clipped_left=cl, clipped_right=cr)


def cmd_demo(args):
    cx = Corpus(args.db)
    occ = cx.occurrences('bank')
    picked = sample(occ, args.n, 1, 'bank|scrolls-qwen-demo@1')
    recs = [record(cx, o, 'bank') for o in picked]
    out = dict(schema='scrolls.qwen.demo@1', word='bank',
               source='Project Gutenberg books in the Cipher collection (collection 2), English running text, '
                      'quality ok; every book marked "Public domain in the USA (Project Gutenberg)"',
               selection=f'seeded sample (sha256 key "bank|scrolls-qwen-demo@1"), at most one occurrence per book, '
                         f'{len(recs)} of {len(occ)} occurrences in {len({o["doc"] for o in occ})} books',
               snapshot='m5r', occurrences_total=len(occ), passages=recs)
    json.dump(out, open(args.out, 'w'), ensure_ascii=False, indent=1)
    print(f'{len(recs)} passages of {len(occ)} occurrences -> {args.out}')


def cmd_occurrences(args):
    cx = Corpus(args.db)
    recs = []
    for w in ['bank', 'current', 'charge', 'spring', 'key']:
        occ = cx.occurrences(w)
        picked = sample(occ, args.per_word, 3, f'{w}|scrolls-qwen-parity@1')
        recs += [record(cx, o, w) for o in picked]
        print(w, len(occ), '->', len(picked), file=sys.stderr)
    json.dump(dict(schema='scrolls.qwen.occurrences@1', passages=recs), open(args.out, 'w'), ensure_ascii=False, indent=1)
    print(f'{len(recs)} occurrences -> {args.out}')


def cmd_embed(args):
    import mlx.core as mx
    import numpy as np
    from mlx_lm import load
    from tokenizers import Tokenizer
    data = json.load(open(args.inp))
    items = data['inputs']
    texts = [x['input'] for x in items]
    tok = Tokenizer.from_file(os.path.join(args.model, 'tokenizer.json'))
    ids = [e.ids for e in tok.encode_batch(texts, add_special_tokens=True)]
    for x in ids:
        assert x[-1] == EOS, 'the post-processor must append <|endoftext|>'
    t0 = time.time()
    m, _ = load(args.model)
    load_s = time.time() - t0
    order = sorted(range(len(ids)), key=lambda i: (len(ids[i]), i))
    full = np.zeros((len(ids), 1024), np.float32)
    t1 = time.time()
    for bi in range(0, len(order), args.batch):
        idx = order[bi:bi + args.batch]
        L = max(len(ids[i]) for i in idx)
        arr = np.full((len(idx), L), EOS, np.int32)
        for r, i in enumerate(idx):
            arr[r, :len(ids[i])] = ids[i]
        hs = m.model(mx.array(arr))
        last = mx.array([len(ids[i]) - 1 for i in idx])
        v = hs[mx.arange(len(idx)), last].astype(mx.float32)
        v = v / mx.linalg.norm(v, axis=-1, keepdims=True)
        mx.eval(v)
        full[idx] = np.array(v)
    secs = time.time() - t1
    cut = full[:, :args.dims]
    cut = cut / np.maximum(np.linalg.norm(cut, axis=1, keepdims=True), 1e-12)
    out = dict(schema='scrolls.qwen.vectors@1', runtime=f'mlx (Python) {mx.__version__} on Mac', model=args.model,
               plan=f'b{args.batch}/len/right', dims=args.dims, load_seconds=round(load_s, 3),
               embed_seconds=round(secs, 3),
               vectors=[dict(id=items[i]['id'], tokens=len(ids[i]), vector=[round(float(x), 7) for x in cut[i]])
                        for i in range(len(items))])
    json.dump(out, open(args.out, 'w'))
    print(f'{len(items)} vectors ({args.dims} d) in {secs:.2f} s (load {load_s:.2f} s) -> {args.out}')


def cmd_compare(args):
    import numpy as np
    a = {v['id']: v for v in json.load(open(args.a))['vectors']}
    b = {v['id']: v for v in json.load(open(args.b))['vectors']}
    common = sorted(set(a) & set(b))
    cos, tokdiff = [], 0
    for k in common:
        x, y = np.array(a[k]['vector'], np.float64), np.array(b[k]['vector'], np.float64)
        cos.append(float(x @ y / (np.linalg.norm(x) * np.linalg.norm(y))))
        if a[k].get('tokens') is not None and b[k].get('tokens') is not None and a[k]['tokens'] != b[k]['tokens']:
            tokdiff += 1
    cos = np.array(cos)
    res = dict(n=len(common), only_a=len(set(a) - set(b)), only_b=len(set(b) - set(a)),
               cos_min=round(float(cos.min()), 6), cos_mean=round(float(cos.mean()), 6),
               cos_p01=round(float(np.percentile(cos, 1)), 6), below_bar=int((cos < args.min).sum()),
               token_count_mismatches=tokdiff, bar=args.min)
    res['status'] = 'PASS' if res['below_bar'] == 0 and res['n'] > 0 and res['only_a'] == 0 and res['only_b'] == 0 else 'FAIL'
    print(json.dumps(res))
    if args.out:
        json.dump(res, open(args.out, 'w'), indent=1)
    sys.exit(0 if res['status'] == 'PASS' else 1)


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    d = sub.add_parser('demo-passages'); d.add_argument('--db', required=True); d.add_argument('--out', required=True)
    d.add_argument('--n', type=int, default=60)
    o = sub.add_parser('occurrences'); o.add_argument('--db', required=True); o.add_argument('--out', required=True)
    o.add_argument('--per-word', type=int, default=40)
    e = sub.add_parser('embed'); e.add_argument('--model', required=True); e.add_argument('--in', dest='inp', required=True)
    e.add_argument('--out', required=True); e.add_argument('--batch', type=int, default=8); e.add_argument('--dims', type=int, default=256)
    c = sub.add_parser('compare'); c.add_argument('--a', required=True); c.add_argument('--b', required=True)
    c.add_argument('--min', type=float, default=0.999); c.add_argument('--out')
    args = p.parse_args()
    {'demo-passages': cmd_demo, 'occurrences': cmd_occurrences, 'embed': cmd_embed, 'compare': cmd_compare}[args.cmd](args)


if __name__ == '__main__':
    main()
