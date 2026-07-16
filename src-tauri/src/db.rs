/// 本机数据集库 — SQLite 归档,突破前端 localStorage ~5MB 限制。
/// 纯逻辑与 Tauri 命令分离:helpers 用 &Connection 便于内存库单测。
use rusqlite::Connection;
use serde::Serialize;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

#[derive(Serialize)]
pub struct DatasetMeta {
    pub name: String,
    pub saved_at: String,
    pub bytes: i64,
}

#[derive(Serialize)]
pub struct DbStats {
    pub count: i64,
    pub total_bytes: i64,
    pub path: String,
}

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS datasets (
            name     TEXT PRIMARY KEY,
            json     TEXT NOT NULL,
            saved_at TEXT NOT NULL,
            bytes    INTEGER NOT NULL
        );",
    )
}

pub fn put_dataset(
    conn: &Connection,
    name: &str,
    json: &str,
    saved_at: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO datasets(name, json, saved_at, bytes) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(name) DO UPDATE SET json=?2, saved_at=?3, bytes=?4",
        rusqlite::params![name, json, saved_at, json.len() as i64],
    )?;
    Ok(())
}

pub fn get_dataset(conn: &Connection, name: &str) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT json FROM datasets WHERE name = ?1")?;
    let mut rows = stmt.query([name])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

pub fn list_datasets(conn: &Connection) -> rusqlite::Result<Vec<DatasetMeta>> {
    let mut stmt =
        conn.prepare("SELECT name, saved_at, bytes FROM datasets ORDER BY saved_at DESC")?;
    let rows = stmt.query_map([], |r| {
        Ok(DatasetMeta {
            name: r.get(0)?,
            saved_at: r.get(1)?,
            bytes: r.get(2)?,
        })
    })?;
    rows.collect()
}

pub fn delete_dataset(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    Ok(conn.execute("DELETE FROM datasets WHERE name = ?1", [name])? > 0)
}

pub fn stats(conn: &Connection, path: &str) -> rusqlite::Result<DbStats> {
    let (count, total_bytes): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM datasets",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(DbStats {
        count,
        total_bytes,
        path: path.to_string(),
    })
}

// ---------- Tauri 命令 ----------

#[tauri::command]
pub fn db_put_dataset(
    db: tauri::State<Db>,
    name: String,
    json: String,
    saved_at: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    put_dataset(&conn, &name, &json, &saved_at).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_get_dataset(db: tauri::State<Db>, name: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    get_dataset(&conn, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_list_datasets(db: tauri::State<Db>) -> Result<Vec<DatasetMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    list_datasets(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_delete_dataset(db: tauri::State<Db>, name: String) -> Result<bool, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    delete_dataset(&conn, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_stats(db: tauri::State<Db>, path: tauri::State<DbPath>) -> Result<DbStats, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    stats(&conn, &path.0).map_err(|e| e.to_string())
}

/// DB 文件路径(展示用)。
pub struct DbPath(pub String);

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init_schema(&c).unwrap();
        c
    }

    #[test]
    fn put_get_roundtrip() {
        let c = mem();
        put_dataset(
            &c,
            "质检数据.mtw",
            r#"{"rows":[[1,2]]}"#,
            "2026-07-11T10:00:00Z",
        )
        .unwrap();
        let got = get_dataset(&c, "质检数据.mtw").unwrap();
        assert_eq!(got.as_deref(), Some(r#"{"rows":[[1,2]]}"#));
    }

    #[test]
    fn get_missing_is_none() {
        let c = mem();
        assert!(get_dataset(&c, "不存在").unwrap().is_none());
    }

    #[test]
    fn upsert_overwrites() {
        let c = mem();
        put_dataset(&c, "a", "v1", "t1").unwrap();
        put_dataset(&c, "a", "v2", "t2").unwrap();
        assert_eq!(get_dataset(&c, "a").unwrap().as_deref(), Some("v2"));
        let list = list_datasets(&c).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].saved_at, "t2");
        assert_eq!(list[0].bytes, 2);
    }

    #[test]
    fn list_orders_by_saved_at_desc() {
        let c = mem();
        put_dataset(&c, "old", "x", "2026-01-01").unwrap();
        put_dataset(&c, "new", "y", "2026-07-01").unwrap();
        let names: Vec<String> = list_datasets(&c)
            .unwrap()
            .into_iter()
            .map(|m| m.name)
            .collect();
        assert_eq!(names, vec!["new", "old"]);
    }

    #[test]
    fn delete_reports_existence() {
        let c = mem();
        put_dataset(&c, "a", "v", "t").unwrap();
        assert!(delete_dataset(&c, "a").unwrap());
        assert!(!delete_dataset(&c, "a").unwrap());
        assert!(get_dataset(&c, "a").unwrap().is_none());
    }

    #[test]
    fn stats_counts_and_sums() {
        let c = mem();
        put_dataset(&c, "a", "12345", "t").unwrap();
        put_dataset(&c, "b", "678", "t").unwrap();
        let s = stats(&c, "/tmp/x.db").unwrap();
        assert_eq!(s.count, 2);
        assert_eq!(s.total_bytes, 8);
    }

    #[test]
    fn large_dataset_beyond_localstorage_quota() {
        // 15 万行 × 5 列 JSON(~6.4MB,超 localStorage ~5MB 配额)应能存取
        let c = mem();
        let row = "[25.0012,24.9987,25.0031,24.9955,25.0108]";
        let big = format!(r#"{{"rows":[{}]}}"#, vec![row; 150_000].join(","));
        assert!(big.len() > 5 * 1024 * 1024);
        put_dataset(&c, "大数据集", &big, "t").unwrap();
        assert_eq!(
            get_dataset(&c, "大数据集").unwrap().unwrap().len(),
            big.len()
        );
    }
}
