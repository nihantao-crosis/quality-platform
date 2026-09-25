#!/usr/bin/env python3
"""Verify that the portable build is exactly one self-contained offline HTML file.

Scope: this is a build self-check (it catches a build that accidentally externalises
assets), not a sandbox for hostile code -- inline JavaScript in the top-level bundle is
not analysed. Nested documents are the exception: an ``iframe[srcdoc]`` carries a whole
second document whose markup is invisible to a single-URL attribute check, so its
(entity-decoded) content is parsed recursively with the same rules, and its inline
scripts must not reference any network URL (GAP-6-13).
"""

from __future__ import annotations

import argparse
from html.parser import HTMLParser
import pathlib
import re
from typing import NoReturn
import urllib.parse


URL_ATTRIBUTES = {
    "src", "href", "poster", "data", "action", "formaction", "srcset",
    # Legacy / less common attributes that still make the browser fetch a URL.
    "xlink:href", "background", "imagesrcset", "ping", "manifest", "lowsrc", "dynsrc",
    "longdesc", "codebase", "archive",
}
# Candidate lists whose data URLs may contain commas: reject fail-closed instead of
# guessing where one candidate ends and the next (possibly remote) one begins.
CANDIDATE_LIST_ATTRIBUTES = {"srcset", "imagesrcset"}
DEPENDENCY_ATTRIBUTES = {
    ("script", "src"),
    ("link", "href"),
    ("img", "src"),
    ("source", "src"),
    ("video", "src"),
    ("audio", "src"),
    ("track", "src"),
    ("iframe", "src"),
    ("frame", "src"),
    ("embed", "src"),
    ("input", "src"),
    ("object", "data"),
    ("image", "href"),
    ("image", "xlink:href"),
    ("use", "href"),
    ("use", "xlink:href"),
    ("feimage", "href"),
    ("feimage", "xlink:href"),
    ("html", "manifest"),
}
NESTED_DOCUMENT_ATTRIBUTE = "srcdoc"
MAX_NESTED_DOCUMENT_DEPTH = 4
CSS_URL = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.IGNORECASE)
CSS_IMPORT = re.compile(r"@import\b", re.IGNORECASE)
STYLE_BLOCK = re.compile(r"<style\b[^>]*>(.*?)</style\s*>", re.IGNORECASE | re.DOTALL)
# Any absolute network URL (or protocol-relative string literal) in a nested document's
# inline script: fetch('https://..'), new WebSocket('wss://..'), import('//host/x.js') ...
SCRIPT_NETWORK_URL = re.compile(r"""(?:\b(?:https?|wss?|ftp):/{2})|(?:['"`]\s*//[^/\s'"`])""", re.IGNORECASE)


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
    def __init__(self, location: str = "", depth: int = 0) -> None:
        super().__init__(convert_charrefs=True)
        self.location = location
        self.depth = depth
        self.errors: list[str] = []
        self.inline_styles: list[str] = []
        self.nested_documents: list[tuple[str, str]] = []
        self._script_depth = 0
        self._script_chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        lower_tag = tag.lower()
        # convert_charrefs=True: attribute values arrive entity-decoded (&lt; &quot; &#x2F; ...).
        values = {name.lower(): value or "" for name, value in attrs}
        for name, value in values.items():
            if name == "style":
                self.inline_styles.append(value)
            if name == NESTED_DOCUMENT_ATTRIBUTE:
                self.nested_documents.append((f"{self.location}{lower_tag}[srcdoc] > ", value))
                continue
            if name not in URL_ATTRIBUTES or not value.strip():
                continue
            if name in CANDIDATE_LIST_ATTRIBUTES:
                self.errors.append(f"{self.location}{lower_tag}[{name}] is not allowed in the portable artifact")
                continue
            kind = url_kind(value)
            if (lower_tag, name) in DEPENDENCY_ATTRIBUTES and kind not in {"inline", "fragment"}:
                self.errors.append(f"{self.location}{lower_tag}[{name}] depends on {kind} URL {value!r}")
            elif kind == "external":
                self.errors.append(f"{self.location}{lower_tag}[{name}] contains external URL {value!r}")
        if lower_tag == "meta" and values.get("http-equiv", "").lower() == "refresh":
            self.errors.append(f"{self.location}meta refresh is not allowed in the portable artifact")
        if lower_tag == "script":
            self._script_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script" and self._script_depth > 0:
            self._script_depth -= 1
            if self.depth > 0:
                script = "".join(self._script_chunks)
                match = SCRIPT_NETWORK_URL.search(script)
                if match:
                    self.errors.append(
                        f"{self.location}inline script references network URL near {script[match.start():match.start() + 60]!r}"
                    )
            self._script_chunks = []

    def handle_data(self, data: str) -> None:
        if self._script_depth > 0:
            self._script_chunks.append(data)


def css_url_errors(css: str, location: str) -> list[str]:
    if CSS_IMPORT.search(css):
        return [f"{location} contains a CSS @import rule"]
    errors = []
    for match in CSS_URL.finditer(css):
        value = match.group(2).strip()
        if url_kind(value) not in {"inline", "fragment"}:
            errors.append(f"{location} contains non-inline CSS URL {value!r}")
    return errors


def document_errors(html: str, location: str = "", depth: int = 0) -> list[str]:
    """All self-containment violations of one document, including nested srcdoc documents."""
    parser = PortableHtmlParser(location, depth)
    try:
        parser.feed(html)
        parser.close()
    except Exception as error:  # noqa: BLE001 - any parser failure is a gate failure
        return [f"{location or 'portable index.html '}cannot be parsed: {error}"]
    errors = list(parser.errors)
    for ordinal, style in enumerate(parser.inline_styles):
        errors.extend(css_url_errors(style, f"{location}style attribute #{ordinal + 1}"))
    for ordinal, css in enumerate(STYLE_BLOCK.findall(html)):
        errors.extend(css_url_errors(css, f"{location}style block #{ordinal + 1}"))
    for nested_location, nested_html in parser.nested_documents:
        if depth + 1 > MAX_NESTED_DOCUMENT_DEPTH:
            errors.append(f"{nested_location}nested srcdoc documents exceed depth {MAX_NESTED_DOCUMENT_DEPTH}")
            continue
        errors.extend(document_errors(nested_html, nested_location, depth + 1))
    return errors


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
    errors = document_errors(html)
    if errors:
        fail("portable HTML is not self-contained: " + "; ".join(errors))
    print(f"portable artifact verified: {index} ({index.stat().st_size} bytes)")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory")
    return parser.parse_args()


if __name__ == "__main__":
    verify(pathlib.Path(parse_args().directory).resolve())
