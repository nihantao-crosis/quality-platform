#!/usr/bin/env python3
"""Verify that the portable build is exactly one self-contained offline HTML file."""

from __future__ import annotations

import argparse
from html.parser import HTMLParser
import pathlib
import re
from typing import NoReturn
import urllib.parse


URL_ATTRIBUTES = {"src", "href", "poster", "data", "action", "formaction", "srcset"}
DEPENDENCY_ATTRIBUTES = {
    ("script", "src"),
    ("link", "href"),
    ("img", "src"),
    ("source", "src"),
    ("video", "src"),
    ("audio", "src"),
    ("iframe", "src"),
    ("object", "data"),
}
CSS_URL = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.IGNORECASE)
CSS_IMPORT = re.compile(r"@import\b", re.IGNORECASE)


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def url_kind(value: str) -> str:
    candidate = value.strip()
    if not candidate or candidate.startswith("#"):
        return "fragment"
    if candidate.lower().startswith("data:"):
        return "inline"
    if candidate.startswith("//"):
        return "external"
    parsed = urllib.parse.urlsplit(candidate)
    if parsed.scheme:
        return "external"
    return "local"


class PortableHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.errors: list[str] = []
        self.inline_styles: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        lower_tag = tag.lower()
        values = {name.lower(): value or "" for name, value in attrs}
        for name, value in values.items():
            if name == "style":
                self.inline_styles.append(value)
            if name not in URL_ATTRIBUTES or not value.strip():
                continue
            # srcset is a comma-delimited candidate grammar in which data URLs may
            # themselves contain commas. Reject it fail-closed instead of treating
            # the complete attribute as one URL and potentially overlooking a later
            # local or remote candidate.
            if name == "srcset":
                self.errors.append(f"{lower_tag}[srcset] is not allowed in the portable artifact")
                continue
            kind = url_kind(value)
            if (lower_tag, name) in DEPENDENCY_ATTRIBUTES and kind not in {"inline", "fragment"}:
                self.errors.append(f"{lower_tag}[{name}] depends on {kind} URL {value!r}")
            elif kind == "external":
                self.errors.append(f"{lower_tag}[{name}] contains external URL {value!r}")
        if lower_tag == "meta" and values.get("http-equiv", "").lower() == "refresh":
            self.errors.append("meta refresh is not allowed in the portable artifact")

def verify_css_urls(css: str, location: str) -> None:
    if CSS_IMPORT.search(css):
        fail(f"{location} contains a CSS @import rule")
    for match in CSS_URL.finditer(css):
        value = match.group(2).strip()
        if url_kind(value) not in {"inline", "fragment"}:
            fail(f"{location} contains non-inline CSS URL {value!r}")


def verify(directory: pathlib.Path) -> None:
    if not directory.is_dir() or directory.is_symlink():
        fail(f"portable output directory is missing or unsafe: {directory}")
    entries = list(directory.rglob("*"))
    symlinks = [path.relative_to(directory).as_posix() for path in entries if path.is_symlink()]
    if symlinks:
        fail(f"portable output contains symlinks: {symlinks}")
    files = sorted(path.relative_to(directory).as_posix() for path in entries if path.is_file())
    if files != ["index.html"]:
        fail(f"portable output must contain only index.html; found {files}")
    index = directory / "index.html"
    if index.stat().st_size == 0:
        fail("portable index.html is empty")
    try:
        html = index.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        fail(f"portable index.html is not valid UTF-8: {error}")
    parser = PortableHtmlParser()
    try:
        parser.feed(html)
        parser.close()
    except Exception as error:
        fail(f"portable index.html cannot be parsed: {error}")
    if parser.errors:
        fail("portable HTML is not self-contained: " + "; ".join(parser.errors))
    for ordinal, style in enumerate(parser.inline_styles):
        verify_css_urls(style, f"style attribute #{ordinal + 1}")
    for ordinal, css in enumerate(re.findall(r"<style\b[^>]*>(.*?)</style\s*>", html, re.IGNORECASE | re.DOTALL)):
        verify_css_urls(css, f"style block #{ordinal + 1}")
    print(f"portable artifact verified: {index} ({index.stat().st_size} bytes)")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory")
    return parser.parse_args()


if __name__ == "__main__":
    verify(pathlib.Path(parse_args().directory).resolve())
