"""Clean the raw Next.js MDX corpus into plain markdown + a manifest.

Reads:   corpus/          (output of fetch.py)
Writes:  cleaned/         (mirrored tree of .md files)
         cleaned/manifest.json   [{path, title, description, url}, ...]

What it does, in order:
1. Skips "source pointer" files (frontmatter has `source:` — their content
   is pulled from another page we already have). Free deduplication.
2. Extracts frontmatter (title, description), strips it from the body.
3. Reconstructs the public nextjs.org URL from the file path.
4. Walks the body line-by-line, tracking fenced code blocks:
   - INSIDE a fence: content is preserved verbatim; the fence line itself
     is normalized (```tsx filename="app/page.tsx" switcher -> ```tsx),
     with the filename surfaced as a "File: `...`" line above the block.
   - JS/JSX halves of TS/JS `switcher` pairs are dropped (TS kept).
   - OUTSIDE fences: strips {/* MDX comments */}, <AppOnly>/<PagesOnly>
     wrapper tags (content kept), and decorative self-closing components
     (<Image .../>, <Check .../>, <Cross .../>).

Usage:
    python clean.py                       # corpus/ -> cleaned/
    python clean.py --src X --dest Y
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

# --------------------------------------------------------------------------
# Frontmatter
# --------------------------------------------------------------------------

FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Return ({key: value}, body_without_frontmatter).

    The docs frontmatter is flat "key: value" YAML; we parse only the
    top-level scalar keys we care about and ignore nested structures
    (like `related:`), so no YAML dependency is needed.
    """
    match = FRONTMATTER_RE.match(text)
    if not match:
        return {}, text

    meta: dict[str, str] = {}
    for line in match.group(1).splitlines():
        # skip nested/indented lines and list items
        if line.startswith((" ", "\t", "-")) or ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip().strip("'\"")

    return meta, text[match.end() :]


# --------------------------------------------------------------------------
# URL reconstruction
# --------------------------------------------------------------------------

NUM_PREFIX_RE = re.compile(r"^\d+-")


def path_to_url(rel_path: Path) -> str:
    """corpus-relative path -> public nextjs.org URL.

    01-app/01-getting-started/01-installation.mdx
        -> https://nextjs.org/docs/app/getting-started/installation
    01-app/index.mdx -> https://nextjs.org/docs/app
    """
    parts = [NUM_PREFIX_RE.sub("", p) for p in rel_path.with_suffix("").parts]
    if parts and parts[-1] == "index":
        parts = parts[:-1]
    return "https://nextjs.org/docs/" + "/".join(parts)


# --------------------------------------------------------------------------
# Body cleaning (code-fence-aware)
# --------------------------------------------------------------------------

FENCE_RE = re.compile(r"^(\s*)(`{3,})(\w*)\s*(.*)$")  # indent, ticks, lang, attrs
FILENAME_ATTR_RE = re.compile(r'filename="([^"]+)"')
MDX_COMMENT_RE = re.compile(r"\{/\*.*?\*/\}", re.DOTALL)
WRAPPER_TAG_RE = re.compile(r"^\s*</?(AppOnly|PagesOnly)>\s*$")
INLINE_WRAPPER_RE = re.compile(r"</?(AppOnly|PagesOnly)>")
DECORATIVE_RE = re.compile(r"<(Image|Check|Cross)\b[^>]*/?>")

JS_SWITCHER_LANGS = {"js", "jsx"}


@dataclass
class Fence:
    ticks: str
    lang: str
    is_js_switcher: bool  # drop the whole block if True


def clean_body(body: str) -> str:
    """Line-based pass that respects fenced code blocks."""
    # MDX comments can span lines and appear anywhere outside code; the
    # docs only use them outside fences, so a global pass is safe here
    # and simpler than threading multi-line state through the loop.
    body = MDX_COMMENT_RE.sub("", body)

    out: list[str] = []
    fence: Fence | None = None

    for line in body.splitlines():
        m = FENCE_RE.match(line)

        if fence is not None:
            # ---- inside a code block ----
            if m and m.group(2)[: len(fence.ticks)] == fence.ticks and not m.group(3):
                # closing fence (same or longer tick run, no language)
                if not fence.is_js_switcher:
                    out.append(fence.ticks)
                fence = None
            elif not fence.is_js_switcher:
                out.append(line)  # verbatim — never touch code content
            continue

        if m:
            # ---- opening fence ----
            indent, ticks, lang, attrs = m.groups()
            is_js_switcher = "switcher" in attrs and lang in JS_SWITCHER_LANGS
            fence = Fence(ticks=indent + ticks, lang=lang, is_js_switcher=is_js_switcher)
            if not is_js_switcher:
                if fname := FILENAME_ATTR_RE.search(attrs):
                    out.append(f"File: `{fname.group(1)}`")
                out.append(f"{indent}{ticks}{lang}")
            continue

        # ---- ordinary prose line ----
        if WRAPPER_TAG_RE.match(line):
            continue
        line = INLINE_WRAPPER_RE.sub("", line)
        line = DECORATIVE_RE.sub("", line)
        out.append(line)

    # collapse runs of 3+ blank lines left behind by removals
    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"
    return text


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="Clean MDX corpus into markdown")
    parser.add_argument("--src", type=Path, default=Path("corpus"))
    parser.add_argument("--dest", type=Path, default=Path("cleaned"))
    args = parser.parse_args()

    if args.dest.exists():
        shutil.rmtree(args.dest)
    args.dest.mkdir(parents=True)

    manifest: list[dict[str, str]] = []
    skipped_pointers = 0

    for mdx_path in sorted(args.src.rglob("*.mdx")):
        rel = mdx_path.relative_to(args.src)
        meta, body = parse_frontmatter(mdx_path.read_text(encoding="utf-8"))

        if "source" in meta:  # content lives in the referenced page
            skipped_pointers += 1
            continue

        cleaned = clean_body(body)
        out_path = (args.dest / rel).with_suffix(".md")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(cleaned, encoding="utf-8")

        manifest.append(
            {
                "path": str(rel.with_suffix(".md")),
                "title": meta.get("title", rel.stem),
                "description": meta.get("description", ""),
                "url": path_to_url(rel),
            }
        )

    manifest_path = args.dest / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"Cleaned {len(manifest)} files -> {args.dest}/")
    print(f"Skipped {skipped_pointers} source-pointer files (deduplicated)")
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    main()