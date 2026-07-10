use std::fs;
use std::path::Path;

mod db;

/// 桌面端文件写入 — 由前端 PlatformAdapter 的导出报表调用。
/// 路径来自原生保存对话框，无需 fs 插件的 scope 白名单。
#[tauri::command]
fn save_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| e.to_string())
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
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 二进制文件写入（.xlsx 导出用，前端传 base64）。
#[tauri::command]
fn save_binary_file(path: String, data_b64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(|e| e.to_string())?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_then_read_roundtrip() {
        let dir = std::env::temp_dir().join("qp-test");
        let path = dir.join("报表.txt").to_string_lossy().to_string();
        let contents = "质量分析报告\nCpk 1.36".to_string();
        save_text_file(path.clone(), contents.clone()).expect("save failed");
        assert_eq!(read_text_file(path).expect("read failed"), contents);
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
