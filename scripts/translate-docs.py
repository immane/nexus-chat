#!/usr/bin/env python3
"""Mirror docs/ to docs-zh/ with Chinese translation via deep-translator (free, no API key).

Usage:
    pip install deep-translator
    python scripts/translate-docs.py
    python scripts/translate-docs.py design/00_System_High_Level_Architecture.md  # single file
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs"
DST = ROOT / "docs-zh"

SKIP_DIRS = {"research", "ai", "sdk", "overrides"}

STASH: list[str] = []


def stash(text: str, pattern: str) -> str:
    global STASH

    def _stash(m: re.Match) -> str:
        idx = len(STASH)
        STASH.append(m.group(0))
        return f"<t{idx}/>"

    return re.sub(pattern, _stash, text)


def restore(text: str) -> str:
    global STASH
    for i, block in enumerate(STASH):
        for variant in (f"<t{i}/>", f"<t{i} />", f"<t{i}>", f"<t {i}/>", f"<t {i} />", f"<t {i}>", f"<t{i}>"):
            text = text.replace(variant, block)
    STASH.clear()
    return text


def translate_file(src_path: Path, dst_path: Path, translator) -> None:
    global STASH
    STASH = []

    content = src_path.read_text(encoding="utf-8").strip()
    if not content:
        return

    # Separate frontmatter
    frontmatter = ""
    body = content
    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            frontmatter = content[:end + 3] + "\n\n"
            body = content[end + 3:].strip()

    if not body:
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        dst_path.write_text(frontmatter + "\n", encoding="utf-8")
        return

    # Stash untranslatable blocks in order (most specific first)
    body = stash(body, r"```[\s\S]*?```")          # fenced code blocks
    body = stash(body, r"`[^`]+`")                  # inline code
    body = stash(body, r"<!--[\s\S]*?-->")          # HTML comments
    body = stash(body, r"!\[.*?\]\(.*?\)")          # images
    body = stash(body, r"\[([^\]]*)\]\(([^\)]+)\)")  # links [text](url)

    # Split into paragraphs and translate in chunks (Google free API limit ~5k chars)
    paragraphs = body.split("\n\n")
    chunks: list[str] = []
    current = ""

    for para in paragraphs:
        if len(current) + len(para) + 2 < 4500:
            current = (current + "\n\n" + para) if current else para
        else:
            if current:
                chunks.append(current)
            current = para
    if current:
        chunks.append(current)

    translated_chunks = []
    for i, chunk in enumerate(chunks):
        try:
            tc = translator.translate(chunk)
        except Exception as e:
            print(f"  WARN chunk {i}: {e}, keeping original")
            tc = chunk
        translated_chunks.append(tc)

    body_zh = restore("\n\n".join(translated_chunks))

    dst_path.parent.mkdir(parents=True, exist_ok=True)
    dst_path.write_text(frontmatter + body_zh + "\n", encoding="utf-8")


def main():
    try:
        from deep_translator import GoogleTranslator
    except ImportError:
        print("ERROR: pip install deep-translator")
        sys.exit(1)

    translator = GoogleTranslator(source="en", target="zh-CN")

    # Single file mode
    if len(sys.argv) > 1:
        rel = sys.argv[1]
        translate_file(SRC / rel, DST / rel, translator)
        print(f"Done → {DST / rel}")
        return

    # Full mirror mode
    files = sorted(SRC.rglob("*.md"))
    total = 0

    for src_path in files:
        rel = src_path.relative_to(SRC)
        if any(d in rel.parts for d in SKIP_DIRS):
            continue
        total += 1
        print(f"[{total}] {rel}", end=" ", flush=True)
        translate_file(src_path, DST / rel, translator)
        print("OK")

    print(f"\nDone. {total} files mirrored to {DST}/")


if __name__ == "__main__":
    main()
