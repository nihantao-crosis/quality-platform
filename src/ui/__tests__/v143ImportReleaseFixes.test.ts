/** v1.43 导入 / QPROJ / 发布链收口回归。
 * @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseMatrix } from "../../core/csv";
import {
  assertXlsxArchiveBudget,
  detectExcelContainer,
  platform,
  type DatasetDb,
} from "../../platform/adapter";
import { applyProjectText, buildProjectJsonFull } from "../../platform/project";
import { xlsxBytesToCsv } from "../../platform/xlsxImport";

function datasetJson(name: string, value: number): string {
  return JSON.stringify({
    name,
    colNames: ["C1"],
    rows: [[value], [value + 1]],
    textCols: [],
    savedAt: "2026-08-01T00:00:00.000Z",
  });
}

function projectText(vault: Record<string, string>): string {
  return JSON.stringify({
    format: "quality-platform-project",
    formatVersion: 4,
    appVersion: "1.43.0",
    exportedAt: "2026-08-01T00:00:00.000Z",
    stores: { "qp-specs-v1": "{}" },
    vault,
  });
}

function memoryDb(initial: Array<[string, string]> = []) {
  const store = new Map<string, string>(initial);
  const db: DatasetDb = {
    async put(name, json) {
      store.set(name, json);
    },
    async get(name) {
      return store.get(name) ?? null;
    },
    async list() {
      return [...store].map(([name, json]) => ({
        name,
        saved_at: "2026-08-01T00:00:00.000Z",
        bytes: new TextEncoder().encode(json).byteLength,
      }));
    },
    async remove(name) {
      return store.delete(name);
    },
    async clear(opId) {
      const removed = store.size;
      store.clear();
      return { opId, committed: true, removed };
    },
    async clearStatus() { return null; },
    async stats() {
      return { count: store.size, total_bytes: 0, path: ":memory:" };
    },
  };
  return { db, store };
}

beforeEach(() => {
  localStorage.clear();
  platform.datasetDb = null;
});

afterEach(() => {
  platform.datasetDb = null;
});

describe("CSV 标量预检", () => {
  it("按后续数据行的真实最大列宽计算总单元格，不信任表头或首行", () => {
    const narrowRows = Array.from({ length: 400 }, () => "1");
    const lateWideRow = Array.from({ length: 5_000 }, () => "1").join(",");
    const result = parseMatrix(
      ["测量值", ...narrowRows, lateWideRow].join("\n"),
    );
    expect("error" in result && result.error).toMatch(/单元格总数/);
  });

  it("超宽首行在整表单元格数组构建前就拒绝", () => {
    const wide = Array.from({ length: 5_001 }, (_, index) => `C${index}`).join(
      "\t",
    );
    const result = parseMatrix(`${wide}\n1\n2`);
    expect("error" in result && result.error).toMatch(/列上限/);
  });
});

describe("Excel 容器魔数分流", () => {
  it("合法 BIFF8/OLE .xls 不走 ZIP 预检且可导入", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["测量值", "班组"],
        [10.1, "甲"],
        [10.2, "乙"],
        [10.3, "甲"],
      ]),
      "数据",
    );
    const bytes = new Uint8Array(
      XLSX.write(wb, { type: "array", bookType: "xls" }) as ArrayBuffer,
    );
    expect(detectExcelContainer(bytes)).toBe("biff8-ole");
    const converted = await xlsxBytesToCsv(bytes);
    if ("error" in converted) throw new Error(converted.error);
    expect(converted.sheetName).toBe("数据");
    const parsed = parseMatrix(converted.csv);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.rows.map((row) => row[0])).toEqual([10.1, 10.2, 10.3]);
    expect(parsed.textCols[0].values).toEqual(["甲", "乙", "甲"]);
  });

  it("OOXML ZIP 仍在 SheetJS 前做 bomb 中央目录预检", async () => {
    const compressed = 1_024;
    const uncompressed = 1024 * 1024 * 1024;
    const local = new Uint8Array(31 + compressed);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, compressed, true);
    lv.setUint32(22, uncompressed, true);
    lv.setUint16(26, 1, true);
    local[30] = 0x61;
    const central = new Uint8Array(47);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, compressed, true);
    cv.setUint32(24, uncompressed, true);
    cv.setUint16(28, 1, true);
    central[46] = 0x61;
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 1, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(12, central.byteLength, true);
    ev.setUint32(16, local.byteLength, true);
    const bomb = new Uint8Array(local.length + central.length + eocd.length);
    bomb.set(local);
    bomb.set(central, local.length);
    bomb.set(eocd, local.length + central.length);

    expect(detectExcelContainer(bomb)).toBe("ooxml-zip");
    expect(() => assertXlsxArchiveBudget(bomb)).toThrow(/解压后|压缩比/);
    expect(await xlsxBytesToCsv(bomb)).toMatchObject({
      error: expect.stringMatching(/解压后|压缩比/),
    });
  });
});

describe("QPROJ vault 名称集", () => {
  it.each(["__proto__", "constructor", "prototype"])(
    "拒绝原型元键 %s，不允许将其解释为数据集名",
    async (reservedName) => {
      const vault = Object.create(null) as Record<string, string>;
      vault[reservedName] = datasetJson(reservedName, 1);
      platform.datasetDb = memoryDb().db;
      const result = await applyProjectText(projectText(vault));
      expect(result.error).toMatch(/原型元键/);
      expect(localStorage.getItem("qp-specs-v1")).toBeNull();
    },
  );

  it("显式 vault 快照精确替换旧库，再导出时名称集对称", async () => {
    const oldJson = datasetJson("旧项目残留", 1);
    const newJson = datasetJson("新项目数据", 10);
    const fake = memoryDb([["旧项目残留", oldJson]]);
    platform.datasetDb = fake.db;

    const imported = await applyProjectText(
      projectText({ 新项目数据: newJson }),
    );
    expect(imported.error).toBeNull();
    expect([...fake.store.keys()]).toEqual(["新项目数据"]);

    const exported = JSON.parse(await buildProjectJsonFull("1.43.0")) as {
      vault: Record<string, string>;
    };
    expect(Object.keys(exported.vault)).toEqual(["新项目数据"]);
    expect(exported.vault["新项目数据"]).toBe(newJson);
  });

  it("桌面端空 vault 快照也显式导出，可清理本机残留集", async () => {
    const fake = memoryDb([["残留", datasetJson("残留", 1)]]);
    platform.datasetDb = fake.db;
    const imported = await applyProjectText(projectText({}));
    expect(imported.error).toBeNull();
    expect(fake.store.size).toBe(0);
    const exported = JSON.parse(await buildProjectJsonFull("1.43.0")) as {
      vault: Record<string, string>;
    };
    expect(exported.vault).toEqual({});
  });

  it("删除快照外残留中途失败时，stores 与数据集库一起回滚", async () => {
    const oldA = datasetJson("旧A", 1);
    const oldB = datasetJson("旧B", 2);
    const next = datasetJson("新", 10);
    const fake = memoryDb([
      ["旧A", oldA],
      ["旧B", oldB],
    ]);
    const baseRemove = fake.db.remove.bind(fake.db);
    let failOnce = true;
    platform.datasetDb = {
      ...fake.db,
      async remove(name) {
        if (name === "旧B" && failOnce) {
          failOnce = false;
          return false;
        }
        return baseRemove(name);
      },
    };
    const oldSpecs = JSON.stringify({
      旧: { lsl: 1, tgt: 2, usl: 3 },
    });
    localStorage.setItem("qp-specs-v1", oldSpecs);

    const result = await applyProjectText(projectText({ 新: next }));
    expect(result.error).toMatch(/写入本机数据集库失败/);
    expect(result.error).toMatch(/已回滚/);
    expect(localStorage.getItem("qp-specs-v1")).toBe(oldSpecs);
    expect(fake.store.get("旧A")).toBe(oldA);
    expect(fake.store.get("旧B")).toBe(oldB);
    expect(fake.store.has("新")).toBe(false);
  });
});

describe("发布链 secret 边界", () => {
  it("备用 Windows 流无手动 old-ref 入口，且真正关闭两类签名产物", () => {
    const workflow = readFileSync(
      ".github/workflows/build-windows.yml",
      "utf8",
    );
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(workflow).toContain("--no-sign");
    // 盲审 P2:覆盖必须走**配置文件**而非内联 JSON——windows-latest 默认 pwsh 对
    // npx.cmd 走 Legacy 传参不转义内嵌双引号,内联 JSON 到达 tauri-cli 时引号已被
    // 消费,CLI 报 "key must be a string" 直接失败(备用构建 100% 不可用)。
    expect(workflow).not.toMatch(/--config\s+'?\{/);
    expect(workflow).toContain('--config ../.github/tauri.windows-unsigned.conf.json');
    const overrideConf = JSON.parse(readFileSync('.github/tauri.windows-unsigned.conf.json', 'utf8'));
    expect(overrideConf.bundle.createUpdaterArtifacts).toBe(false);
    expect(workflow).toContain("quality-platform-windows-unsigned");
  });

  it("正式签名仅在 release-signing environment 的 tag push 作业中读取新 secret", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).toMatch(/environment:\s*\n\s+name: release-signing/);
    expect(workflow).toContain(
      "github.event_name == 'push' && github.ref_type == 'tag'",
    );
    expect(workflow).toContain("secrets.RELEASE_TAURI_SIGNING_PRIVATE_KEY");
    expect(workflow).not.toContain("secrets.TAURI_SIGNING_PRIVATE_KEY");
  });
});
