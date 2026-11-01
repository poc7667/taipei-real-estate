#!/usr/bin/env python3
"""Scrape any mobile01 thread into JSONL (one record per post).

Akamai blocks curl AND headless Chrome by TLS/UA fingerprint (403 on every
path, even /llms.txt). So: one HEADED Chrome window establishes the session,
then context.request.get() reuses its cookies + network stack -- no per-page
rendering, ~1 request per page.

    python3 scrape_m01.py 'https://www.mobile01.com/topicdetail.php?f=455&t=3008946'
    python3 scrape_m01.py <url> --md thread.md   # render collected JSONL to markdown
    python3 scrape_m01.py --selftest             # parser check, no network

Any topicdetail URL works -- paste it straight from the address bar, &p=N and
other junk params are stripped. Output defaults to data/m01_<threadid>.jsonl.
Re-running skips pages already in the JSONL, so Ctrl-C is safe.
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from bs4 import BeautifulSoup

DEFAULT_URL = "https://www.mobile01.com/topicdetail.php?f=455&t=3008946"


def base_url(url):
    """Canonical thread URL: drop the page param, keep everything else."""
    u = urlsplit(url if "//" in url else "https://" + url)
    if "topicdetail.php" not in u.path:
        sys.exit(f"not a mobile01 thread url (need topicdetail.php): {url}")
    q = "&".join(kv for kv in u.query.split("&") if kv and not kv.startswith("p="))
    return urlunsplit((u.scheme, u.netloc, u.path, q, ""))


def thread_id(url):
    m = re.search(r"[?&]t=(\d+)", url)
    if not m:
        sys.exit(f"no thread id (t=NNN) in url: {url}")
    return m.group(1)


def parse_page(html, page):
    """Extract posts from one topicdetail page."""
    soup = BeautifulSoup(html, "lxml")
    posts = []
    for block in soup.select("div.l-articlePage"):
        pub = block.select_one("div.l-articlePage__publish")
        body = block.select_one("article.c-articleLimit")
        if not (pub and body):
            continue  # page chrome, not a post
        notes = pub.select("div.l-navigation__item span.o-fNotes")
        author = block.select_one(".c-authorInfo__id a, .l-author__info a")
        pid = re.search(r"MsgBox-(\d+)", str(block.get("class")) + block.decode()[:4000])
        posts.append({
            "page": page,
            "post_id": pid.group(1) if pid else None,
            "floor": notes[1].get_text(strip=True).lstrip("#") if len(notes) > 1 else None,
            "time": notes[0].get_text(strip=True) if notes else None,
            "author": author.get_text(strip=True) if author else None,
            "text": body.get_text("\n", strip=True),
            "images": [i.get("data-original") or i.get("src") for i in body.select("img")],
            # ponytail: raw text per inline comment; author is its leading token
            "comments": [
                re.sub(r"\s*(連結|回報)\s*", " ", m.get_text(" ", strip=True)).strip()
                for m in block.select("div.l-leaveMsg.msgItem")
            ],
        })
    return posts


def last_page(html):
    """Highest page number in the pagination strip (it always links the last page)."""
    return max((int(n) for n in re.findall(r"[?&]p=(\d+)", html)), default=1)


def scrape(url, out_path, delay, first, last):
    from playwright.sync_api import sync_playwright

    done = set()
    if out_path.exists():
        with out_path.open(encoding="utf-8") as f:
            done = {json.loads(line)["page"] for line in f if line.strip()}
        print(f"resume: {len(done)} pages already in {out_path}")

    with sync_playwright() as pw:
        # headless=False is load-bearing: Akamai 403s headless Chrome.
        browser = pw.chromium.launch(channel="chrome", headless=False)
        ctx = browser.new_context(locale="zh-TW")
        page = ctx.new_page()
        # goto only warms Akamai's cookies -- it returns a JS-challenge shell, not
        # the article HTML. Real HTML always comes from ctx.request.get() below.
        page.goto(f"{url}&p={first}", wait_until="domcontentloaded", timeout=60_000)

        def fetch(p):
            for attempt in range(4):
                r = ctx.request.get(f"{url}&p={p}", headers={"Referer": url})
                if r.status == 200 and "l-articlePage" in r.text():
                    return r.text()
                # session went stale -> re-navigate in the real browser to refresh cookies
                print(f"  p{p} HTTP {r.status}, re-warming (attempt {attempt + 1})")
                time.sleep(5 * (attempt + 1))
                page.goto(f"{url}&p={p}", wait_until="domcontentloaded", timeout=60_000)
            return None

        total = last or last_page(fetch(first))
        print(f"pages {first}..{total}, delay {delay}s")

        with out_path.open("a", encoding="utf-8") as out:
            for p in range(first, total + 1):
                if p in done:
                    continue
                html = fetch(p)
                if html is None:
                    print(f"  p{p} FAILED, skipping", file=sys.stderr)
                    continue
                posts = parse_page(html, p)
                for post in posts:
                    out.write(json.dumps(post, ensure_ascii=False) + "\n")
                out.flush()
                print(f"  p{p}/{total}  {len(posts)} posts")
                time.sleep(delay)
        browser.close()


def to_md(jsonl_path, md_path):
    rows = sorted(
        (json.loads(l) for l in jsonl_path.open(encoding="utf-8") if l.strip()),
        key=lambda r: (r["page"], int(r["floor"] or 0)),
    )
    with md_path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(f"\n## #{r['floor']} {r['author']} — {r['time']} (p{r['page']})\n\n{r['text']}\n")
            for c in r["comments"]:
                f.write(f"\n> 留言: {c}\n")
    print(f"{len(rows)} posts -> {md_path}")


def selftest():
    html = """<div class="l-articlePage"><div class="l-author__info"><a>tester</a></div>
    <div class="l-articlePage__publish"><div class="u-gapBottom--max c-articleLimit">
    <article class="c-articleLimit">line one<br>line two<img data-original="/x.jpg"></article></div>
    <div class="l-navigation"><div class="l-navigation__item">
    <span class="o-fNotes">2023-06-09 9:18</span><span class="o-fNotes">#17851</span></div></div>
    <div class="MsgBox MsgBox-87629476"></div>
    <div class="l-leaveMsg msgItem">bob nice 2023-06-13 9:21 連結 回報</div></div></div>
    <div class="l-articlePage">no publish block here</div>"""
    (post,) = parse_page(html, 7)
    assert post["floor"] == "17851", post
    assert post["author"] == "tester" and post["time"] == "2023-06-09 9:18", post
    assert post["post_id"] == "87629476", post
    assert post["text"] == "line one\nline two" and post["images"] == ["/x.jpg"], post
    assert post["comments"] == ["bob nice 2023-06-13 9:21"], post
    assert last_page("?p=3 &p=1833 &p=12") == 1833
    assert last_page("<html>single page thread</html>") == 1
    assert base_url("https://www.mobile01.com/topicdetail.php?f=455&t=3008946&p=1787") == \
        "https://www.mobile01.com/topicdetail.php?f=455&t=3008946"
    assert base_url("www.mobile01.com/topicdetail.php?t=99&p=2#reply") == \
        "https://www.mobile01.com/topicdetail.php?t=99"
    assert thread_id("...?f=455&t=3008946&p=9") == "3008946"
    print("selftest OK")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Scrape a mobile01 thread to JSONL.")
    ap.add_argument("url", nargs="?", default=DEFAULT_URL,
                    help="any topicdetail.php thread url (paste from address bar)")
    ap.add_argument("--out", type=Path, help="default: data/m01_<threadid>.jsonl")
    ap.add_argument("--delay", type=float, default=1.5, help="seconds between pages")
    ap.add_argument("--first", type=int, default=1)
    ap.add_argument("--last", type=int, default=0, help="0 = read from pagination")
    ap.add_argument("--md", type=Path, help="render existing JSONL to markdown and exit")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        selftest()
        sys.exit()

    url = base_url(a.url)
    out = a.out or Path("data") / f"m01_{thread_id(url)}.jsonl"
    if a.md:
        to_md(out, a.md)
    else:
        out.parent.mkdir(parents=True, exist_ok=True)
        scrape(url, out, a.delay, a.first, a.last)
