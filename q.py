#!/usr/bin/env python3
"""Search the m01 DB and print a digest small enough to hand an AI agent.

The point is NOT search -- `sqlite3 ... LIKE` already does that in 7ms. The
point is that "淡江大橋" hits 1,619 posts and no agent can read 1,619 posts.
So: aggregate first (how many, which years, who), then show only the top-N
most substantive hits, truncated. That fits in a context window.

    python3 q.py 管理費 別墅              # AND of all terms
    python3 q.py 漏水 --tags defect       # + tag filter
    python3 q.py 淡江大橋 --from 2020     # + date range
    python3 q.py --thread 7000512         # everything in one thread
    python3 q.py 管理費 --sort recent -n 60 -c 500
    python3 q.py 管理費 --full            # untruncated, for a deep read
    python3 q.py --tags villa,fees        # tags only, no search term
    python3 q.py 管理費 --selftest

Terms are substring matches (LIKE), so 2-char words work -- FTS5 trigram
cannot match those. Ranking is "substance": how many distinct terms a post
hits, then how long it is. --sort recent overrides with newest-first.
"""
import argparse
import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

DB = Path("data/m01.db")


def search(db, terms, tags, ts_from, ts_to, thread=None):
    where, args = [], []
    for t in terms:
        where.append("body LIKE ?")
        args.append(f"%{t}%")
    for tag in tags:
        # exact element match, so --tags fee never matches "fees"
        where.append("EXISTS (SELECT 1 FROM json_each(posts.tags) WHERE value = ?)")
        args.append(tag)
    if thread:
        where.append("thread = ?")
        args.append(thread)
    if ts_from:
        where.append("ts >= ?")
        args.append(ts_from)
    if ts_to:
        where.append("ts < ?")
        args.append(ts_to)
    sql = ("SELECT thread,page,floor,ts,author,body,tags,n_img,reply_to FROM posts"
           + (" WHERE " + " AND ".join(where) if where else ""))
    cols = "thread page floor ts author body tags n_img reply_to".split()
    return [dict(zip(cols, r)) for r in db.execute(sql, args)]


def score(hit, terms):
    """Substance: distinct terms matched first, then length."""
    return (sum(t in hit["body"] for t in terms), len(hit["body"]))


def digest(hits, terms, n, chars, sort, out=sys.stdout):
    p = lambda *a: print(*a, file=out)
    if not hits:
        p("0 hits -- widen the terms, or check the word is spelled as the "
          "forum spells it (e.g. 水悦 vs 水悅).")
        return
    p(f"{len(hits)} hits")
    p("  by thread : " + "  ".join(
        f"t{t}:{c}" for t, c in Counter(h["thread"] for h in hits).most_common()))
    years = Counter(h["ts"][:4] for h in hits if h["ts"])
    p("  by year : " + "  ".join(f"{y}:{c}" for y, c in sorted(years.items())))
    p("  top authors : " + "  ".join(
        f"{a}({c})" for a, c in Counter(h["author"] for h in hits).most_common(8)))
    co = Counter(t for h in hits for t in json.loads(h["tags"]))
    p("  co-occurring tags : " + "  ".join(f"{t}:{c}" for t, c in co.most_common(10)))

    hits.sort(key=(lambda h: h["ts"] or "") if sort == "recent"
              else (lambda h: score(h, terms)), reverse=True)
    shown = hits[:n]
    p(f"\n--- showing {len(shown)}/{len(hits)}, sorted by {sort}"
      + (f", bodies cut at {chars} chars" if chars else "") + " ---")
    for h in shown:
        body = re.sub(r"\n+", " ", h["body"])
        if chars and len(body) > chars:
            body = body[:chars] + "…"
        tags = ",".join(json.loads(h["tags"]))
        head = f"[{h['ts']}] t{h['thread']} p{h['page']} #{h['floor']} {h['author']}"
        if h["reply_to"]:
            head += " →" + h["reply_to"]
        if tags:
            head += "  {" + tags + "}"
        if h["n_img"]:
            head += f"  [{h['n_img']} img]"
        p("\n" + head)
        p(f"  {body}")
    if len(hits) > len(shown):
        p(f"\n[{len(hits) - len(shown)} more hits not shown -- raise -n to see them]")


def selftest():
    db = sqlite3.connect(":memory:")
    db.executescript("""CREATE TABLE posts (thread,page,floor,ts,author,body,tags,n_img,reply_to);
      INSERT INTO posts VALUES
        ('1',1,1,'2013-01-01 09:00','a','管理費很貴又是別墅','["fees","villa"]',0,NULL),
        ('1',2,2,'2020-05-05 10:00','b','管理費還可以接受','["fees"]',2,'a'),
        ('2',3,3,'2021-06-06 11:00','c','完全無關的閒聊','[]',0,NULL);""")
    assert len(search(db, ["管理費"], [], None, None)) == 2
    assert len(search(db, ["管理費", "別墅"], [], None, None)) == 1
    assert len(search(db, [], ["villa"], None, None)) == 1
    assert len(search(db, [], ["fees"], None, None)) == 2
    assert len(search(db, ["管理費"], [], "2020", None)) == 1
    assert len(search(db, ["管理費"], [], None, "2020")) == 1
    assert len(search(db, [], [], None, None, thread="2")) == 1
    assert len(search(db, ["管理費"], [], None, None, thread="2")) == 0
    # tag filter is an exact element match, not a substring of another tag
    assert len(search(db, [], ["fee"], None, None)) == 0
    hits = search(db, ["管理費"], [], None, None)
    assert score(hits[0], ["管理費", "別墅"]) > score(hits[1], ["管理費", "別墅"])
    import io
    buf = io.StringIO()
    digest(hits, ["管理費"], 10, 100, "substance", buf)
    assert "2 hits" in buf.getvalue() and "2013:1" in buf.getvalue()
    buf = io.StringIO()
    digest([], [], 10, 100, "substance", buf)
    assert "0 hits" in buf.getvalue()
    print("selftest OK")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("terms", nargs="*", help="substring terms, ANDed together")
    ap.add_argument("--db", type=Path, default=DB)
    ap.add_argument("--tags", default="", help="comma list, all must be present")
    ap.add_argument("--thread", help="scope to one mobile01 thread id, e.g. 7000512")
    ap.add_argument("--from", dest="ts_from", help="'2020' or '2020-06'")
    ap.add_argument("--to", dest="ts_to", help="exclusive upper bound")
    ap.add_argument("-n", "--limit", type=int, default=30, help="posts to print")
    ap.add_argument("-c", "--chars", type=int, default=300, help="0 = no cut")
    ap.add_argument("--full", action="store_true", help="same as -c 0")
    ap.add_argument("--sort", choices=("substance", "recent"), default="substance")
    ap.add_argument("--json", action="store_true", help="raw hits as JSON")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        selftest()
        sys.exit()
    if not a.terms and not a.tags and not a.thread:
        ap.error("give at least one term, --tags, or --thread")

    db = sqlite3.connect(a.db)
    tags = [t for t in a.tags.split(",") if t]
    hits = search(db, a.terms, tags, a.ts_from, a.ts_to, a.thread)
    if a.json:
        print(json.dumps(hits, ensure_ascii=False, indent=1))
    else:
        digest(hits, a.terms, a.limit, 0 if a.full else a.chars, a.sort)
