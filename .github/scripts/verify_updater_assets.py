#!/usr/bin/env python3
"""Fail-closed verification for updater payloads in a draft release."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import pathlib
import re
import subprocess
import tempfile
from typing import NoReturn
import urllib.parse


PLATFORMS = {
    "windows-x86_64": (r"_x64-setup\.exe$", "Windows x64 NSIS updater"),
    "darwin-aarch64": (r"_aarch64\.app\.tar\.gz$", "macOS arm64 updater"),
}


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def read_json(path: pathlib.Path, description: str) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read valid {description} from {path}: {error}")


def exactly_one(names: list[str], pattern: str, description: str) -> str:
    found = [name for name in names if re.search(pattern, name)]
    if len(found) != 1:
        fail(f"expected exactly one {description}; found {found}")
    return found[0]


def decode_base64(value: str, description: str) -> bytes:
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        fail(f"{description} is not valid base64: {error}")
    if not decoded:
        fail(f"{description} decodes to an empty value")
    return decoded


def verify(args: argparse.Namespace) -> None:
    assets_dir = pathlib.Path(args.assets_dir).resolve()
    if not assets_dir.is_dir():
        fail(f"assets directory does not exist: {assets_dir}")

    metadata = read_json(pathlib.Path(args.assets_json), "release assets metadata")
    if not isinstance(metadata, dict) or not isinstance(metadata.get("assets"), list):
        fail("release assets metadata must contain an assets array")
    assets = metadata["assets"]
    if any(not isinstance(asset, dict) for asset in assets):
        fail("release assets metadata contains a non-object entry")
    names = [asset.get("name") for asset in assets]
    if not names or any(not isinstance(name, str) or not name for name in names):
        fail("release contains empty, invalid, or no asset names")
    if len(names) != len(set(names)):
        fail("release contains duplicate asset names")
    if any(pathlib.PurePosixPath(name).name != name or "\\" in name for name in names):
        fail("release contains an unsafe asset name")

    selected = {
        platform: exactly_one(names, pattern, description)
        for platform, (pattern, description) in PLATFORMS.items()
    }
    latest_name = exactly_one(names, r"^latest\.json$", "latest.json")

    tauri = read_json(pathlib.Path(args.tauri_config), "Tauri configuration")
    try:
        encoded_public_key = tauri["plugins"]["updater"]["pubkey"].strip()
    except (KeyError, TypeError, AttributeError):
        fail("embedded updater public key is missing or invalid")
    public_key = decode_base64(encoded_public_key, "embedded updater public key")

    latest_path = assets_dir / latest_name
    latest = read_json(latest_path, "latest.json")
    if not isinstance(latest, dict):
        fail("latest.json must contain an object")
    expected_version = args.tag.removeprefix("v")
    if latest.get("version") != expected_version:
        fail(f"latest.json version {latest.get('version')!r} != {expected_version!r}")
    platforms = latest.get("platforms")
    if not isinstance(platforms, dict) or set(platforms) != set(selected):
        fail(f"latest.json platform set is invalid: {platforms!r}")

    with tempfile.TemporaryDirectory() as temp_name:
        temp = pathlib.Path(temp_name)
        public_key_path = temp / "updater.pub"
        public_key_path.write_bytes(public_key)
        for platform, asset_name in selected.items():
            asset_path = assets_dir / asset_name
            signature_name = asset_name + ".sig"
            signature_path = assets_dir / signature_name
            if signature_name not in names:
                fail(f"{platform}: signature asset {signature_name!r} is missing from release metadata")
            if not asset_path.is_file() or asset_path.is_symlink():
                fail(f"{platform}: updater payload is missing or is not a regular file")
            if not signature_path.is_file() or signature_path.is_symlink():
                fail(f"{platform}: updater signature is missing or is not a regular file")
            try:
                encoded_signature = signature_path.read_text(encoding="utf-8").strip()
            except (OSError, UnicodeError) as error:
                fail(f"{platform}: cannot read updater signature: {error}")
            decoded_signature = decode_base64(encoded_signature, f"{platform}: updater signature")
            minisig_path = temp / f"{platform}.minisig"
            minisig_path.write_bytes(decoded_signature)
            try:
                subprocess.run(
                    [args.minisign_bin, "-Vm", str(asset_path), "-x", str(minisig_path), "-p", str(public_key_path)],
                    check=True,
                )
            except FileNotFoundError:
                fail(f"minisign executable not found: {args.minisign_bin}")
            except subprocess.CalledProcessError as error:
                fail(f"{platform}: minisign verification failed with exit code {error.returncode}")

            entry = platforms.get(platform)
            if not isinstance(entry, dict):
                fail(f"{platform}: latest.json entry is not an object")
            expected_url = (
                f"https://github.com/{args.repo}/releases/download/"
                f"{args.tag}/{urllib.parse.quote(asset_name)}"
            )
            if entry.get("signature") != encoded_signature or entry.get("url") != expected_url:
                fail(f"{platform}: latest.json does not describe the verified payload/signature")

    print("both updater payloads passed minisign verification with the embedded public key")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-dir", required=True)
    parser.add_argument("--assets-json", required=True)
    parser.add_argument("--tauri-config", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--minisign-bin", default="minisign")
    return parser.parse_args()


if __name__ == "__main__":
    verify(parse_args())
