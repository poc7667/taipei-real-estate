#!/usr/bin/env python3
"""Turn scraped mobile01 JSONL files into one searchable SQLite DB.

    python3 build_db.py                    # every data/m01_*.jsonl -> data/m01.db
    python3 build_db.py data/m01_7000512.jsonl
    python3 build_db.py --show-noise       # print what would be dropped, build nothing
    python3 build_db.py --selftest

Many threads land in one DB, tagged by the `thread` column, so a query can span
them or be scoped to one. Each input also gets its own <name>.clean.jsonl.

Three things happen:
  1. quote header ("X wrote: ...(恕刪)") is split off  -> body is only what the
     author typed. Quotes are 11.4% of all chars and would pollute the index
     with false hits, but the quoted author gives us reply_to (94% resolvable).
  2. junk posts (empty / "+1" / "感謝分享" / <=12 chars) are dropped to a
     .clean.jsonl. Posts that hit a topic keyword or carry an image are never
     dropped -- a 6-char "推 淡江大橋" is signal, not noise.
  3. SQLite: posts + comments + FTS5(trigram) over body.

Source .jsonl is never modified. Re-running rebuilds every output from scratch.

Query it:
    sqlite3 data/m01.db "select ts,author,body from posts
        where tags like '%fees%' and ts < '2015' order by ts limit 5"
    sqlite3 data/m01.db "select snippet(posts_fts,0,'[',']','…',12)
        from posts_fts where posts_fts match '淡江大橋' order by rank limit 5"

FTS5 trigram cannot match strings shorter than 3 chars, so 2-char terms
(漏水/坪數/共有) need LIKE. At 18k rows / 3MB a LIKE scan is ~10ms -- fine.
# ponytail: no reply_to for the 6% of quotes whose author never posted in this
# thread (renamed/deleted accounts). Fuzzy-matching them isn't worth it.
"""
import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

# mobile01 prepends the quoted post as "<author> wrote:\n<text>...(恕刪)\n"
QUOTE = re.compile(r"^(.{0,40}?) wrote:\n(.*?)\(恕刪\)\n?", re.S)

# Topic tags. A post matching any of these is never treated as noise.
TAGS = {
    "price": r"萬/坪|萬一坪|開價|成交價|實價|總價|單價|每坪|降價|議價|殺價",
    "fees": r"管理費|公設比|車位|坪數|權狀|雨遮|虛坪",
    "defect": r"漏水|壁癌|瑕疵|裂縫|驗屋|海砂|輻射|傾斜|沉陷|施工品質|偷工",
    "builder": r"建商|營造|推案|代銷|工地|完工|交屋|預售|成屋|餘屋|餘戶",
    "transit": r"淡江大橋|輕軌|捷運|快速道路|台2線|台二線|塞車|通勤|公車",
    "amenity": r"超市|全聯|家樂福|學校|國小|國中|醫院|診所|市場|便利商店|商圈",
    "villa": r"別墅|透天|電梯別墅|升降機|雙併|農舍",
    "law": r"地目|共有|持分|分割|使用執照|建蔽|容積|重劃|地上權|產權",
    "rent": r"出租|租金|包租|投報|投資|套房|轉手|獲利|套牢|賠售",
    "env": r"淹水|海風|鹽害|東北季風|風大|潮濕|濕氣|地震|土石",
}
TAG_RE = {k: re.compile(v) for k, v in TAGS.items()}

# Order matters: "+1" is also all-punctuation, so agree must be tested first.
NOISE = [
    ("agree", re.compile(r"^[\s+1推.。!！~～^:：)（(]*"
                         r"(\+1|同意|推|認同|贊成|說得好|說的好|中肯|正解|說得真好)"
                         r"[\s+1推.。!！~～^]*$")),
    ("thanks", re.compile(r"^[\s.。!！~～^]*(感謝|謝謝|感恩|thx|thanks)[^\n]{0,12}$", re.I)),
    ("empty/symbols", re.compile(r"^[\s\W_0-9]{0,20}$")),
    ("interjection", re.compile(r"^\s*(哈+|呵+|嗯+|喔+|哦+|唉+|XD+|囧+)[\s.。!！~～?？]*$", re.I)),
]


def split_quote(text):
    """-> (own_body, quoted_author or None)."""
    m = QUOTE.match(text or "")
    if not m:
        return (text or "").strip(), None
    return QUOTE.sub("", text, count=1).strip(), m.group(1).strip() or None


def norm_time(t):
    """'2013-6-9 9:18' -> '2013-06-09 09:18' so plain string sort is chronological."""
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})", t or "")
    if not m:
        return t
    y, mo, d, h, mi = m.groups()
    return f"{y}-{int(mo):02d}-{int(d):02d} {int(h):02d}:{mi}"


def tags_of(body):
    """-> list of tag names. Stored as a JSON array so datasette can facet on it."""
    return [k for k, p in TAG_RE.items() if p.search(body)]


def noise_reason(body, tags, n_img):
    """Why this post is junk, or None to keep it."""
    if tags or n_img:
        return None  # signal keyword or a picture -> keep regardless of length
    for name, pat in NOISE:
        if pat.match(body):
            return name
    if len(body) <= 12:
        return "too-short"
    return None


def prepare(rows, thread=None):
    """-> (kept, dropped) lists of enriched records.

    `authors` is scoped to this thread on purpose: a quoted name only becomes a
    reply_to link if that person posted in the SAME thread.
    """
    authors = {r.get("author") for r in rows}
    kept, dropped = [], []
    for r in rows:
        body, qauthor = split_quote(r.get("text"))
        imgs = [i for i in (r.get("images") or []) if i]
        tags = tags_of(body)
        rec = {
            "thread": thread,
            "post_id": r.get("post_id"),
            "page": r.get("page"),
            "floor": int(r["floor"]) if (r.get("floor") or "").isdigit() else None,
            "ts": norm_time(r.get("time")),
            "author": r.get("author"),
            "body": body,
            "quote_author": qauthor,
            "reply_to": qauthor if qauthor in authors else None,
            "tags": json.dumps(tags),
            "n_img": len(imgs),
            "imgs": json.dumps(imgs, ensure_ascii=False) if imgs else None,
            "comments": r.get("comments") or [],
        }
        reason = noise_reason(body, tags, rec["n_img"])
        (dropped if reason else kept).append((reason, rec))
    return [r for _, r in kept], dropped


SCHEMA = """
CREATE TABLE posts (
  id           INTEGER PRIMARY KEY,
  thread       TEXT,               -- mobile01 thread id, so one DB holds many threads
  post_id      TEXT, page INTEGER, floor INTEGER,
  ts           TEXT,               -- 'YYYY-MM-DD HH:MM', sorts chronologically
  author       TEXT,
  body         TEXT,               -- own words only, quote header stripped
  quote_author TEXT,               -- author named in the quote header
  reply_to     TEXT,               -- quote_author, only if they posted in-thread
  tags         TEXT,               -- JSON array: ["price","villa"]
  n_img        INTEGER, imgs TEXT, -- imgs = JSON array of urls
  yr           TEXT GENERATED ALWAYS AS (substr(ts, 1, 4)) VIRTUAL
);
CREATE INDEX posts_ts ON posts(ts);
CREATE INDEX posts_author ON posts(author);
CREATE INDEX posts_reply ON posts(reply_to);
CREATE INDEX posts_thread ON posts(thread);
CREATE TABLE comments (post_id INTEGER REFERENCES posts(id), raw TEXT);
CREATE INDEX comments_post ON comments(post_id);
CREATE VIRTUAL TABLE posts_fts USING fts5(
  body, content='posts', content_rowid='id', tokenize='trigram');
"""
COLS = ("thread", "post_id", "page", "floor", "ts", "author", "body",
        "quote_author", "reply_to", "tags", "n_img", "imgs")


def build(kept, db_path):
    db_path.unlink(missing_ok=True)
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)
    for rec in kept:
        cur = db.execute(
            f"INSERT INTO posts ({','.join(COLS)}) VALUES ({','.join('?' * len(COLS))})",
            [rec[c] for c in COLS])
        db.executemany("INSERT INTO comments VALUES (?,?)",
                       [(cur.lastrowid, c) for c in rec["comments"]])
    db.execute("INSERT INTO posts_fts(rowid, body) SELECT id, body FROM posts")
    db.commit()
    return db


def selftest():
    body, qa = split_quote("odko wrote:\n沒寫限定一人可買幾碗\n...(恕刪)\n我說說的啦")
    assert (body, qa) == ("我說說的啦", "odko"), (body, qa)
    assert split_quote("沒有引用") == ("沒有引用", None)
    assert split_quote("a wrote:\nx\n(恕刪)") == ("", "a")
    assert norm_time("2013-6-9 9:18") == "2013-06-09 09:18"
    assert norm_time("2013-12-25 16:32") == "2013-12-25 16:32"
    assert norm_time(None) is None
    assert tags_of("開價卻開到67萬/坪") == ["price"]
    assert tags_of("管理費多少?淡江大橋蓋了嗎") == ["fees", "transit"]
    assert tags_of("鬍鬚張魯肉飯真好吃") == []
    # noise only when there is no signal and no image
    assert noise_reason("+1", [], 0) == "agree"
    assert noise_reason("", [], 0) == "empty/symbols"
    assert noise_reason("感謝分享", [], 0) == "thanks"
    assert noise_reason("哈哈哈", [], 0) == "interjection"
    assert noise_reason("同意樓上說的", [], 0) == "too-short"
    assert noise_reason("推 淡江大橋", ["transit"], 0) is None  # short but signal
    assert noise_reason("如下圖", [], 3) is None               # short but has images
    assert noise_reason("這一段路每天都要花我30分鐘實在受不了", [], 0) is None
    kept, dropped = prepare([
        {"page": 1, "floor": "2", "time": "2013-1-2 9:00", "author": "a",
         "text": "b wrote:\nq\n(恕刪)\n開價67萬/坪", "images": [], "comments": ["x"]},
        {"page": 1, "floor": "3", "time": "2013-1-2 9:01", "author": "b",
         "text": "+1", "images": [], "comments": []},
    ], thread="999")
    assert len(kept) == 1 and len(dropped) == 1, (kept, dropped)
    assert kept[0]["reply_to"] == "b" and kept[0]["tags"] == '["price"]'
    assert kept[0]["ts"] == "2013-01-02 09:00" and kept[0]["thread"] == "999"
    db = build(kept, Path("/tmp/_selftest.db"))
    assert db.execute("SELECT count(*) FROM posts").fetchone()[0] == 1
    assert db.execute("SELECT count(*) FROM comments").fetchone()[0] == 1
    assert db.execute("SELECT count(*) FROM posts_fts WHERE posts_fts MATCH '67萬'"
                      ).fetchone()[0] == 1
    assert db.execute("SELECT thread FROM posts").fetchone()[0] == "999"
    # a quoted name that never posted in this thread must NOT become a reply link
    solo, _ = prepare([{"page": 1, "floor": "1", "time": "2020-1-1 1:00", "author": "z",
                        "text": "ghost wrote:\nq\n(恕刪)\n淡江大橋何時通車",
                        "images": [], "comments": []}], thread="1")
    assert solo[0]["quote_author"] == "ghost" and solo[0]["reply_to"] is None
    assert thread_of(Path("data/m01_3008946.jsonl")) == "3008946"
    assert thread_of(Path("whatever.jsonl")) == "whatever"
    Path("/tmp/_selftest.db").unlink()
    print("selftest OK")


def thread_of(path):
    """data/m01_3008946.jsonl -> '3008946'; anything else -> the stem."""
    m = re.match(r"m01_(\d+)", path.stem)
    return m.group(1) if m else path.stem


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("jsonl", nargs="*", type=Path,
                    help="one or more scraped .jsonl (default: every data/m01_*.jsonl)")
    ap.add_argument("--out", type=Path, default=Path("data/m01.db"),
                    help="combined DB path")
    ap.add_argument("--show-noise", action="store_true",
                    help="print dropped posts grouped by reason, write nothing")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        selftest()
        sys.exit()

    files = a.jsonl or sorted(p for p in Path("data").glob("m01_*.jsonl")
                              if ".clean" not in p.name)
    if not files:
        sys.exit("no data/m01_*.jsonl found -- run scrape_m01.py first")

    from collections import Counter
    all_kept, all_dropped, per_thread = [], [], []
    for path in files:
        rows = [json.loads(l) for l in path.open(encoding="utf-8") if l.strip()]
        kept, dropped = prepare(rows, thread=thread_of(path))
        all_kept += kept
        all_dropped += dropped
        per_thread.append((path, len(rows), kept, dropped))

    if a.show_noise:
        for reason, n in Counter(r for r, _ in all_dropped).most_common():
            print(f"\n=== {reason}: {n}")
            for r, rec in all_dropped:
                if r == reason:
                    print(f"  t{rec['thread']} p{rec['page']} #{rec['floor']} "
                          f"{rec['author']}: {rec['body']!r}")
        sys.exit()

    for path, n_raw, kept, dropped in per_thread:
        clean = path.with_name(path.stem + ".clean.jsonl")
        with clean.open("w", encoding="utf-8") as f:
            for rec in kept:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        reasons = "  ".join(f"{r}:{n}" for r, n
                            in Counter(x for x, _ in dropped).most_common())
        print(f"{path.name:28} {n_raw:>6} read  {len(kept):>6} kept  "
              f"{len(dropped):>4} dropped   {reasons}")

    db = build(all_kept, a.out)
    print(f"\n{a.out}  {len(all_kept)} posts from {len(files)} thread(s), "
          f"{db.execute('SELECT count(*) FROM comments').fetchone()[0]} comments, "
          f"{db.execute('SELECT count(*) FROM posts WHERE reply_to IS NOT NULL').fetchone()[0]}"
          f" reply links, {a.out.stat().st_size / 1e6:.1f} MB")
