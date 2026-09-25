#!/usr/bin/env python3
"""Create immutable build digests and verify the exact draft release asset set.

清单按「发布角色」记账(windows-nsis、macos-updater ... -> {sha256, bytes, source}),
而不是按文件名记账。原因(DESKTOP-01):本地构建文件名与 GitHub 草稿资产名系统性不同——
productName「质量分析平台」上传时被 GitHub 剥掉非 ASCII 字符,macOS 更新包本地叫
「质量分析平台.app.tar.gz」,`_aarch64` 是 tauri-action 上传时才插入的。所以每个角色
分别维护「本地构建名」与「草稿资产名」两套正则:create 用前者在构建目录里找产物,
verify 用后者在草稿里找资产,两侧各自必须恰好命中一个,再按角色逐一比对字节。
"""

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
# v1 按本地文件名记账,与草稿资产名永远对不上;v2 起按角色记账。
MANIFEST_VERSION = 2


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def version_from_tag(tag: str) -> str:
    if not re.fullmatch(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", tag):
        fail(f"invalid stable release tag: {tag!r}")
    return tag[1:]


def release_roles(tag: str) -> dict[str, tuple[str, str, str]]:
    """角色 -> (清单 kind, 本地构建名正则, GitHub 草稿资产名正则)。

    两套正则必须分开维护:本地侧带中文 productName 前缀、macOS 更新包不带架构后缀;
    草稿侧前缀被剥成空串、macOS 更新包带 `_aarch64`。fullmatch 保证 `.msi.zip`、
    `.nsis.zip(.sig)` 等本地旁路产物不会被误收。
    """
    version = re.escape(version_from_tag(tag))
    msi = rf"^.*_{version}_x64_zh-CN\.msi$"
    nsis = rf"^.*_{version}_x64-setup\.exe$"
    dmg = rf"^.*_{version}_aarch64\.dmg$"
    portable = rf"^quality-platform-portable-{version}\.html$"
    return {
        "windows-msi": ("windows", msi, msi),
        "windows-msi-signature": ("windows", msi[:-1] + r"\.sig$", msi[:-1] + r"\.sig$"),
        "windows-nsis": ("windows", nsis, nsis),
        "windows-nsis-signature": ("windows", nsis[:-1] + r"\.sig$", nsis[:-1] + r"\.sig$"),
        "macos-dmg": ("macos", dmg, dmg),
        "macos-updater": ("macos", r"^.*\.app\.tar\.gz$", r"^.*_aarch64\.app\.tar\.gz$"),
        "macos-updater-signature": ("macos", r"^.*\.app\.tar\.gz\.sig$", r"^.*_aarch64\.app\.tar\.gz\.sig$"),
        "portable-html": ("portable", portable, portable),
        "latest-json": ("latest", r"^latest\.json$", r"^latest\.json$"),
    }


def is_safe_basename(name: object) -> bool:
    return (isinstance(name, str) and bool(name) and "\\" not in name
            and pathlib.PurePosixPath(name).name == name)


def exactly_one(names: list[str], pattern: str, description: str, where: str) -> str:
    matches = [name for name in names if re.fullmatch(pattern, name)]
    if len(matches) != 1:
        fail(f"expected exactly one {description} in {where}; found {matches}")
    return matches[0]


def files_for_kind(root: pathlib.Path, tag: str, kind: str) -> dict[str, pathlib.Path]:
    if not root.is_dir() or root.is_symlink():
        fail(f"asset root is missing or unsafe: {root}")
    candidates = [path for path in root.rglob("*") if path.is_file() and not path.is_symlink()]
    selected: dict[str, pathlib.Path] = {}
    for role, (role_kind, local_pattern, _release_pattern) in release_roles(tag).items():
        if role_kind != kind:
            continue
        matches = [path for path in candidates if re.fullmatch(local_pattern, path.name)]
        if len(matches) != 1:
            fail(f"expected exactly one {role} in {root}; found {[path.name for path in matches]}")
        selected[role] = matches[0]
    if len({path.name for path in selected.values()}) != len(selected):
        fail(f"one build file matched several release roles in {root}")
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
    for role, path in files.items():
        # source 只作审计留痕(本地构建名);verify 按角色比对字节,不比较文件名。
        assets[role] = {**digest(path), "source": path.name}
    document = {"version": MANIFEST_VERSION, "tag": args.tag, "kind": args.kind, "assets": assets}
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    # ensure_ascii 默认开启:Windows runner 的控制台/文件编码不一定是 UTF-8。
    output.write_text(json.dumps(document, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.kind} release digest manifest with {len(assets)} roles: {output}")


def read_json(path: pathlib.Path, description: str) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read valid {description} from {path}: {error}")


def verify_release(args: argparse.Namespace) -> None:
    version_from_tag(args.tag)
    roles = release_roles(args.tag)
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
        if not isinstance(raw, dict) or raw.get("version") != MANIFEST_VERSION or raw.get("tag") != args.tag:
            fail(f"release digest manifest {path.name} has an invalid version or tag")
        kind = raw.get("kind")
        assets = raw.get("assets")
        if kind not in KINDS or kind in seen_kinds or not isinstance(assets, dict):
            fail(f"release digest manifest {path.name} has an invalid or duplicate kind")
        seen_kinds.add(kind)
        for role, record in assets.items():
            if role not in roles:
                fail(f"trusted manifests contain unrecognized assets: {role!r} in {path.name}")
            if roles[role][0] != kind or role in trusted or not isinstance(record, dict):
                fail(f"release digest manifest {path.name} contains a misplaced or duplicate role {role!r}")
            sha = record.get("sha256")
            size = record.get("bytes")
            source = record.get("source")
            if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
                fail(f"release digest for {role!r} has an invalid SHA-256")
            if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
                fail(f"release digest for {role!r} has an invalid byte length")
            if not is_safe_basename(source):
                fail(f"release digest for {role!r} has an unsafe source name")
            trusted[role] = {"sha256": sha, "bytes": size}
    if seen_kinds != set(KINDS):
        fail(f"trusted manifest kinds are incomplete: {sorted(seen_kinds)}")

    # The semantic matrix is independent of the manifests: a broken build cannot
    # redefine "complete release" by simply omitting one role from its digest file.
    if set(trusted) != set(roles):
        fail(f"trusted manifests are missing release roles: {sorted(set(roles) - set(trusted))}")

    metadata = read_json(pathlib.Path(args.assets_json), "release assets metadata")
    if not isinstance(metadata, dict) or not isinstance(metadata.get("assets"), list):
        fail("release assets metadata must contain an assets array")
    names = [entry.get("name") if isinstance(entry, dict) else None for entry in metadata["assets"]]
    if not all(is_safe_basename(name) for name in names) or len(names) != len(set(names)):
        fail("release metadata contains missing, invalid, unsafe, or duplicate asset names")

    # 草稿侧用 GitHub 资产名正则把每个角色映射到恰好一个资产;同角色多个候选即失败。
    release_names = {
        role: exactly_one(names, release_pattern, role, "draft release")
        for role, (_kind, _local_pattern, release_pattern) in roles.items()
    }
    if len(set(release_names.values())) != len(release_names):
        fail(f"one draft asset matched several release roles: {release_names}")
    if set(names) != set(release_names.values()):
        fail(
            "draft release asset set differs from trusted build output; "
            f"extra={sorted(set(names) - set(release_names.values()))}"
        )

    downloaded = {
        path.name for path in assets_dir.iterdir()
        if path.name != pathlib.Path(args.assets_json).name
    }
    if downloaded != set(names):
        fail(
            "downloaded draft files differ from release metadata; "
            f"missing={sorted(set(names) - downloaded)}, extra={sorted(downloaded - set(names))}"
        )
    for role, name in release_names.items():
        path = assets_dir / name
        if not path.is_file() or path.is_symlink():
            fail(f"draft asset is missing or unsafe: {name!r}")
        if digest(path) != trusted[role]:
            fail(f"draft asset {name!r} ({role}) does not match its immutable build digest")

    portable = release_names["portable-html"]
    with tempfile.TemporaryDirectory() as temp_name:
        output = pathlib.Path(temp_name)
        shutil.copyfile(assets_dir / portable, output / "index.html")
        try:
            subprocess.run([args.python, args.portable_verifier, str(output)], check=True)
        except (OSError, subprocess.CalledProcessError) as error:
            fail(f"downloaded portable artifact failed offline verification: {error}")
    print(f"verified exact {len(trusted)}-role release set against immutable build digests")


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
