#!/usr/bin/env python3
"""Deterministic black-box tests for the repository release gate scripts."""

from __future__ import annotations

import base64
import hashlib
import json
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
UPDATER_VERIFIER = ROOT / ".github/scripts/verify_updater_assets.py"
PORTABLE_VERIFIER = ROOT / ".github/scripts/verify_portable_artifact.py"
RELEASE_MANIFEST = ROOT / ".github/scripts/release_asset_manifest.py"


class UpdaterVerifierTests(unittest.TestCase):
    def make_fixture(self, root: pathlib.Path) -> tuple[list[str], pathlib.Path]:
        assets = root / "assets"
        assets.mkdir()
        fake_minisign = root / "minisign"
        fake_minisign.write_text(
            """#!/usr/bin/env python3
import hashlib, pathlib, sys
args = sys.argv[1:]
def value(flag): return pathlib.Path(args[args.index(flag) + 1])
payload = value('-Vm').read_bytes()
signature = value('-x').read_text(encoding='utf-8')
expected = 'SHA256:' + hashlib.sha256(payload).hexdigest()
raise SystemExit(0 if signature == expected else 1)
""",
            encoding="utf-8",
        )
        fake_minisign.chmod(fake_minisign.stat().st_mode | stat.S_IXUSR)

        payload_names = [
            "quality-platform_1.43.0_x64-setup.exe",
            "quality-platform_1.43.0_aarch64.app.tar.gz",
        ]
        signatures: dict[str, str] = {}
        for ordinal, name in enumerate(payload_names, start=1):
            payload = f"deterministic updater payload {ordinal}\n".encode()
            (assets / name).write_bytes(payload)
            minisig = f"SHA256:{hashlib.sha256(payload).hexdigest()}".encode()
            encoded = base64.b64encode(minisig).decode()
            signatures[name] = encoded
            (assets / f"{name}.sig").write_text(encoded + "\n", encoding="utf-8")

        latest = {
            "version": "1.43.0",
            "platforms": {
                "windows-x86_64": {
                    "signature": signatures[payload_names[0]],
                    "url": f"https://github.com/example/quality/releases/download/v1.43.0/{payload_names[0]}",
                },
                "darwin-aarch64": {
                    "signature": signatures[payload_names[1]],
                    "url": f"https://github.com/example/quality/releases/download/v1.43.0/{payload_names[1]}",
                },
            },
        }
        (assets / "latest.json").write_text(json.dumps(latest), encoding="utf-8")
        names = ["latest.json", *payload_names, *(name + ".sig" for name in payload_names)]
        (assets / "assets.json").write_text(
            json.dumps({"assets": [{"name": name} for name in names]}), encoding="utf-8"
        )
        (root / "tauri.json").write_text(
            json.dumps({"plugins": {"updater": {"pubkey": base64.b64encode(b"fixture public key").decode()}}}),
            encoding="utf-8",
        )
        command = [
            sys.executable,
            str(UPDATER_VERIFIER),
            "--assets-dir", str(assets),
            "--assets-json", str(assets / "assets.json"),
            "--tauri-config", str(root / "tauri.json"),
            "--tag", "v1.43.0",
            "--repo", "example/quality",
            "--minisign-bin", str(fake_minisign),
        ]
        return command, assets

    def test_valid_fixture_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            command, _ = self.make_fixture(pathlib.Path(temp))
            subprocess.run(command, check=True, capture_output=True, text=True)

    def test_tampered_payload_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            command, assets = self.make_fixture(pathlib.Path(temp))
            payload = assets / "quality-platform_1.43.0_x64-setup.exe"
            payload.write_bytes(payload.read_bytes() + b"tampered")
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_tampered_signature_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            command, assets = self.make_fixture(pathlib.Path(temp))
            name = "quality-platform_1.43.0_aarch64.app.tar.gz"
            tampered = base64.b64encode(b"SHA256:" + b"0" * 64).decode()
            (assets / f"{name}.sig").write_text(tampered, encoding="utf-8")
            latest_path = assets / "latest.json"
            latest = json.loads(latest_path.read_text(encoding="utf-8"))
            latest["platforms"]["darwin-aarch64"]["signature"] = tampered
            latest_path.write_text(json.dumps(latest), encoding="utf-8")
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)


class PortableVerifierTests(unittest.TestCase):
    def run_verifier(self, directory: pathlib.Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(PORTABLE_VERIFIER), str(directory)],
            capture_output=True,
            text=True,
        )

    def test_single_inline_html_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = pathlib.Path(temp)
            (output / "index.html").write_text(
                "<!doctype html><style>body{background:url(data:image/png;base64,AA==)}</style>"
                "<main><p>docs: https://example.invalid/help</p>"
                "<img src='data:image/png;base64,AA=='></main><script>globalThis.ok=true</script>",
                encoding="utf-8",
            )
            result = self.run_verifier(output)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_local_dependency_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = pathlib.Path(temp)
            (output / "index.html").write_text("<script src='assets/app.js'></script>", encoding="utf-8")
            result = self.run_verifier(output)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_external_url_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = pathlib.Path(temp)
            (output / "index.html").write_text("<a href='https://example.invalid/'>online</a>", encoding="utf-8")
            result = self.run_verifier(output)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_mixed_srcset_external_candidate_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = pathlib.Path(temp)
            (output / "index.html").write_text(
                "<img srcset='data:image/png;base64,AA== 1x, https://example.invalid/x.png 2x'>",
                encoding="utf-8",
            )
            result = self.run_verifier(output)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_external_css_import_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = pathlib.Path(temp)
            (output / "index.html").write_text(
                "<style>@import 'https://example.invalid/app.css';</style>",
                encoding="utf-8",
            )
            result = self.run_verifier(output)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_extra_artifact_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = pathlib.Path(temp)
            (output / "index.html").write_text("<main>offline</main>", encoding="utf-8")
            (output / "app.js").write_text("", encoding="utf-8")
            result = self.run_verifier(output)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)


class ReleaseAssetManifestTests(unittest.TestCase):
    TAG = "v1.43.0"
    ASSETS = {
        "_1.43.0_x64_zh-CN.msi": b"windows msi",
        "_1.43.0_x64_zh-CN.msi.sig": b"windows msi signature",
        "_1.43.0_x64-setup.exe": b"windows nsis",
        "_1.43.0_x64-setup.exe.sig": b"windows nsis signature",
        "_1.43.0_aarch64.dmg": b"macos dmg",
        "_aarch64.app.tar.gz": b"macos updater",
        "_aarch64.app.tar.gz.sig": b"macos updater signature",
        "quality-platform-portable-1.43.0.html": b"<!doctype html><main>offline</main>",
        "latest.json": b'{"version":"1.43.0"}',
    }
    KINDS = {
        "windows": [
            "_1.43.0_x64_zh-CN.msi", "_1.43.0_x64_zh-CN.msi.sig",
            "_1.43.0_x64-setup.exe", "_1.43.0_x64-setup.exe.sig",
        ],
        "macos": ["_1.43.0_aarch64.dmg", "_aarch64.app.tar.gz", "_aarch64.app.tar.gz.sig"],
        "portable": ["quality-platform-portable-1.43.0.html"],
        "latest": ["latest.json"],
    }

    def make_fixture(self, root: pathlib.Path) -> tuple[list[str], pathlib.Path, pathlib.Path]:
        assets = root / "assets"
        manifests = root / "manifests"
        assets.mkdir()
        manifests.mkdir()
        for name, payload in self.ASSETS.items():
            (assets / name).write_bytes(payload)
        (assets / "assets.json").write_text(
            json.dumps({"assets": [{"name": name} for name in self.ASSETS]}), encoding="utf-8"
        )
        for kind, names in self.KINDS.items():
            document = {
                "version": 1,
                "tag": self.TAG,
                "kind": kind,
                "assets": {
                    name: {
                        "sha256": hashlib.sha256(self.ASSETS[name]).hexdigest(),
                        "bytes": len(self.ASSETS[name]),
                    }
                    for name in names
                },
            }
            (manifests / f"{kind}.json").write_text(json.dumps(document), encoding="utf-8")
        command = [
            sys.executable, str(RELEASE_MANIFEST), "verify",
            "--assets-dir", str(assets),
            "--assets-json", str(assets / "assets.json"),
            "--manifests-dir", str(manifests),
            "--tag", self.TAG,
            "--portable-verifier", str(PORTABLE_VERIFIER),
            "--python", sys.executable,
        ]
        return command, assets, manifests

    def test_exact_release_matrix_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            command, _, _ = self.make_fixture(pathlib.Path(temp))
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_tampered_manual_assets_and_portable_fail(self) -> None:
        for name in ["_1.43.0_x64_zh-CN.msi", "_1.43.0_aarch64.dmg", "quality-platform-portable-1.43.0.html"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                command, assets, _ = self.make_fixture(pathlib.Path(temp))
                (assets / name).write_bytes((assets / name).read_bytes() + b"tampered")
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_extra_or_missing_draft_asset_fails(self) -> None:
        for mode in ["extra", "missing"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                command, assets, _ = self.make_fixture(pathlib.Path(temp))
                metadata = json.loads((assets / "assets.json").read_text(encoding="utf-8"))
                if mode == "extra":
                    (assets / "unreviewed.bin").write_bytes(b"extra")
                    metadata["assets"].append({"name": "unreviewed.bin"})
                else:
                    name = "_1.43.0_aarch64.dmg"
                    (assets / name).unlink()
                    metadata["assets"] = [item for item in metadata["assets"] if item["name"] != name]
                (assets / "assets.json").write_text(json.dumps(metadata), encoding="utf-8")
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_manifest_create_binds_real_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            for name in self.KINDS["windows"]:
                (root / name).write_bytes(self.ASSETS[name])
            output = root / "windows-manifest.json"
            result = subprocess.run([
                sys.executable, str(RELEASE_MANIFEST), "create",
                "--root", str(root), "--tag", self.TAG, "--kind", "windows",
                "--output", str(output),
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            manifest = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(set(manifest["assets"]), set(self.KINDS["windows"]))
            for name in self.KINDS["windows"]:
                self.assertEqual(manifest["assets"][name]["sha256"], hashlib.sha256(self.ASSETS[name]).hexdigest())


if __name__ == "__main__":
    unittest.main()
