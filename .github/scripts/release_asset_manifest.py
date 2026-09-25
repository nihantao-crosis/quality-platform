#!/usr/bin/env python3
"""Create immutable build digests and verify the exact draft release asset set."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import tempfile
from typing import NoReturn


KINDS = ("windows", "macos", "portable", "latest")


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def version_from_tag(tag: str) -> str:
    if not re.fullmatch(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", tag):
        fail(f"invalid stable release tag: {tag!r}")
    return tag[1:]


def expected_patterns(tag: str) -> dict[str, tuple[str, str]]:
    version = re.escape(version_from_tag(tag))
    return {
        "windows-msi": ("windows", rf"^.*_{version}_x64_zh-CN\.msi$"),
        "windows-msi-signature": ("windows", rf"^.*_{version}_x64_zh-CN\.msi\.sig$"),
        "windows-nsis": ("windows", rf"^.*_{version}_x64-setup\.exe$"),
        "windows-nsis-signature": ("windows", rf"^.*_{version}_x64-setup\.exe\.sig$"),
        "macos-dmg": ("macos", rf"^.*_{version}_aarch64\.dmg$"),
        "macos-updater": ("macos", r"^.*_aarch64\.app\.tar\.gz$"),
        "macos-updater-signature": ("macos", r"^.*_aarch64\.app\.tar\.gz\.sig$"),
        "portable-html": ("portable", rf"^quality-platform-portable-{version}\.html$"),
        "latest-json": ("latest", r"^latest\.json$"),
    }


def files_for_kind(root: pathlib.Path, tag: str, kind: str) -> list[pathlib.Path]:
    if not root.is_dir() or root.is_symlink():
        fail(f"asset root is missing or unsafe: {root}")
    candidates = [path for path in root.rglob("*") if path.is_file() and not path.is_symlink()]
    selected: list[pathlib.Path] = []
    for description, (asset_kind, pattern) in expected_patterns(tag).items():
        if asset_kind != kind:
            continue
        matches = [path for path in candidates if re.fullmatch(pattern, path.name)]
        if len(matches) != 1:
            fail(f"expected exactly one {description} in {root}; found {[path.name for path in matches]}")
        selected.append(matches[0])
    return selected


def digest(path: pathlib.Path) -> dict[str, int | str]:
    sha = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
            size += len(block)
    return {"sha256": sha.hexdigest(), "bytes": size}


def create_manifest(args: argparse.Namespace) -> None:
    version_from_tag(args.tag)
    if args.kind not in KINDS:
        fail(f"invalid manifest kind: {args.kind!r}")
    root = pathlib.Path(args.root).resolve()
    files = files_for_kind(root, args.tag, args.kind)
    assets: dict[str, dict[str, int | str]] = {}
    for path in files:
        if path.name in assets:
            fail(f"duplicate asset basename in build output: {path.name!r}")
        assets[path.name] = digest(path)
    document = {"version": 1, "tag": args.tag, "kind": args.kind, "assets": assets}
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(document, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.kind} release digest manifest with {len(assets)} assets: {output}")


def read_json(path: pathlib.Path, description: str) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read valid {description} from {path}: {error}")


def verify_release(args: argparse.Namespace) -> None:
    version_from_tag(args.tag)
    assets_dir = pathlib.Path(args.assets_dir).resolve()
    manifests_dir = pathlib.Path(args.manifests_dir).resolve()
    if not assets_dir.is_dir() or assets_dir.is_symlink():
        fail(f"release assets directory is missing or unsafe: {assets_dir}")
    if not manifests_dir.is_dir() or manifests_dir.is_symlink():
        fail(f"trusted manifests directory is missing or unsafe: {manifests_dir}")

    trusted: dict[str, dict[str, int | str]] = {}
    seen_kinds: set[str] = set()
    manifests = sorted(manifests_dir.glob("*.json"))
    if not manifests:
        fail("no trusted release digest manifests were provided")
    for path in manifests:
        raw = read_json(path, "release digest manifest")
        if not isinstance(raw, dict) or raw.get("version") != 1 or raw.get("tag") != args.tag:
            fail(f"release digest manifest {path.name} has an invalid version or tag")
        kind = raw.get("kind")
        assets = raw.get("assets")
        if kind not in KINDS or kind in seen_kinds or not isinstance(assets, dict):
            fail(f"release digest manifest {path.name} has an invalid or duplicate kind")
        seen_kinds.add(kind)
        for name, record in assets.items():
            if (not isinstance(name, str) or pathlib.PurePosixPath(name).name != name
                    or "\\" in name or name in trusted or not isinstance(record, dict)):
                fail(f"release digest manifest {path.name} contains an unsafe or duplicate asset")
            sha = record.get("sha256")
            size = record.get("bytes")
            if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
                fail(f"release digest for {name!r} has an invalid SHA-256")
            if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
                fail(f"release digest for {name!r} has an invalid byte length")
            trusted[name] = {"sha256": sha, "bytes": size}
    if seen_kinds != set(KINDS):
        fail(f"trusted manifest kinds are incomplete: {sorted(seen_kinds)}")

    # The semantic matrix is independent of the manifests: a broken build cannot
    # redefine "complete release" by simply omitting one artifact from its digest file.
    expected_names: set[str] = set()
    for description, (_kind, pattern) in expected_patterns(args.tag).items():
        matches = [name for name in trusted if re.fullmatch(pattern, name)]
        if len(matches) != 1:
            fail(f"trusted manifests must contain exactly one {description}; found {matches}")
        expected_names.add(matches[0])
    if set(trusted) != expected_names:
        fail(f"trusted manifests contain unrecognized assets: {sorted(set(trusted) - expected_names)}")

    metadata = read_json(pathlib.Path(args.assets_json), "release assets metadata")
    if not isinstance(metadata, dict) or not isinstance(metadata.get("assets"), list):
        fail("release assets metadata must contain an assets array")
    names = [entry.get("name") if isinstance(entry, dict) else None for entry in metadata["assets"]]
    if any(not isinstance(name, str) or not name for name in names) or len(names) != len(set(names)):
        fail("release metadata contains missing, invalid, or duplicate asset names")
    if set(names) != set(trusted):
        fail(
            "draft release asset set differs from trusted build output; "
            f"missing={sorted(set(trusted) - set(names))}, extra={sorted(set(names) - set(trusted))}"
        )

    downloaded = {
        path.name for path in assets_dir.iterdir()
        if path.name != pathlib.Path(args.assets_json).name
    }
    if downloaded != set(trusted):
        fail(
            "downloaded draft files differ from release metadata; "
            f"missing={sorted(set(trusted) - downloaded)}, extra={sorted(downloaded - set(trusted))}"
        )
    for name, expected in trusted.items():
        path = assets_dir / name
        if not path.is_file() or path.is_symlink():
            fail(f"draft asset is missing or unsafe: {name!r}")
        actual = digest(path)
        if actual != expected:
            fail(f"draft asset {name!r} does not match its immutable build digest")

    portable = next(name for name in trusted if re.fullmatch(
        expected_patterns(args.tag)["portable-html"][1], name
    ))
    with tempfile.TemporaryDirectory() as temp_name:
        output = pathlib.Path(temp_name)
        shutil.copyfile(assets_dir / portable, output / "index.html")
        try:
            subprocess.run([args.python, args.portable_verifier, str(output)], check=True)
        except (OSError, subprocess.CalledProcessError) as error:
            fail(f"downloaded portable artifact failed offline verification: {error}")
    print(f"verified exact {len(trusted)}-asset release set against immutable build digests")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("create")
    create.add_argument("--root", required=True)
    create.add_argument("--tag", required=True)
    create.add_argument("--kind", required=True, choices=KINDS)
    create.add_argument("--output", required=True)
    verify = subparsers.add_parser("verify")
    verify.add_argument("--assets-dir", required=True)
    verify.add_argument("--assets-json", required=True)
    verify.add_argument("--manifests-dir", required=True)
    verify.add_argument("--tag", required=True)
    verify.add_argument("--portable-verifier", required=True)
    verify.add_argument("--python", default="python3")
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    if arguments.command == "create":
        create_manifest(arguments)
    else:
        verify_release(arguments)
