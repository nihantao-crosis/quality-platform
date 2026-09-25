use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

mod db;

const MAX_XLSX_IMPORT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TEXT_DATA_IMPORT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_QPROJ_IMPORT_BYTES: u64 = 64 * 1024 * 1024;

fn text_import_limit(path: &Path) -> (u64, &'static str) {
    let is_project = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("qproj"))
        .unwrap_or(false);
    if is_project {
        (MAX_QPROJ_IMPORT_BYTES, "项目文件超过 64 MB 导入上限")
    } else {
        (
            MAX_TEXT_DATA_IMPORT_BYTES,
            "CSV/TXT 文件超过 20 MB 导入上限",
        )
    }
}

/// 读取过程本身最多消费 limit+1 字节；即使 metadata 检查后文件被替换/追加，
/// 也不会先把任意大文件完整装入内存再事后拒绝。
fn read_file_bounded(path: &Path, limit: u64, limit_error: &str) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if metadata.len() > limit {
        return Err(limit_error.into());
    }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut reader = file.take(limit + 1);
    let mut bytes = Vec::with_capacity(metadata.len().min(limit) as usize);
    reader.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(limit_error.into());
    }
    Ok(bytes)
}

/// Write a complete replacement beside the destination, make its bytes durable,
/// and only then atomically swap it into place. `NamedTempFile::persist` uses the
/// platform replacement primitive, including overwrite-safe behavior on Windows.
fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination has no file name")
    })?;

    fs::create_dir_all(parent)?;

    // A recognizable prefix makes abandoned files diagnosable. On every normal
    // error path the NamedTempFile destructor removes the incomplete file.
    let mut prefix = std::ffi::OsString::from(".");
    prefix.push(file_name);
    prefix.push(".");
    let mut temp = tempfile::Builder::new()
        .prefix(&prefix)
        .suffix(".tmp")
        .tempfile_in(parent)?;

    temp.write_all(contents)?;
    temp.flush()?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|error| error.error)?;

    // On Unix, syncing the directory also makes the rename durable across a
    // sudden power loss. Opening directories as files is not portable to Windows.
    sync_parent_directory(parent)
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> io::Result<()> {
    Ok(())
}

/// 桌面端文件写入 — 由前端 PlatformAdapter 的导出报表调用。
/// 路径来自原生保存对话框，无需 fs 插件的 scope 白名单。
#[tauri::command]
fn save_text_file(path: String, contents: String) -> Result<(), String> {
    atomic_write(Path::new(&path), contents.as_bytes()).map_err(|e| e.to_string())
}

/// 读取文本文件（导入数据用，路径来自原生打开对话框）。
/// 编码回退（双审 P1）：中文 Windows Excel「另存为 CSV」默认 GBK/GB18030，
/// 此前 UTF-8 硬校验直接报「invalid utf-8 sequence」拒导且无指引；
/// 现按 GB18030 解码兜底，与 Web 端 TextDecoder 回退同口径。
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let path = Path::new(&path);
    let (limit, limit_error) = text_import_limit(path);
    let bytes = read_file_bounded(path, limit, limit_error)?;
    // UTF-8 BOM 权威且剥离(第三轮:与 Web 端 decodeTextFileBytes 逐字同口径,
    // 否则桌面端「菜单导入」与「拖入窗口」两条路径对同一文件产出不同文本)
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        // BOM 权威：后续内容必须是严格 UTF-8，坏字节不得用替换字符静默污染数据，
        // 也不得回退 GB18030——与 Web 端 decodeTextFileBytes 同口径。
        return String::from_utf8(bytes[3..].to_vec())
            .map_err(|_| "文件带 UTF-8 BOM，但内容包含非法 UTF-8 字节，已拒绝导入".to_string());
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(text),
        Err(err) => {
            let bytes = err.into_bytes();
            let (text, _, had_errors) = encoding_rs::GB18030.decode(&bytes);
            if had_errors {
                Err("文件既不是 UTF-8 也不是 GB18030 编码；请在 Excel 中另存为「CSV UTF-8（逗号分隔）」后重试".to_string())
            } else {
                Ok(text.into_owned())
            }
        }
    }
}

/// 二进制文件读取（.xlsx 导入用，返回 base64）。
#[tauri::command]
fn read_binary_file(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = read_file_bounded(
        Path::new(&path),
        MAX_XLSX_IMPORT_BYTES,
        "Excel 文件超过 20 MB 导入上限",
    )?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 二进制文件写入（.xlsx 导出用，前端传 base64）。
#[tauri::command]
fn save_binary_file(path: String, data_b64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(|e| e.to_string())?;
    atomic_write(Path::new(&path), &bytes).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // 本机数据集库:SQLite 落在应用数据目录,启动即建库建表
            use tauri::Manager;
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            let db_path = dir.join("datasets.db");
            let conn = rusqlite::Connection::open(&db_path)?;
            db::init_schema(&conn)?;
            app.manage(db::Db(std::sync::Mutex::new(conn)));
            app.manage(db::DbPath(db_path.to_string_lossy().to_string()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_text_file,
            read_text_file,
            read_binary_file,
            save_binary_file,
            db::db_put_dataset,
            db::db_insert_dataset,
            db::db_get_dataset,
            db::db_list_datasets,
            db::db_delete_dataset,
            db::db_clear_all_datasets,
            db::db_get_clear_status,
            db::db_stats,
            db::db_read_snapshot,
            db::db_begin_project_import,
            db::db_commit_project_import,
            db::db_rollback_project_import,
            db::db_pending_project_import
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("create temp dir");
        let path = dir.path().join(name);
        (dir, path)
    }

    #[test]
    fn save_then_read_roundtrip() {
        let (_dir, path) = temp_path("报表.txt");
        let path = path.to_string_lossy().to_string();
        let contents = "质量分析报告\nCpk 1.36".to_string();
        save_text_file(path.clone(), contents.clone()).expect("save failed");
        assert_eq!(read_text_file(path).expect("read failed"), contents);
    }

    #[test]
    fn text_import_limits_distinguish_data_and_project_files() {
        assert_eq!(
            text_import_limit(Path::new("measurements.CSV")),
            (
                MAX_TEXT_DATA_IMPORT_BYTES,
                "CSV/TXT 文件超过 20 MB 导入上限"
            )
        );
        assert_eq!(
            text_import_limit(Path::new("backup.QPROJ")),
            (MAX_QPROJ_IMPORT_BYTES, "项目文件超过 64 MB 导入上限")
        );
    }

    #[test]
    fn text_import_rejects_oversize_files_before_reading() {
        let (_csv_dir, csv_path) = temp_path("too-large.csv");
        fs::File::create(&csv_path)
            .unwrap()
            .set_len(MAX_TEXT_DATA_IMPORT_BYTES + 1)
            .unwrap();
        assert_eq!(
            read_text_file(csv_path.to_string_lossy().to_string()).unwrap_err(),
            "CSV/TXT 文件超过 20 MB 导入上限"
        );

        let (_project_dir, project_path) = temp_path("too-large.qproj");
        fs::File::create(&project_path)
            .unwrap()
            .set_len(MAX_QPROJ_IMPORT_BYTES + 1)
            .unwrap();
        assert_eq!(
            read_text_file(project_path.to_string_lossy().to_string()).unwrap_err(),
            "项目文件超过 64 MB 导入上限"
        );
    }

    #[test]
    fn atomic_save_replaces_existing_file_without_temp_residue() {
        let (dir, path) = temp_path("report.txt");
        fs::write(&path, b"old complete report").unwrap();

        save_text_file(path.to_string_lossy().to_string(), "new report".into()).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new report");
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("report.txt")]);
    }

    #[test]
    fn binary_save_then_read_roundtrip() {
        use base64::Engine;
        let (_dir, path) = temp_path("数据.xlsx");
        let bytes = b"PK\x03\x04\0binary workbook";
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);

        save_binary_file(path.to_string_lossy().to_string(), encoded).unwrap();

        let read_back = read_binary_file(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(read_back)
                .unwrap(),
            bytes
        );
    }

    #[test]
    fn binary_import_rejects_files_over_twenty_megabytes() {
        let (_dir, path) = temp_path("too-large.xlsx");
        fs::write(&path, vec![0_u8; MAX_XLSX_IMPORT_BYTES as usize + 1]).unwrap();

        assert_eq!(
            read_binary_file(path.to_string_lossy().to_string()).unwrap_err(),
            "Excel 文件超过 20 MB 导入上限"
        );
    }

    #[test]
    fn malformed_binary_input_does_not_damage_existing_export() {
        let (_dir, path) = temp_path("existing.xlsx");
        fs::write(&path, b"previous valid workbook").unwrap();

        assert!(
            save_binary_file(path.to_string_lossy().to_string(), "not base64 %".into()).is_err()
        );

        assert_eq!(fs::read(&path).unwrap(), b"previous valid workbook");
    }

    #[test]
    fn failed_rename_cleans_incomplete_sibling() {
        let (dir, path) = temp_path("destination.txt");
        fs::create_dir(&path).unwrap();

        assert!(save_text_file(path.to_string_lossy().to_string(), "data".into()).is_err());

        assert!(path.is_dir());
        let entries: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("destination.txt")]);
    }

    #[test]
    fn read_missing_file_errors() {
        assert!(read_text_file("/nonexistent/没有这个文件.csv".into()).is_err());
    }
    #[test]
    fn read_gbk_file_falls_back_to_gb18030() {
        // 第三轮审计:编码回退零测试覆盖——「中文,1」的 GBK 字节
        let (_dir, path) = temp_path("gbk.csv");
        fs::write(&path, [0xD6u8, 0xD0, 0xCE, 0xC4, 0x2C, 0x31]).unwrap();
        assert_eq!(
            read_text_file(path.to_string_lossy().to_string()).unwrap(),
            "中文,1"
        );
    }

    #[test]
    fn read_utf8_bom_is_authoritative() {
        // BOM 文件按 UTF-8 解;不落 GB18030 回退(与 Web 端 decodeTextFileBytes 同口径)
        let (_dir, path) = temp_path("bom.csv");
        let mut bytes = vec![0xEFu8, 0xBB, 0xBF];
        bytes.extend_from_slice("直径,25.1".as_bytes());
        fs::write(&path, bytes).unwrap();
        assert_eq!(
            read_text_file(path.to_string_lossy().to_string()).unwrap(),
            "直径,25.1"
        );
    }

    #[test]
    fn read_utf8_bom_rejects_invalid_utf8_without_replacement_or_gb18030_fallback() {
        let (_dir, path) = temp_path("bom-invalid.csv");
        fs::write(&path, [0xEFu8, 0xBB, 0xBF, 0xFF, 0x0A, 0x31, 0x0A, 0x32]).unwrap();

        assert_eq!(
            read_text_file(path.to_string_lossy().to_string()).unwrap_err(),
            "文件带 UTF-8 BOM，但内容包含非法 UTF-8 字节，已拒绝导入"
        );
    }
}
