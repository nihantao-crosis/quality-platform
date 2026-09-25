/// 本机数据集库 — SQLite 归档,突破前端 localStorage ~5MB 限制。
/// 纯逻辑与 Tauri 命令分离:helpers 用 &Connection 便于内存库单测。
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Mutex;

/// 与前端 MAX_VAULT_DATASETS 保持一致；Rust 命令边界仍独立强制，不能信任 WebView。
const MAX_VAULT_DATASETS: usize = 1_000;

pub struct Db(pub Mutex<Connection>);

#[derive(Debug, Serialize)]
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetImportEntry {
    pub name: String,
    pub json: String,
    pub saved_at: String,
}

#[derive(Debug, Serialize)]
pub struct DatasetSnapshotEntry {
    pub name: String,
    pub json: String,
    pub saved_at: String,
    pub bytes: i64,
}

#[derive(Debug, Serialize)]
pub struct DatasetSnapshot {
    pub revision: i64,
    pub datasets: Vec<DatasetSnapshotEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatasetClearReceipt {
    pub op_id: String,
    pub committed: bool,
    pub removed: i64,
}

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS datasets (
            name     TEXT PRIMARY KEY,
            json     TEXT NOT NULL,
            saved_at TEXT NOT NULL,
            bytes    INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS dataset_meta (
            id       INTEGER PRIMARY KEY CHECK(id = 1),
            revision INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO dataset_meta(id, revision) VALUES(1, 0);
        CREATE TABLE IF NOT EXISTS pending_project_import (
            id          INTEGER PRIMARY KEY CHECK(id = 1),
            stores_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pending_project_import_backup (
            name     TEXT PRIMARY KEY,
            json     TEXT NOT NULL,
            saved_at TEXT NOT NULL,
            bytes    INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS dataset_clear_receipt (
            id      INTEGER PRIMARY KEY CHECK(id = 1),
            op_id   TEXT NOT NULL,
            removed INTEGER NOT NULL CHECK(removed >= 0)
        );",
    )
}

fn bump_revision(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE dataset_meta SET revision = revision + 1 WHERE id = 1",
        [],
    )?;
    Ok(())
}

fn ensure_no_pending_project_import(conn: &Connection) -> rusqlite::Result<()> {
    let pending: i64 =
        conn.query_row("SELECT COUNT(*) FROM pending_project_import", [], |row| {
            row.get(0)
        })?;
    if pending != 0 {
        return Err(rusqlite::Error::InvalidParameterName(
            "项目导入恢复尚未完成，暂不能修改本机数据集库".to_string(),
        ));
    }
    Ok(())
}

pub fn put_dataset(
    conn: &Connection,
    name: &str,
    json: &str,
    saved_at: &str,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    // pending 期间 datasets 是“待提交的新快照”，backup 是唯一旧快照。
    // 普通自动归档不得插入其中，否则 commit/rollback 都无法再代表一个项目边界。
    ensure_no_pending_project_import(&tx)?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM datasets WHERE name = ?1)",
        [name],
        |row| row.get(0),
    )?;
    if !exists {
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM datasets", [], |row| row.get(0))?;
        if count >= MAX_VAULT_DATASETS as i64 {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "本机数据集库已达到 {MAX_VAULT_DATASETS} 条上限，不能新增数据集"
            )));
        }
    }
    tx.execute(
        "INSERT INTO datasets(name, json, saved_at, bytes) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(name) DO UPDATE SET json=?2, saved_at=?3, bytes=?4",
        rusqlite::params![name, json, saved_at, json.len() as i64],
    )?;
    bump_revision(&tx)?;
    tx.commit()
}

pub fn get_dataset(conn: &Connection, name: &str) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT json FROM datasets WHERE name = ?1")?;
    let mut rows = stmt.query([name])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

/// 自动副本只能创建新记录：碰撞不更新任何内容，数量检查与 INSERT 在同一事务。
/// 名称列表只展示最近 1000 条，不能用它判断历史库中名称是否可用。
pub fn insert_dataset(
    conn: &Connection,
    name: &str,
    json: &str,
    saved_at: &str,
) -> rusqlite::Result<bool> {
    let tx = conn.unchecked_transaction()?;
    ensure_no_pending_project_import(&tx)?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM datasets WHERE name = ?1)",
        [name],
        |row| row.get(0),
    )?;
    if exists {
        return Ok(false);
    }
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM datasets", [], |row| row.get(0))?;
    if count >= MAX_VAULT_DATASETS as i64 {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "本机数据集库已达到 {MAX_VAULT_DATASETS} 条上限，不能新增副本"
        )));
    }
    // 不使用 upsert；即使未来接入第二个连接，也不能因检查后竞争覆盖已有行。
    tx.execute(
        "INSERT INTO datasets(name, json, saved_at, bytes) VALUES(?1, ?2, ?3, ?4)",
        rusqlite::params![name, json, saved_at, json.len() as i64],
    )?;
    bump_revision(&tx)?;
    tx.commit()?;
    Ok(true)
}

pub fn list_datasets(conn: &Connection) -> rusqlite::Result<Vec<DatasetMeta>> {
    // 历史版本可能已留下超过现行上限的库。列表必须有界返回，让用户仍能
    // 逐项删除降容；不能在读取任何元数据前因 count > cap 把恢复入口全部锁死。
    let mut stmt = conn.prepare(
        "SELECT name, saved_at, bytes FROM datasets
         ORDER BY saved_at DESC, name ASC LIMIT ?1",
    )?;
    let rows = stmt.query_map([MAX_VAULT_DATASETS as i64], |r| {
        Ok(DatasetMeta {
            name: r.get(0)?,
            saved_at: r.get(1)?,
            bytes: r.get(2)?,
        })
    })?;
    rows.collect()
}

fn validate_clear_op_id(op_id: &str) -> rusqlite::Result<()> {
    if op_id.is_empty() || op_id.len() > 128 || !op_id.is_ascii() {
        return Err(rusqlite::Error::InvalidParameterName(
            "清库操作 ID 必须为 1–128 个 ASCII 字符".to_string(),
        ));
    }
    Ok(())
}

pub fn clear_operation_status(
    conn: &Connection,
    op_id: &str,
) -> rusqlite::Result<Option<DatasetClearReceipt>> {
    validate_clear_op_id(op_id)?;
    conn.query_row(
        "SELECT op_id, removed FROM dataset_clear_receipt WHERE id = 1 AND op_id = ?1",
        [op_id],
        |row| {
            Ok(DatasetClearReceipt {
                op_id: row.get(0)?,
                committed: true,
                removed: row.get(1)?,
            })
        },
    )
    .optional()
}

/// 原子清空整个 vault。DELETE、revision 与持久回执在同一事务提交。
/// IPC 回复丢失后以同 op_id 重试仅返回原回执，不会再次删除。
pub fn clear_all_datasets(conn: &Connection, op_id: &str) -> rusqlite::Result<DatasetClearReceipt> {
    validate_clear_op_id(op_id)?;
    let tx = conn.unchecked_transaction()?;
    ensure_no_pending_project_import(&tx)?;
    let existing = tx
        .query_row(
            "SELECT op_id, removed FROM dataset_clear_receipt WHERE id = 1 AND op_id = ?1",
            [op_id],
            |row| {
                Ok(DatasetClearReceipt {
                    op_id: row.get(0)?,
                    committed: true,
                    removed: row.get(1)?,
                })
            },
        )
        .optional()?;
    if let Some(receipt) = existing {
        return Ok(receipt);
    }
    let removed = tx.execute("DELETE FROM datasets", [])?;
    if removed > 0 {
        bump_revision(&tx)?;
    }
    tx.execute(
        "INSERT INTO dataset_clear_receipt(id, op_id, removed) VALUES(1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET op_id = ?1, removed = ?2",
        rusqlite::params![op_id, removed as i64],
    )?;
    tx.commit()?;
    Ok(DatasetClearReceipt {
        op_id: op_id.to_string(),
        committed: true,
        removed: removed as i64,
    })
}

pub fn delete_dataset(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    let tx = conn.unchecked_transaction()?;
    ensure_no_pending_project_import(&tx)?;
    let removed = tx.execute("DELETE FROM datasets WHERE name = ?1", [name])? > 0;
    if removed {
        bump_revision(&tx)?;
    }
    tx.commit()?;
    Ok(removed)
}

/// 项目导出读取的是一个 SQLite 只读事务快照，不再 list 后逐条 get。
/// 因而即使另一个命令随后写库，revision、名称集、JSON 仍来自同一时点。
pub fn read_snapshot(
    conn: &Connection,
    exclude_names: &[String],
    force_include_name: Option<&str>,
    max_json_bytes: u64,
) -> rusqlite::Result<DatasetSnapshot> {
    let tx = conn.unchecked_transaction()?;
    let dataset_count: i64 = tx.query_row("SELECT COUNT(*) FROM datasets", [], |row| row.get(0))?;
    if dataset_count > MAX_VAULT_DATASETS as i64 {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "本机数据集库数量 {dataset_count} 超过 {MAX_VAULT_DATASETS} 条上限，项目未导出"
        )));
    }
    let revision = tx.query_row(
        "SELECT revision FROM dataset_meta WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    // 第一阶段只读 metadata 与 SQLite 内部的 BLOB 长度，不把可能很大的 json TEXT
    // 搬进 Rust；预算超限在 Rust/WebView 分配载荷之前 fail closed。
    let excluded: HashSet<&str> = exclude_names.iter().map(String::as_str).collect();
    let metadata = {
        let mut stmt = tx.prepare(
            "SELECT name, saved_at, bytes, length(CAST(json AS BLOB))
             FROM datasets ORDER BY name ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let selected: Vec<(String, String, i64, i64)> = metadata
        .into_iter()
        .filter(|(name, _, _, _)| {
            force_include_name == Some(name.as_str()) || !excluded.contains(name.as_str())
        })
        .collect();
    let mut total_json_bytes = 0_u64;
    for (_, _, bytes, actual_bytes) in &selected {
        if *bytes < 0 || *actual_bytes < 0 {
            return Err(rusqlite::Error::InvalidParameterName(
                "数据集库含负数字节元数据，项目未导出".to_string(),
            ));
        }
        total_json_bytes = total_json_bytes.checked_add(*bytes as u64).ok_or_else(|| {
            rusqlite::Error::InvalidParameterName("数据集库字节总量溢出，项目未导出".to_string())
        })?;
        if total_json_bytes > max_json_bytes {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "本机数据集库快照至少需要 {total_json_bytes} 字节，超过项目剩余预算 {max_json_bytes} 字节"
            )));
        }
    }
    // 元数据预算是快速下界。随后仍只让 SQLite 计算外层 QPROJ JSON 字符串的
    // 精确转义长度：引号、反斜杠和控制字符会扩张；中文 UTF-8 不会被机械转成 \uXXXX。
    // 固定余量覆盖 vault/vaultRevision 属性、缩进、逗号与换行。
    const VAULT_JSON_FIXED_OVERHEAD: u64 = 128;
    const VAULT_ENTRY_LAYOUT_OVERHEAD: u64 = 8;
    let mut encoded_vault_bytes = VAULT_JSON_FIXED_OVERHEAD;
    for (name, _, stored_bytes, actual_bytes) in &selected {
        if stored_bytes != actual_bytes {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "数据集「{name}」字节元数据与实际内容不一致，项目未导出"
            )));
        }
        let (encoded_name_bytes, encoded_json_bytes): (i64, i64) = tx.query_row(
            "SELECT length(CAST(json_quote(?1) AS BLOB)),
                    length(CAST(json_quote(json) AS BLOB))
             FROM datasets WHERE name = ?1",
            [name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if encoded_name_bytes < 0 || encoded_json_bytes < 0 {
            return Err(rusqlite::Error::InvalidParameterName(
                "数据集库 JSON 编码长度无效，项目未导出".to_string(),
            ));
        }
        encoded_vault_bytes = encoded_vault_bytes
            .checked_add(encoded_name_bytes as u64)
            .and_then(|n| n.checked_add(encoded_json_bytes as u64))
            .and_then(|n| n.checked_add(VAULT_ENTRY_LAYOUT_OVERHEAD))
            .ok_or_else(|| {
                rusqlite::Error::InvalidParameterName(
                    "数据集库 JSON 编码总量溢出，项目未导出".to_string(),
                )
            })?;
        if encoded_vault_bytes > max_json_bytes {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "本机数据集库写入项目后至少需要 {encoded_vault_bytes} 字节，超过项目剩余预算 {max_json_bytes} 字节"
            )));
        }
    }
    if encoded_vault_bytes > max_json_bytes {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "本机数据集库写入项目后至少需要 {encoded_vault_bytes} 字节，超过项目剩余预算 {max_json_bytes} 字节"
        )));
    }
    let datasets = {
        let mut stmt = tx.prepare("SELECT json FROM datasets WHERE name = ?1")?;
        let mut result = Vec::with_capacity(selected.len());
        for (name, saved_at, bytes, _) in selected {
            let json = stmt.query_row([&name], |row| row.get::<_, String>(0))?;
            result.push(DatasetSnapshotEntry {
                name,
                json,
                saved_at,
                bytes,
            });
        }
        result
    };
    tx.commit()?;
    Ok(DatasetSnapshot { revision, datasets })
}

/// 精确替换 vault 与 pending journal 在同一事务里提交。
/// 旧 vault 留在 SQLite backup 表，JS 无需把整个数据库复制进 WebView 才能回滚。
pub fn begin_project_import(
    conn: &Connection,
    entries: &[DatasetImportEntry],
    pending_stores_json: &str,
) -> rusqlite::Result<()> {
    if entries.len() > MAX_VAULT_DATASETS {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "项目 vault 数据集数量 {} 超过 {MAX_VAULT_DATASETS} 条上限",
            entries.len()
        )));
    }
    let tx = conn.unchecked_transaction()?;
    let pending: i64 = tx.query_row("SELECT COUNT(*) FROM pending_project_import", [], |row| {
        row.get(0)
    })?;
    if pending != 0 {
        return Err(rusqlite::Error::InvalidParameterName(
            "已有未完成的项目导入，请先恢复或回滚".to_string(),
        ));
    }
    tx.execute("DELETE FROM pending_project_import_backup", [])?;
    tx.execute(
        "INSERT INTO pending_project_import_backup(name, json, saved_at, bytes)
         SELECT name, json, saved_at, bytes FROM datasets",
        [],
    )?;
    tx.execute(
        "INSERT INTO pending_project_import(id, stores_json) VALUES(1, ?1)",
        [pending_stores_json],
    )?;
    tx.execute("DELETE FROM datasets", [])?;
    for entry in entries {
        tx.execute(
            "INSERT INTO datasets(name, json, saved_at, bytes) VALUES(?1, ?2, ?3, ?4)",
            rusqlite::params![
                entry.name,
                entry.json,
                entry.saved_at,
                entry.json.len() as i64
            ],
        )?;
    }
    bump_revision(&tx)?;
    tx.commit()
}

pub fn commit_project_import(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM pending_project_import_backup", [])?;
    tx.execute("DELETE FROM pending_project_import", [])?;
    tx.commit()
}

pub fn rollback_project_import(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let pending: i64 = tx.query_row("SELECT COUNT(*) FROM pending_project_import", [], |row| {
        row.get(0)
    })?;
    if pending == 0 {
        return Ok(());
    }
    tx.execute("DELETE FROM datasets", [])?;
    tx.execute(
        "INSERT INTO datasets(name, json, saved_at, bytes)
         SELECT name, json, saved_at, bytes FROM pending_project_import_backup",
        [],
    )?;
    bump_revision(&tx)?;
    tx.execute("DELETE FROM pending_project_import_backup", [])?;
    tx.execute("DELETE FROM pending_project_import", [])?;
    tx.commit()
}

pub fn pending_project_import(conn: &Connection) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT stores_json FROM pending_project_import WHERE id = 1")?;
    let mut rows = stmt.query([])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
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
pub fn db_insert_dataset(
    db: tauri::State<Db>,
    name: String,
    json: String,
    saved_at: String,
) -> Result<bool, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    insert_dataset(&conn, &name, &json, &saved_at).map_err(|e| e.to_string())
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
pub fn db_clear_all_datasets(
    db: tauri::State<Db>,
    op_id: String,
) -> Result<DatasetClearReceipt, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    clear_all_datasets(&conn, &op_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_get_clear_status(
    db: tauri::State<Db>,
    op_id: String,
) -> Result<Option<DatasetClearReceipt>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    clear_operation_status(&conn, &op_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_stats(db: tauri::State<Db>, path: tauri::State<DbPath>) -> Result<DbStats, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    stats(&conn, &path.0).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_read_snapshot(
    db: tauri::State<Db>,
    exclude_names: Vec<String>,
    force_include_name: Option<String>,
    max_json_bytes: u64,
) -> Result<DatasetSnapshot, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_snapshot(
        &conn,
        &exclude_names,
        force_include_name.as_deref(),
        max_json_bytes,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_begin_project_import(
    db: tauri::State<Db>,
    entries: Vec<DatasetImportEntry>,
    pending_stores_json: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    begin_project_import(&conn, &entries, &pending_stores_json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_commit_project_import(db: tauri::State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    commit_project_import(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_rollback_project_import(db: tauri::State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    rollback_project_import(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_pending_project_import(db: tauri::State<Db>) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    pending_project_import(&conn).map_err(|e| e.to_string())
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
    fn copy_insert_collision_preserves_payload_metadata_and_revision() {
        let c = mem();
        assert!(insert_dataset(&c, "Legacy (副本)", "original", "old").unwrap());
        assert!(!insert_dataset(&c, "Legacy (副本)", "replacement", "new").unwrap());
        assert_eq!(
            get_dataset(&c, "Legacy (副本)").unwrap().as_deref(),
            Some("original")
        );
        let rows = list_datasets(&c).unwrap();
        assert_eq!(rows[0].saved_at, "old");
        assert_eq!(rows[0].bytes, 8);
        let revision: i64 = c
            .query_row(
                "SELECT revision FROM dataset_meta WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision, 1);
        // 只有显式普通保存仍允许更新已有副本。
        put_dataset(&c, "Legacy (副本)", "edited", "new").unwrap();
        assert_eq!(
            get_dataset(&c, "Legacy (副本)").unwrap().as_deref(),
            Some("edited")
        );
    }

    #[test]
    fn copy_insert_never_overwrites_hidden_legacy_row_and_enforces_capacity() {
        let c = mem();
        assert!(insert_dataset(&c, "Legacy (副本)", "original", "old").unwrap());
        let tx = c.unchecked_transaction().unwrap();
        for i in 0..MAX_VAULT_DATASETS {
            tx.execute(
                "INSERT INTO datasets(name, json, saved_at, bytes) VALUES(?1, 'x', 'recent', 1)",
                [format!("new-{i}")],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        let visible = list_datasets(&c).unwrap();
        assert_eq!(visible.len(), MAX_VAULT_DATASETS);
        assert!(visible.iter().all(|entry| entry.name != "Legacy (副本)"));
        assert!(!insert_dataset(&c, "Legacy (副本)", "replacement", "today").unwrap());
        assert!(insert_dataset(&c, "Legacy (副本2)", "replacement", "today").is_err());
        assert_eq!(
            get_dataset(&c, "Legacy (副本)").unwrap().as_deref(),
            Some("original")
        );
        assert_eq!(
            stats(&c, ":memory:").unwrap().count,
            (MAX_VAULT_DATASETS + 1) as i64
        );
    }

    #[test]
    fn copy_insert_is_blocked_by_project_import_journal_and_rolls_back_on_error() {
        let c = mem();
        begin_project_import(&c, &[], "{}").unwrap();
        assert!(insert_dataset(&c, "copy", "payload", "today").is_err());
        rollback_project_import(&c).unwrap();
        c.execute_batch(
            "CREATE TRIGGER fail_copy_revision BEFORE UPDATE ON dataset_meta
             BEGIN SELECT RAISE(ABORT, 'simulated revision failure'); END;",
        )
        .unwrap();
        assert!(insert_dataset(&c, "copy", "payload", "today").is_err());
        assert_eq!(get_dataset(&c, "copy").unwrap(), None);
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
    fn snapshot_revision_and_rows_are_from_one_transaction() {
        let c = mem();
        let empty = read_snapshot(&c, &[], None, u64::MAX).unwrap();
        assert_eq!(empty.revision, 0);
        assert!(empty.datasets.is_empty());
        put_dataset(&c, "a", "v1", "t1").unwrap();
        put_dataset(&c, "b", "v2", "t2").unwrap();
        let snap = read_snapshot(&c, &[], None, u64::MAX).unwrap();
        assert_eq!(snap.revision, 2);
        assert_eq!(snap.datasets.len(), 2);
        assert_eq!(snap.datasets[0].name, "a");
        assert_eq!(snap.datasets[0].json, "v1");
    }

    #[test]
    fn snapshot_applies_exclusions_but_force_includes_active_name() {
        let c = mem();
        put_dataset(&c, "recent", "r", "t1").unwrap();
        put_dataset(&c, "active", "a", "t2").unwrap();
        put_dataset(&c, "vault-only", "v", "t3").unwrap();
        let excluded = vec!["recent".to_string(), "active".to_string()];
        let snap = read_snapshot(&c, &excluded, Some("active"), 512).unwrap();
        let names: Vec<&str> = snap
            .datasets
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec!["active", "vault-only"]);
    }

    #[test]
    fn snapshot_budget_rejects_before_reading_json_column() {
        let c = mem();
        // SQLite 动态类型允许在 TEXT 列放 BLOB。若实现提前 row.get::<String>(json)，
        // 这里会报 InvalidColumnType；正确实现先按 metadata bytes 拒绝预算。
        c.execute(
            "INSERT INTO datasets(name, json, saved_at, bytes) VALUES(?1, ?2, ?3, ?4)",
            rusqlite::params!["huge", vec![0xff_u8, 0xfe], "t", 100_i64],
        )
        .unwrap();
        let error = read_snapshot(&c, &[], None, 10).unwrap_err().to_string();
        assert!(
            error.contains("超过项目剩余预算"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn snapshot_budget_counts_outer_json_escaping_before_fetching_text() {
        let c = mem();
        // 48.85 MiB 原始 TEXT 低于 64 MiB，但双引号和反斜杠进入外层 QPROJ
        // 字符串都要变成两字节。必须在 SELECT json/IPC 之前按约 97.7 MiB 拒绝。
        let raw_count = (48.85_f64 * 1024.0 * 1024.0) as usize;
        let quote_and_slash = "\"\\".repeat(raw_count / 2);
        put_dataset(&c, "escape-heavy", &quote_and_slash, "t").unwrap();
        let error = read_snapshot(&c, &[], None, 64 * 1024 * 1024)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("写入项目后") && error.contains("超过项目剩余预算"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn snapshot_budget_does_not_expand_normal_chinese_as_unicode_escapes() {
        let c = mem();
        let chinese = format!(r#"{{"说明":"{}"}}"#, "测".repeat(1024));
        let raw_bytes = chinese.len() as u64;
        put_dataset(&c, "中文数据", &chinese, "t").unwrap();
        let snap = read_snapshot(&c, &[], None, raw_bytes + 512).unwrap();
        assert_eq!(snap.datasets[0].json, chinese);
    }

    #[test]
    fn ordinary_crud_is_blocked_while_project_import_journal_exists() {
        let c = mem();
        put_dataset(&c, "old", "o", "t1").unwrap();
        begin_project_import(
            &c,
            &[DatasetImportEntry {
                name: "new".into(),
                json: "n".into(),
                saved_at: "t2".into(),
            }],
            "{}",
        )
        .unwrap();

        let put_error = put_dataset(&c, "intruder", "x", "t3")
            .unwrap_err()
            .to_string();
        let delete_error = delete_dataset(&c, "new").unwrap_err().to_string();
        let clear_error = clear_all_datasets(&c, "clear-during-import")
            .unwrap_err()
            .to_string();
        assert!(put_error.contains("项目导入恢复尚未完成"));
        assert!(delete_error.contains("项目导入恢复尚未完成"));
        assert!(clear_error.contains("项目导入恢复尚未完成"));
        assert!(clear_operation_status(&c, "clear-during-import")
            .unwrap()
            .is_none());
        assert_eq!(get_dataset(&c, "new").unwrap().as_deref(), Some("n"));
        assert!(get_dataset(&c, "intruder").unwrap().is_none());

        rollback_project_import(&c).unwrap();
        put_dataset(&c, "after", "a", "t4").unwrap();
        assert!(delete_dataset(&c, "old").unwrap());
        assert_eq!(get_dataset(&c, "after").unwrap().as_deref(), Some("a"));
    }

    #[test]
    fn project_import_rollback_restores_old_snapshot_without_js_copy() {
        let c = mem();
        put_dataset(&c, "old-a", "a", "t1").unwrap();
        put_dataset(&c, "old-b", "b", "t2").unwrap();
        begin_project_import(
            &c,
            &[DatasetImportEntry {
                name: "new".into(),
                json: "n".into(),
                saved_at: "t3".into(),
            }],
            r#"{"qp-specs-v1":"{}"}"#,
        )
        .unwrap();
        assert_eq!(
            pending_project_import(&c).unwrap().as_deref(),
            Some(r#"{"qp-specs-v1":"{}"}"#)
        );
        assert!(get_dataset(&c, "old-a").unwrap().is_none());
        assert_eq!(get_dataset(&c, "new").unwrap().as_deref(), Some("n"));

        rollback_project_import(&c).unwrap();
        assert!(pending_project_import(&c).unwrap().is_none());
        assert_eq!(get_dataset(&c, "old-a").unwrap().as_deref(), Some("a"));
        assert_eq!(get_dataset(&c, "old-b").unwrap().as_deref(), Some("b"));
        assert!(get_dataset(&c, "new").unwrap().is_none());
    }

    #[test]
    fn project_import_commit_keeps_exact_new_name_set() {
        let c = mem();
        put_dataset(&c, "old", "o", "t").unwrap();
        begin_project_import(
            &c,
            &[DatasetImportEntry {
                name: "new".into(),
                json: "n".into(),
                saved_at: "t2".into(),
            }],
            "{}",
        )
        .unwrap();
        commit_project_import(&c).unwrap();
        assert!(pending_project_import(&c).unwrap().is_none());
        assert!(get_dataset(&c, "old").unwrap().is_none());
        assert_eq!(get_dataset(&c, "new").unwrap().as_deref(), Some("n"));
        // journal 已清，rollback 是幂等 no-op，不能误删已提交项目。
        rollback_project_import(&c).unwrap();
        assert_eq!(get_dataset(&c, "new").unwrap().as_deref(), Some("n"));
    }

    #[test]
    fn project_import_commit_status_is_durable_and_idempotent_for_ipc_recheck() {
        let c = mem();
        put_dataset(&c, "old", "o", "t1").unwrap();
        begin_project_import(
            &c,
            &[DatasetImportEntry {
                name: "new".into(),
                json: "n".into(),
                saved_at: "t2".into(),
            }],
            r#"{"version":1,"target":{},"previous":{}}"#,
        )
        .unwrap();
        commit_project_import(&c).unwrap();
        // JS 在 commit IPC reject 后以 pending=null 作为已提交的耐久事实。
        assert!(pending_project_import(&c).unwrap().is_none());
        let backup_rows: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM pending_project_import_backup",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(backup_rows, 0);
        assert_eq!(get_dataset(&c, "new").unwrap().as_deref(), Some("n"));
        assert!(get_dataset(&c, "old").unwrap().is_none());

        // 回复丢失时前端可能重试 commit；不得破坏已提交快照。
        commit_project_import(&c).unwrap();
        assert!(pending_project_import(&c).unwrap().is_none());
        assert_eq!(get_dataset(&c, "new").unwrap().as_deref(), Some("n"));
    }

    #[test]
    fn failed_exact_replace_rolls_back_transaction_and_leaves_no_journal() {
        let c = mem();
        put_dataset(&c, "old", "o", "t").unwrap();
        let duplicate = vec![
            DatasetImportEntry {
                name: "dup".into(),
                json: "1".into(),
                saved_at: "t".into(),
            },
            DatasetImportEntry {
                name: "dup".into(),
                json: "2".into(),
                saved_at: "t".into(),
            },
        ];
        assert!(begin_project_import(&c, &duplicate, "{}").is_err());
        assert!(pending_project_import(&c).unwrap().is_none());
        assert_eq!(get_dataset(&c, "old").unwrap().as_deref(), Some("o"));
        assert!(get_dataset(&c, "dup").unwrap().is_none());
    }

    #[test]
    fn new_put_is_rejected_at_vault_cap_but_existing_name_can_update() {
        let c = mem();
        let tx = c.unchecked_transaction().unwrap();
        for index in 0..MAX_VAULT_DATASETS {
            tx.execute(
                "INSERT INTO datasets(name, json, saved_at, bytes) VALUES(?1, 'v', 't', 1)",
                [format!("d{index}")],
            )
            .unwrap();
        }
        tx.commit().unwrap();

        put_dataset(&c, "d0", "updated", "t2").unwrap();
        let error = put_dataset(&c, "overflow", "v", "t")
            .unwrap_err()
            .to_string();
        assert!(error.contains("1000") && error.contains("不能新增"));
        assert_eq!(get_dataset(&c, "d0").unwrap().as_deref(), Some("updated"));
        assert!(get_dataset(&c, "overflow").unwrap().is_none());
        assert_eq!(list_datasets(&c).unwrap().len(), MAX_VAULT_DATASETS);
    }

    #[test]
    fn project_import_cap_plus_one_is_rejected_atomically() {
        let c = mem();
        put_dataset(&c, "old", "old-json", "t0").unwrap();
        let entries: Vec<DatasetImportEntry> = (0..=MAX_VAULT_DATASETS)
            .map(|index| DatasetImportEntry {
                name: format!("d{index}"),
                json: "v".into(),
                saved_at: "t".into(),
            })
            .collect();

        let error = begin_project_import(&c, &entries, "{}")
            .unwrap_err()
            .to_string();
        assert!(error.contains("1001") && error.contains("1000"));
        assert_eq!(get_dataset(&c, "old").unwrap().as_deref(), Some("old-json"));
        assert!(get_dataset(&c, "d0").unwrap().is_none());
        assert!(pending_project_import(&c).unwrap().is_none());
    }

    #[test]
    fn legacy_over_cap_snapshot_fails_but_bounded_list_allows_recovery_delete() {
        let c = mem();
        let tx = c.unchecked_transaction().unwrap();
        for index in 0..=MAX_VAULT_DATASETS {
            tx.execute(
                "INSERT INTO datasets(name, json, saved_at, bytes) VALUES(?1, 'v', 't', 1)",
                [format!("legacy-{index}")],
            )
            .unwrap();
        }
        tx.commit().unwrap();

        let error = read_snapshot(&c, &[], None, u64::MAX)
            .unwrap_err()
            .to_string();
        assert!(error.contains("1001") && error.contains("1000"));
        let bounded = list_datasets(&c).unwrap();
        assert_eq!(bounded.len(), MAX_VAULT_DATASETS);
        assert!(delete_dataset(&c, &bounded[0].name).unwrap());
        assert_eq!(
            stats(&c, ":memory:").unwrap().count,
            MAX_VAULT_DATASETS as i64
        );
    }

    #[test]
    fn atomic_clear_recovers_legacy_over_cap_vault() {
        let c = mem();
        let tx = c.unchecked_transaction().unwrap();
        for index in 0..=MAX_VAULT_DATASETS {
            tx.execute(
                "INSERT INTO datasets(name, json, saved_at, bytes) VALUES(?1, 'v', 't', 1)",
                [format!("legacy-{index}")],
            )
            .unwrap();
        }
        tx.commit().unwrap();

        let receipt = clear_all_datasets(&c, "clear-legacy").unwrap();
        assert_eq!(receipt.removed, (MAX_VAULT_DATASETS + 1) as i64);
        assert_eq!(
            clear_operation_status(&c, "clear-legacy").unwrap(),
            Some(receipt.clone())
        );
        let after = stats(&c, ":memory:").unwrap();
        assert_eq!(after.count, 0);
        assert_eq!(after.total_bytes, 0);
        assert!(list_datasets(&c).unwrap().is_empty());
    }

    #[test]
    fn atomic_clear_rolls_back_every_row_when_delete_fails() {
        let c = mem();
        put_dataset(&c, "a", "1", "t").unwrap();
        put_dataset(&c, "b", "2", "t").unwrap();
        let revision_before: i64 = c
            .query_row(
                "SELECT revision FROM dataset_meta WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        c.execute_batch(
            "CREATE TRIGGER reject_vault_clear BEFORE DELETE ON datasets
             BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END;",
        )
        .unwrap();

        assert!(clear_all_datasets(&c, "clear-failed").is_err());
        assert!(clear_operation_status(&c, "clear-failed")
            .unwrap()
            .is_none());
        assert_eq!(stats(&c, ":memory:").unwrap().count, 2);
        assert_eq!(get_dataset(&c, "a").unwrap().as_deref(), Some("1"));
        assert_eq!(get_dataset(&c, "b").unwrap().as_deref(), Some("2"));
        let revision_after: i64 = c
            .query_row(
                "SELECT revision FROM dataset_meta WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision_after, revision_before);
    }

    #[test]
    fn clear_receipt_makes_lost_reply_retry_idempotent_and_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.db");
        let first_receipt = {
            let c = Connection::open(&path).unwrap();
            init_schema(&c).unwrap();
            put_dataset(&c, "a", "1", "t").unwrap();
            put_dataset(&c, "b", "2", "t").unwrap();
            let receipt = clear_all_datasets(&c, "lost-reply-op").unwrap();
            assert_eq!(receipt.removed, 2);
            // 模拟 commit 后 IPC 回复丢失：同 op 重试必须返回原回执。
            assert_eq!(clear_all_datasets(&c, "lost-reply-op").unwrap(), receipt);
            receipt
        };
        let reopened = Connection::open(&path).unwrap();
        init_schema(&reopened).unwrap();
        assert_eq!(
            clear_operation_status(&reopened, "lost-reply-op").unwrap(),
            Some(first_receipt)
        );
    }

    #[test]
    fn latest_clear_receipt_is_bounded_and_old_operation_becomes_unknown() {
        let c = mem();
        put_dataset(&c, "a", "1", "t").unwrap();
        clear_all_datasets(&c, "old-op").unwrap();
        put_dataset(&c, "b", "2", "t").unwrap();
        let latest = clear_all_datasets(&c, "latest-op").unwrap();
        assert_eq!(latest.removed, 1);
        assert!(clear_operation_status(&c, "old-op").unwrap().is_none());
        assert_eq!(
            clear_operation_status(&c, "latest-op").unwrap(),
            Some(latest)
        );
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
