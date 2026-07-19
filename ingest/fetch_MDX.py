"""Download the Next.js docs from GitHub without cloning the repo.

Strategy: GitHub serves any repo as a .tar.gz snapshot at
codeload.github.com. We stream that archive and extract ONLY the
members under docs/, skipping the other ~1GB of the monorepo.

Usage:
    python fetch.py                # downloads into ./corpus/
    python fetch.py --dest /tmp/x  # custom destination
"""

from __future__ import annotations

import argparse
import shutil
import tarfile
import tempfile
from pathlib import Path

import httpx

REPO = "vercel/next.js"
BRANCH = "canary"  # Next.js's default branch
DOCS_PREFIX = "docs/"
TARBALL_URL = f"https://codeload.github.com/{REPO}/tar.gz/refs/heads/{BRANCH}"


def download_tarball(dest: Path) -> Path:
    """Stream the repo tarball to disk and return its path."""
    tarball_path = dest / "repo.tar.gz"
    print(f"Downloading {TARBALL_URL} ...")

    with httpx.stream("GET", TARBALL_URL, follow_redirects=True, timeout=120) as resp:
        resp.raise_for_status()
        with open(tarball_path, "wb") as f:
            total = 0
            for chunk in resp.iter_bytes(chunk_size=1 << 20):  # 1 MB chunks
                f.write(chunk)
                total += len(chunk)
                print(f"\r  {total / 1e6:.1f} MB", end="", flush=True)
    print()
    return tarball_path


def extract_docs(tarball_path: Path, out_dir: Path) -> int:
    """Extract only members under <repo-root>/docs/ into out_dir.

    Tarball members are prefixed with "next.js-<branch>/", so we strip
    that first path component and keep anything under docs/.
    """
    count = 0
    with tarfile.open(tarball_path, "r:gz") as tar:
        for member in tar:
            # e.g. "next.js-canary/docs/01-app/index.mdx"
            parts = member.name.split("/", 1)
            if len(parts) < 2 or not parts[1].startswith(DOCS_PREFIX):
                continue
            if not member.isfile():
                continue

            relative = Path(parts[1]).relative_to(DOCS_PREFIX)
            target = out_dir / relative
            target.parent.mkdir(parents=True, exist_ok=True)

            extracted = tar.extractfile(member)
            if extracted is None:
                continue
            with open(target, "wb") as f:
                shutil.copyfileobj(extracted, f)
            count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch Next.js docs from GitHub")
    parser.add_argument("--dest", type=Path, default=Path("corpus"))
    args = parser.parse_args()

    out_dir: Path = args.dest
    if out_dir.exists():
        shutil.rmtree(out_dir)  # fresh corpus every run — idempotent
    out_dir.mkdir(parents=True)

    with tempfile.TemporaryDirectory() as tmp:
        tarball = download_tarball(Path(tmp))
        count = extract_docs(tarball, out_dir)

    mdx_files = sorted(out_dir.rglob("*.mdx"))
    print(f"Extracted {count} files ({len(mdx_files)} .mdx) into {out_dir}/")
    if mdx_files:
        print("Sample:", *[f"  {p.relative_to(out_dir)}" for p in mdx_files[:5]], sep="\n")


if __name__ == "__main__":
    main()