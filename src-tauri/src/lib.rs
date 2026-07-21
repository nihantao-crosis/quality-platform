use std::fs;
use std::io::{self, Write};
use std::path::Path;

mod db;

const MAX_XLSX_IMPORT_BYTES: u64 = 20 * 1024 * 1024;

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
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 二进制文件读取（.xlsx 导入用，返回 base64）。
#[tauri::command]
fn read_binary_file(path: String) -> Result<String, String> {
    use base64::Engine;
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_XLSX_IMPORT_BYTES {
        return Err("Excel 文件超过 20 MB 导入上限".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    // 防止 metadata 检查后文件被替换或继续写入。
    if bytes.len() as u64 > MAX_XLSX_IMPORT_BYTES {
        return Err("Excel 文件超过 20 MB 导入上限".into());
    }
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
            db::db_get_dataset,
            db::db_list_datasets,
            db::db_delete_dataset,
            db::db_stats
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
