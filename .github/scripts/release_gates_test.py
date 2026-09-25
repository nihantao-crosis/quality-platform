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
    """create -> verify 全链路:本地构建名与 GitHub 资产名不同(DESKTOP-01)。

    夹具名取自 v1.42.4 真实发版:本地名来自线上 .sig 的 minisign trusted comment
    (tauri 按磁盘文件名写入),草稿名来自 `gh release view v1.42.4 --json assets`。
    productName「质量分析平台」在上传时被 GitHub 剥掉非 ASCII 字符,macOS 更新包
    由 tauri-action 上传时才插入 `_aarch64`,所以两侧名字系统性不同。
    """

    TAG = "v1.43.0"
    # 角色 -> (清单 kind, 本地构建相对路径, GitHub 草稿资产名, 字节)
    ROLES = {
        "windows-msi": ("windows", "msi/质量分析平台_1.43.0_x64_zh-CN.msi",
                        "_1.43.0_x64_zh-CN.msi", b"windows msi"),
        "windows-msi-signature": ("windows", "msi/质量分析平台_1.43.0_x64_zh-CN.msi.sig",
                                  "_1.43.0_x64_zh-CN.msi.sig", b"windows msi signature"),
        "windows-nsis": ("windows", "nsis/质量分析平台_1.43.0_x64-setup.exe",
                         "_1.43.0_x64-setup.exe", b"windows nsis"),
        "windows-nsis-signature": ("windows", "nsis/质量分析平台_1.43.0_x64-setup.exe.sig",
                                   "_1.43.0_x64-setup.exe.sig", b"windows nsis signature"),
        "macos-dmg": ("macos", "dmg/质量分析平台_1.43.0_aarch64.dmg",
                      "_1.43.0_aarch64.dmg", b"macos dmg"),
        "macos-updater": ("macos", "macos/质量分析平台.app.tar.gz",
                          "_aarch64.app.tar.gz", b"macos updater"),
        "macos-updater-signature": ("macos", "macos/质量分析平台.app.tar.gz.sig",
                                    "_aarch64.app.tar.gz.sig", b"macos updater signature"),
        "portable-html": ("portable", "quality-platform-portable-1.43.0.html",
                          "quality-platform-portable-1.43.0.html",
                          b"<!doctype html><main>offline</main>"),
        "latest-json": ("latest", "latest.json", "latest.json", b'{"version":"1.43.0"}'),
    }
    # 本地 bundle 目录里可能存在、但不属于发布资产的旁路文件,角色正则不得误收。
    LOCAL_NOISE = {
        "windows": {
            "msi/质量分析平台_1.43.0_x64_zh-CN.msi.zip": b"legacy msi zip",
            "nsis/质量分析平台_1.43.0_x64-setup.nsis.zip": b"legacy nsis zip",
            "nsis/质量分析平台_1.43.0_x64-setup.nsis.zip.sig": b"legacy nsis zip sig",
        },
        "macos": {
            "macos/质量分析平台.app/Contents/Info.plist": b"<plist/>",
            "macos/质量分析平台.app/Contents/MacOS/quality-platform": b"binary",
        },
        "portable": {},
        "latest": {},
    }

    def run_script(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(RELEASE_MANIFEST), *args], capture_output=True, text=True
        )

    def write_local_build(self, root: pathlib.Path, kind: str) -> pathlib.Path:
        build = root / f"build-{kind}"
        for role_kind, local, _draft, payload in self.ROLES.values():
            if role_kind == kind:
                (build / local).parent.mkdir(parents=True, exist_ok=True)
                (build / local).write_bytes(payload)
        for local, payload in self.LOCAL_NOISE[kind].items():
            (build / local).parent.mkdir(parents=True, exist_ok=True)
            (build / local).write_bytes(payload)
        return build

    def make_fixture(self, root: pathlib.Path) -> tuple[list[str], pathlib.Path, pathlib.Path]:
        """用生产 create 从真实本地名生成清单,再用 GitHub 名造草稿目录。"""
        assets = root / "assets"
        manifests = root / "manifests"
        assets.mkdir()
        manifests.mkdir()
        for kind in ("windows", "macos", "portable", "latest"):
            build = self.write_local_build(root, kind)
            result = self.run_script(
                "create", "--root", str(build), "--tag", self.TAG, "--kind", kind,
                "--output", str(manifests / f"{kind}.json"),
            )
            self.assertEqual(result.returncode, 0, f"create --kind {kind}: {result.stdout}{result.stderr}")
        for _kind, _local, draft, payload in self.ROLES.values():
            (assets / draft).write_bytes(payload)
        (assets / "assets.json").write_text(
            json.dumps({"assets": [{"name": draft} for _k, _l, draft, _p in self.ROLES.values()]}),
            encoding="utf-8",
        )
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

    def rewrite_metadata(self, assets: pathlib.Path, mutate) -> None:
        metadata = json.loads((assets / "assets.json").read_text(encoding="utf-8"))
        metadata["assets"] = mutate(metadata["assets"])
        (assets / "assets.json").write_text(json.dumps(metadata), encoding="utf-8")

    def test_create_macos_from_real_local_bundle_names(self) -> None:
        # 旧实现:本地更新包叫「质量分析平台.app.tar.gz」(无 _aarch64),
        # create --kind macos 报 expected exactly one macos-updater ...; found [] 并退出 1。
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            build = self.write_local_build(root, "macos")
            output = root / "macos.json"
            result = self.run_script(
                "create", "--root", str(build), "--tag", self.TAG, "--kind", "macos", "--output", str(output),
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            manifest = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(set(manifest["assets"]), {"macos-dmg", "macos-updater", "macos-updater-signature"})

    def test_manifest_create_binds_real_bytes_by_role(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            build = self.write_local_build(root, "windows")
            output = root / "windows-manifest.json"
            result = self.run_script(
                "create", "--root", str(build), "--tag", self.TAG, "--kind", "windows", "--output", str(output),
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            manifest = json.loads(output.read_text(encoding="utf-8"))
            windows_roles = {role for role, spec in self.ROLES.items() if spec[0] == "windows"}
            # 清单键是角色而不是带中文前缀的本地文件名,.msi.zip / .nsis.zip 旁路文件不被误收
            self.assertEqual(set(manifest["assets"]), windows_roles)
            for role in windows_roles:
                _kind, local, _draft, payload = self.ROLES[role]
                record = manifest["assets"][role]
                self.assertEqual(record["sha256"], hashlib.sha256(payload).hexdigest())
                self.assertEqual(record["bytes"], len(payload))
                self.assertEqual(record["source"], pathlib.PurePosixPath(local).name)

    def test_exact_release_matrix_passes_with_github_renamed_assets(self) -> None:
        # 旧实现:清单键「质量分析平台_1.43.0_x64-setup.exe」对不上草稿「_1.43.0_x64-setup.exe」,
        # verify 报 draft release asset set differs from trusted build output 并退出 1。
        with tempfile.TemporaryDirectory() as temp:
            command, _, _ = self.make_fixture(pathlib.Path(temp))
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_tampered_manual_assets_and_portable_fail(self) -> None:
        for name in ["_1.43.0_x64_zh-CN.msi", "_1.43.0_aarch64.dmg", "_aarch64.app.tar.gz",
                     "quality-platform-portable-1.43.0.html"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                command, assets, _ = self.make_fixture(pathlib.Path(temp))
                (assets / name).write_bytes((assets / name).read_bytes() + b"tampered")
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("does not match its immutable build digest", result.stderr)

    def test_swapped_role_bytes_fail(self) -> None:
        # 两个角色互换字节:名字集合与字节集合都不变,只有按角色比对才能拦住。
        with tempfile.TemporaryDirectory() as temp:
            command, assets, _ = self.make_fixture(pathlib.Path(temp))
            msi = assets / "_1.43.0_x64_zh-CN.msi"
            nsis = assets / "_1.43.0_x64-setup.exe"
            msi_bytes, nsis_bytes = msi.read_bytes(), nsis.read_bytes()
            msi.write_bytes(nsis_bytes)
            nsis.write_bytes(msi_bytes)
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("does not match its immutable build digest", result.stderr)

    def test_extra_or_missing_draft_asset_fails(self) -> None:
        # 同角色的第二个候选(例如未被剥名的中文名副本)也必须拦住,不能任取其一。
        extras = ["unreviewed.bin", "质量分析平台_1.43.0_x64-setup.exe", "other_aarch64.app.tar.gz"]
        for mode in [*(f"extra:{name}" for name in extras), "missing"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                command, assets, _ = self.make_fixture(pathlib.Path(temp))
                if mode.startswith("extra:"):
                    name = mode.removeprefix("extra:")
                    (assets / name).write_bytes(b"extra")
                    self.rewrite_metadata(assets, lambda items, name=name: [*items, {"name": name}])
                else:
                    name = "_1.43.0_aarch64.dmg"
                    (assets / name).unlink()
                    self.rewrite_metadata(
                        assets, lambda items, name=name: [item for item in items if item["name"] != name]
                    )
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_downloaded_files_must_match_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            command, assets, _ = self.make_fixture(pathlib.Path(temp))
            (assets / "smuggled.bin").write_bytes(b"not listed in metadata")
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_manifest_missing_role_or_wrong_kind_fails(self) -> None:
        for mode in ["missing-role", "wrong-kind", "unknown-role", "legacy-v1"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                command, _, manifests = self.make_fixture(pathlib.Path(temp))
                path = manifests / "macos.json"
                document = json.loads(path.read_text(encoding="utf-8"))
                if mode == "missing-role":
                    # 构建侧漏记一个角色,不能靠清单自己重新定义「完整发布」
                    del document["assets"]["macos-dmg"]
                elif mode == "wrong-kind":
                    windows = json.loads((manifests / "windows.json").read_text(encoding="utf-8"))
                    document["assets"]["windows-msi"] = windows["assets"].pop("windows-msi")
                    (manifests / "windows.json").write_text(json.dumps(windows), encoding="utf-8")
                elif mode == "unknown-role":
                    document["assets"]["macos-extra"] = dict(document["assets"]["macos-dmg"])
                else:
                    # 旧格式(按本地文件名记账)必须被拒,而不是被当成新格式静默接受
                    document["version"] = 1
                path.write_text(json.dumps(document), encoding="utf-8")
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_create_rejects_ambiguous_local_build(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            build = self.write_local_build(root, "macos")
            (build / "macos/另一个.app.tar.gz").write_bytes(b"second updater")
            result = self.run_script(
                "create", "--root", str(build), "--tag", self.TAG, "--kind", "macos",
                "--output", str(root / "macos.json"),
            )
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("macos-updater", result.stderr)


if __name__ == "__main__":
    unittest.main()
