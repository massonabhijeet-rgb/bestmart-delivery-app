#!/usr/bin/env python3
"""
Fetch product images for the BestMart catalog.

- Reads product names from bestmart-inventory-filled.xlsx (first sheet, column 'name').
- Searches DuckDuckGo Images for each name and downloads the top result.
- Resizes to 800x800 (center-crop on white background) and saves as JPEG
  at the highest quality that keeps the file <= 50 KB.
- Writes to product-images/{sanitized-name}.jpg.
- Skips names whose image already exists (so runs are resumable).
- Failures are logged to product-images/_failures.csv.

Usage:
    python3 scripts/fetch_product_images.py            # full run
    python3 scripts/fetch_product_images.py --limit 20 # test batch
"""
from __future__ import annotations

import argparse
import csv
import io
import re
import sys
import time
from pathlib import Path

import openpyxl
import requests
from PIL import Image, ImageOps
from ddgs import DDGS

ROOT = Path(__file__).resolve().parent.parent
XLSX = ROOT / "bestmart-inventory-filled.xlsx"
OUT_DIR = ROOT / "product-images"
FAIL_LOG = OUT_DIR / "_failures.csv"

TARGET_SIZE = 800
TARGET_BYTES = 50 * 1024  # 50 KB
HTTP_TIMEOUT = 15
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


def sanitize_filename(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._ -]+", "", name).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:180]


def load_names(limit: int | None) -> list[str]:
    wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
    ws = wb.active
    names: list[str] = []
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i == 0:
            continue
        if not row or not row[0]:
            continue
        names.append(str(row[0]).strip())
        if limit and len(names) >= limit:
            break
    return names


def search_image_urls(query: str, want: int = 5) -> list[str]:
    urls: list[str] = []
    for q in (f"{query} product packaging", query):
        try:
            with DDGS() as ddgs:
                for result in ddgs.images(q, max_results=want, safesearch="off"):
                    url = result.get("image")
                    if url and url.startswith("http") and url not in urls:
                        urls.append(url)
                        if len(urls) >= want:
                            return urls
        except Exception:
            continue
    return urls


def download(url: str) -> bytes | None:
    try:
        resp = requests.get(
            url,
            timeout=HTTP_TIMEOUT,
            headers={"User-Agent": USER_AGENT, "Referer": "https://duckduckgo.com/"},
        )
        if resp.status_code == 200 and len(resp.content) > 1024:
            return resp.content
    except Exception:
        return None
    return None


def to_800_jpeg(raw: bytes) -> bytes | None:
    try:
        img = Image.open(io.BytesIO(raw))
        img = ImageOps.exif_transpose(img).convert("RGB")
    except Exception:
        return None

    # Center-crop to a square, then resize to 800x800.
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    img = img.crop((left, top, left + side, top + side)).resize(
        (TARGET_SIZE, TARGET_SIZE), Image.LANCZOS
    )

    # Binary-search quality for the largest JPEG <= TARGET_BYTES.
    lo, hi, best = 40, 92, None
    while lo <= hi:
        q = (lo + hi) // 2
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=q, optimize=True, progressive=True)
        data = buf.getvalue()
        if len(data) <= TARGET_BYTES:
            best = data
            lo = q + 1
        else:
            hi = q - 1

    if best is None:
        # Even at q=40 too large — downscale one step and retry once.
        img = img.resize((640, 640), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=70, optimize=True, progressive=True)
        best = buf.getvalue()
        if len(best) > TARGET_BYTES:
            return None
    return best


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="stop after N names")
    parser.add_argument("--sleep", type=float, default=0.7, help="pause between items (seconds)")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    names = load_names(args.limit)
    print(f"[info] {len(names)} products queued → {OUT_DIR}")

    fail_new = not FAIL_LOG.exists()
    failures = open(FAIL_LOG, "a", newline="", encoding="utf-8")
    fail_writer = csv.writer(failures)
    if fail_new:
        fail_writer.writerow(["name", "reason"])

    ok = skip = fail = 0
    for idx, name in enumerate(names, 1):
        fn = sanitize_filename(name)
        target = OUT_DIR / f"{fn}.jpg"
        if target.exists():
            skip += 1
            continue

        urls = search_image_urls(name, want=5)
        if not urls:
            fail += 1
            fail_writer.writerow([name, "no_search_result"])
            print(f"[{idx}/{len(names)}] MISS  {name}")
            time.sleep(args.sleep)
            continue

        jpeg = None
        last_err = ""
        for url in urls:
            raw = download(url)
            if not raw:
                last_err = f"download_failed:{url}"
                continue
            jpeg = to_800_jpeg(raw)
            if jpeg:
                break
            last_err = f"resize_failed:{url}"

        if not jpeg:
            fail += 1
            fail_writer.writerow([name, last_err or "all_candidates_failed"])
            print(f"[{idx}/{len(names)}] FAIL  {name}")
            time.sleep(args.sleep)
            continue

        target.write_bytes(jpeg)
        ok += 1
        print(f"[{idx}/{len(names)}] OK    {name}  ({len(jpeg)//1024} KB)")
        time.sleep(args.sleep)

    failures.close()
    print(f"\n[done] ok={ok} skip={skip} fail={fail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
