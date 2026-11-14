/// 本机数据集库 — SQLite 归档,突破前端 localStorage ~5MB 限制。
/// 纯逻辑与 Tauri 命令分离:helpers 用 &Connection 便于内存库单测。
use rusqlite::{Connection, ErrorCode, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// 与前端 MAX_VAULT_DATASETS 保持一致；Rust 命令边界仍独立强制，不能信任 WebView。
const MAX_VAULT_DATASETS: usize = 1_000;

/// 另一进程持写锁时，写事务在 BEGIN IMMEDIATE 处由 busy handler 最多等待这么久。
pub const DB_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// 本机数据集库句柄。启动时库不可用（被另一实例占用、目录不可写、隔离损坏库失败）
/// 不再让 setup 冒泡成 panic：句柄记下可读原因，所有 db_* 命令如实返回该原因，
/// 前端启动屏障会把它显示为阻断提示，而不是窗口一闪即退。
pub struct Db {
    conn: Mutex<Option<Connection>>,
    unavailable: Option<String>,
}

impl Db {
    pub fn available(conn: Connection) -> Self {
        Db {
            conn: Mutex::new(Some(conn)),
            unavailable: None,
        }
    }

    pub fn unavailable(reason: String) -> Self {
        Db {
            conn: Mutex::new(None),
            unavailable: Some(reason),
        }
    }

    #[cfg(test)]
    pub fn is_available(&self) -> bool {
        self.unavailable.is_none()
    }

    /// 在库连接上执行一个 helper；库不可用时返回启动时记录的中文原因。
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let guard = self.conn.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(conn) => f(conn).map_err(|e| describe_db_error(&e)),
            None => Err(self
                .unavailable
                .clone()
                .unwrap_or_else(|| "本机数据集库不可用".to_string())),
        }
    }
}

fn is_busy_error(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

fn is_corrupt_error(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt)
    )
}

/// 并发写等待超时不得把英文原串「database is locked」直接抛进中文界面。
fn describe_db_error(error: &rusqlite::Error) -> String {
    if is_busy_error(error) {
        format!(
            "本机数据集库正被另一个质量分析平台实例写入，等待 {} 秒后仍未释放；请稍后重试，或关闭其他实例（{error}）",
            DB_BUSY_TIMEOUT.as_secs()
        )
    } else {
        error.to_string()
    }
}

/// 所有写命令都以 BEGIN IMMEDIATE 开始：一开头就申请 RESERVED 锁。
/// DEFERRED 事务先 SELECT 拿 SHARED、写时才升级，SQLite 在升级冲突时不调用
/// busy handler，另一进程持写锁时会 0 ms 失败；IMMEDIATE 则按 busy_timeout 正常等待。
/// 只读事务（read_snapshot）保持 DEFERRED，不与其他读者互斥。
fn write_transaction(conn: &Connection) -> rusqlite::Result<Transaction<'_>> {
    Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
}

/// 连接级配置：显式 busy_timeout（不依赖 rusqlite 的隐式默认值）。
pub fn configure_connection(conn: &Connection, busy_timeout: Duration) -> rusqlite::Result<()> {
    conn.busy_timeout(busy_timeout)
}

/// 启动打开本机数据集库的结果：库句柄 + 需要告知用户的一次性提示。
pub struct DbStartup {
    pub db: Db,
    pub path: String,
    pub notice: Option<String>,
}

fn open_and_init(db_path: &Path, busy_timeout: Duration) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    configure_connection(&conn, busy_timeout)?;
    // open 不读文件头；非 SQLite 内容要到这里的 CREATE/INSERT 才报 NotADatabase。
    init_schema(&conn)?;
    Ok(conn)
}

/// UTC 时间戳 YYYYMMDD-HHMMSS（无外部依赖；civil-from-days 算法）。
fn utc_timestamp(now: std::time::SystemTime) -> String {
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

fn sibling_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// 把损坏库（连同可能的 -journal/-wal/-shm 旁路文件）原子改名保全，返回备份路径。
/// 旁路文件必须一起移走：否则新建空库时 SQLite 会把旧库的热日志回放进新库。
fn quarantine_corrupt_db(db_path: &Path) -> std::io::Result<PathBuf> {
    let stamp = utc_timestamp(std::time::SystemTime::now());
    let mut backup = sibling_with_suffix(db_path, &format!(".corrupt-{stamp}"));
    let mut attempt = 1;
    while backup.exists() {
        backup = sibling_with_suffix(db_path, &format!(".corrupt-{stamp}-{attempt}"));
        attempt += 1;
    }
    std::fs::rename(db_path, &backup)?;
    for side in ["-journal", "-wal", "-shm"] {
        let from = sibling_with_suffix(db_path, side);
        if from.exists() {
            // 旁路文件改名失败时宁可让本次启动进入不可用态，也不静默删除取证材料。
            std::fs::rename(&from, sibling_with_suffix(&backup, side))?;
        }
    }
    Ok(backup)
}

fn unavailable_startup(path: String, reason: String) -> DbStartup {
    DbStartup {
        db: Db::unavailable(reason.clone()),
        path,
        notice: Some(reason),
    }
}

/// 桌面端启动时打开本机数据集库。任何失败都不 panic：
/// - 库文件损坏（非 SQLite / 页损坏）：改名为 datasets.db.corrupt-<UTC时间戳> 保全，以空库继续，
///   并返回含备份完整路径的提示；
/// - 被另一实例占用（busy_timeout 内拿不到锁）：不动库文件，句柄进入不可用态，提示已有实例在运行；
/// - 应用数据目录不可得/不可建、或其他打开错误：句柄进入不可用态并带上路径与原因。
pub fn open_dataset_db(data_dir: Result<PathBuf, String>, busy_timeout: Duration) -> DbStartup {
    let dir = match data_dir {
        Ok(dir) => dir,
        Err(error) => {
            return unavailable_startup(
                String::new(),
                format!("无法定位应用数据目录，本机数据集库不可用：{error}"),
            );
        }
    };
    let db_path = dir.join("datasets.db");
    let path = db_path.to_string_lossy().to_string();
    if let Err(error) = std::fs::create_dir_all(&dir) {
        let reason = format!(
            "无法创建应用数据目录 {}，本机数据集库不可用：{error}",
            dir.to_string_lossy()
        );
        return unavailable_startup(path, reason);
    }
    match open_and_init(&db_path, busy_timeout) {
        Ok(conn) => DbStartup {
            db: Db::available(conn),
            path,
            notice: None,
        },
        Err(error) if is_busy_error(&error) => {
            let reason = format!(
                "已有另一个质量分析平台实例在运行，本机数据集库（{path}）正被它占用。请切换到已打开的窗口，或关闭其他实例后重新启动本程序。"
            );
            unavailable_startup(path, reason)
        }
        Err(error) if is_corrupt_error(&error) => match quarantine_corrupt_db(&db_path) {
            Ok(backup) => {
                let backup_text = backup.to_string_lossy().to_string();
                match open_and_init(&db_path, busy_timeout) {
                    Ok(conn) => DbStartup {
                        db: Db::available(conn),
                        path,
                        notice: Some(format!(
                            "本机数据集库文件已损坏（{error}），无法读取。原文件已原样保全为：{backup_text}\n已新建空的数据集库继续运行；如需找回库中的历史数据集，请把该备份文件交给技术支持。"
                        )),
                    },
                    Err(reopen) => {
                        let reason = format!(
                            "本机数据集库文件已损坏并已保全为 {backup_text}，但新建空库失败（{reopen}），本机数据集库暂不可用。"
                        );
                        unavailable_startup(path, reason)
                    }
                }
            }
            Err(rename_error) => {
                let reason = format!(
                    "本机数据集库文件 {path} 已损坏（{error}），且无法改名保全（{rename_error}），本机数据集库暂不可用。请关闭程序后手动备份并移走该文件。"
                );
                unavailable_startup(path, reason)
            }
        },
        Err(error) => {
            let reason = format!("无法打开本机数据集库 {path}：{error}");
            unavailable_startup(path, reason)
        }
    }
}

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
    let tx = write_transaction(conn)?;
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
    let tx = write_transaction(conn)?;
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
    let tx = write_transaction(conn)?;
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
    let tx = write_transaction(conn)?;
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
    let tx = write_transaction(conn)?;
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
    let tx = write_transaction(conn)?;
    tx.execute("DELETE FROM pending_project_import_backup", [])?;
    tx.execute("DELETE FROM pending_project_import", [])?;
    tx.commit()
}

pub fn rollback_project_import(conn: &Connection) -> rusqlite::Result<()> {
    let tx = write_transaction(conn)?;
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
    db.with(|conn| put_dataset(conn, &name, &json, &saved_at))
}

#[tauri::command]
pub fn db_insert_dataset(
    db: tauri::State<Db>,
    name: String,
    json: String,
    saved_at: String,
) -> Result<bool, String> {
    db.with(|conn| insert_dataset(conn, &name, &json, &saved_at))
}

#[tauri::command]
pub fn db_get_dataset(db: tauri::State<Db>, name: String) -> Result<Option<String>, String> {
    db.with(|conn| get_dataset(conn, &name))
}

#[tauri::command]
pub fn db_list_datasets(db: tauri::State<Db>) -> Result<Vec<DatasetMeta>, String> {
    db.with(list_datasets)
}

#[tauri::command]
pub fn db_delete_dataset(db: tauri::State<Db>, name: String) -> Result<bool, String> {
    db.with(|conn| delete_dataset(conn, &name))
}

#[tauri::command]
pub fn db_clear_all_datasets(
    db: tauri::State<Db>,
    op_id: String,
) -> Result<DatasetClearReceipt, String> {
    db.with(|conn| clear_all_datasets(conn, &op_id))
}

#[tauri::command]
pub fn db_get_clear_status(
    db: tauri::State<Db>,
    op_id: String,
) -> Result<Option<DatasetClearReceipt>, String> {
    db.with(|conn| clear_operation_status(conn, &op_id))
}

#[tauri::command]
pub fn db_stats(db: tauri::State<Db>, path: tauri::State<DbPath>) -> Result<DbStats, String> {
    db.with(|conn| stats(conn, &path.0))
}

#[tauri::command]
pub fn db_read_snapshot(
    db: tauri::State<Db>,
    exclude_names: Vec<String>,
    force_include_name: Option<String>,
    max_json_bytes: u64,
) -> Result<DatasetSnapshot, String> {
    db.with(|conn| {
        read_snapshot(
            conn,
            &exclude_names,
            force_include_name.as_deref(),
            max_json_bytes,
        )
    })
}

#[tauri::command]
pub fn db_begin_project_import(
    db: tauri::State<Db>,
    entries: Vec<DatasetImportEntry>,
    pending_stores_json: String,
) -> Result<(), String> {
    db.with(|conn| begin_project_import(conn, &entries, &pending_stores_json))
}

#[tauri::command]
pub fn db_commit_project_import(db: tauri::State<Db>) -> Result<(), String> {
    db.with(commit_project_import)
}

#[tauri::command]
pub fn db_rollback_project_import(db: tauri::State<Db>) -> Result<(), String> {
    db.with(rollback_project_import)
}

#[tauri::command]
pub fn db_pending_project_import(db: tauri::State<Db>) -> Result<Option<String>, String> {
    db.with(pending_project_import)
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

    // ---------- fix2609j G16-desktop 回归 ----------

    fn file_db(dir: &Path) -> Connection {
        let conn = Connection::open(dir.join("datasets.db")).unwrap();
        configure_connection(&conn, DB_BUSY_TIMEOUT).unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    /// 另一个「进程」（独立连接 + 线程）以 BEGIN IMMEDIATE 持写锁 hold 后提交。
    fn hold_write_lock(path: PathBuf, hold: Duration) -> std::thread::JoinHandle<()> {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            let other = Connection::open(path).unwrap();
            other
                .execute_batch(
                    "BEGIN IMMEDIATE; UPDATE dataset_meta SET revision = revision WHERE id = 1;",
                )
                .unwrap();
            ready_tx.send(()).unwrap();
            std::thread::sleep(hold);
            other.execute_batch("COMMIT").unwrap();
        });
        ready_rx.recv().unwrap();
        handle
    }

    #[test]
    fn gap_5_2_write_commands_wait_for_another_writer_instead_of_failing_in_zero_ms() {
        // 修复前：DEFERRED 事务先 SELECT 拿 SHARED、INSERT 时升级失败，busy handler 不参与，
        // put_dataset 在 0 ms 内报「database is locked」。修复后 BEGIN IMMEDIATE 按 busy_timeout 等待。
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("datasets.db");
        let c = file_db(dir.path());
        type WriteOp = fn(&Connection) -> rusqlite::Result<()>;
        let ops: [(&str, WriteOp); 7] = [
            ("put_dataset", |c| put_dataset(c, "a", "{\"v\":1}", "t")),
            ("insert_dataset", |c| {
                insert_dataset(c, "b", "{}", "t").map(|_| ())
            }),
            ("delete_dataset", |c| delete_dataset(c, "b").map(|_| ())),
            ("clear_all_datasets", |c| {
                clear_all_datasets(c, "op-1").map(|_| ())
            }),
            ("begin_project_import", |c| {
                begin_project_import(c, &[], "{}")
            }),
            ("rollback_project_import", rollback_project_import),
            ("commit_project_import", commit_project_import),
        ];
        for (label, op) in ops {
            let holder = hold_write_lock(path.clone(), Duration::from_millis(300));
            // 读不受写锁阻塞（读事务保持 DEFERRED）。
            assert!(get_dataset(&c, "a").is_ok(), "{label}: 读应不受阻");
            let started = std::time::Instant::now();
            let result = op(&c);
            let waited = started.elapsed();
            holder.join().unwrap();
            assert!(
                result.is_ok(),
                "{label} 在另一连接持写锁时失败（{:?} 后）：{:?}",
                waited,
                result
            );
            assert!(
                waited >= Duration::from_millis(150),
                "{label} 应当等待另一写者释放锁，实际只用了 {waited:?}"
            );
        }
        assert_eq!(get_dataset(&c, "a").unwrap(), None, "clear 后应为空");
    }

    #[test]
    fn gap_5_2_busy_timeout_error_is_reported_in_chinese() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("datasets.db");
        let c = file_db(dir.path());
        configure_connection(&c, Duration::from_millis(50)).unwrap();
        let db = Db::available(c);
        let holder = hold_write_lock(path, Duration::from_millis(400));
        let error = db
            .with(|conn| put_dataset(conn, "a", "{}", "t"))
            .unwrap_err();
        holder.join().unwrap();
        assert!(error.contains("另一个质量分析平台实例"), "{error}");
        assert!(db.with(|conn| put_dataset(conn, "a", "{}", "t")).is_ok());
    }

    #[test]
    fn desktop_02_corrupt_db_is_quarantined_and_startup_continues_with_empty_db() {
        // 修复前：open 成功、init_schema 报 NotADatabase，setup 的 `?` 冒泡 → tauri panic 闪退。
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("datasets.db");
        let garbage = vec![0x5A_u8; 4096];
        std::fs::write(&db_path, &garbage).unwrap();
        std::fs::write(dir.path().join("datasets.db-wal"), b"stale wal").unwrap();

        let startup = open_dataset_db(Ok(dir.path().to_path_buf()), Duration::from_millis(200));

        assert!(startup.db.is_available());
        assert_eq!(startup.path, db_path.to_string_lossy());
        let notice = startup.notice.expect("损坏库必须给出用户可读提示");
        let backups: Vec<PathBuf> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|p| {
                let name = p.file_name().unwrap().to_string_lossy().to_string();
                name.starts_with("datasets.db.corrupt-") && !name.ends_with("-wal")
            })
            .collect();
        assert_eq!(backups.len(), 1, "应恰好保全一份损坏库");
        let backup = &backups[0];
        assert!(
            notice.contains(&*backup.to_string_lossy()),
            "提示须含备份完整路径：{notice}"
        );
        assert!(notice.contains("已损坏"));
        assert_eq!(
            std::fs::read(backup).unwrap(),
            garbage,
            "损坏文件须原样保全"
        );
        // 旧库的旁路日志不得留在原路径给新库回放。
        assert!(!dir.path().join("datasets.db-wal").exists());
        // 新库可正常读写。
        startup
            .db
            .with(|conn| put_dataset(conn, "新表", "{}", "t"))
            .unwrap();
        assert_eq!(
            startup.db.with(|conn| get_dataset(conn, "新表")).unwrap(),
            Some("{}".to_string())
        );
    }

    #[test]
    fn desktop_02_locked_db_reports_other_instance_without_touching_file() {
        // 修复前：第二实例 init_schema 撞上写锁 → SQLITE_BUSY → setup Err → panic。
        for lock_sql in ["BEGIN IMMEDIATE", "BEGIN EXCLUSIVE"] {
            let dir = tempfile::tempdir().unwrap();
            let db_path = dir.path().join("datasets.db");
            let first = file_db(dir.path());
            put_dataset(&first, "已有数据", "{\"keep\":true}", "t").unwrap();
            first.execute_batch(lock_sql).unwrap();

            let startup = open_dataset_db(Ok(dir.path().to_path_buf()), Duration::from_millis(150));

            assert!(!startup.db.is_available(), "{lock_sql}");
            let notice = startup.notice.clone().unwrap();
            assert!(
                notice.contains("已有另一个质量分析平台实例在运行"),
                "{notice}"
            );
            // 被占用的健康库绝不能被当作损坏库改名。
            let names: Vec<String> = std::fs::read_dir(dir.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
                .collect();
            assert!(
                names.iter().all(|name| !name.contains("corrupt")),
                "{names:?}"
            );
            // 所有 db_* 命令如实返回同一原因，前端启动屏障据此显示阻断提示。
            assert_eq!(
                startup
                    .db
                    .with(|conn| get_dataset(conn, "已有数据"))
                    .unwrap_err(),
                notice
            );
            first.execute_batch("COMMIT").unwrap();
            assert_eq!(
                get_dataset(&first, "已有数据").unwrap().as_deref(),
                Some("{\"keep\":true}")
            );
            drop(first);
            assert!(db_path.exists());
        }
    }

    #[test]
    fn desktop_02_uncreatable_data_dir_degrades_instead_of_panicking() {
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("occupied");
        std::fs::write(&blocked, b"a file where the data dir should be").unwrap();
        let startup = open_dataset_db(Ok(blocked.join("app")), Duration::from_millis(50));
        assert!(!startup.db.is_available());
        assert!(startup.notice.unwrap().contains("无法创建应用数据目录"));

        let startup = open_dataset_db(Err("no home".into()), Duration::from_millis(50));
        assert!(!startup.db.is_available());
        assert!(startup.notice.unwrap().contains("无法定位应用数据目录"));
    }

    #[test]
    fn desktop_02_healthy_db_opens_without_notice_and_keeps_data() {
        let dir = tempfile::tempdir().unwrap();
        {
            let first = file_db(dir.path());
            put_dataset(&first, "保留", "{}", "t").unwrap();
        }
        let startup = open_dataset_db(Ok(dir.path().to_path_buf()), DB_BUSY_TIMEOUT);
        assert!(startup.notice.is_none());
        assert_eq!(
            startup.db.with(|conn| get_dataset(conn, "保留")).unwrap(),
            Some("{}".to_string())
        );
    }

    #[test]
    fn desktop_02_quarantine_moves_sidecar_journals_with_the_corrupt_db() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("datasets.db");
        std::fs::write(&db_path, b"corrupt").unwrap();
        std::fs::write(dir.path().join("datasets.db-journal"), b"j").unwrap();
        std::fs::write(dir.path().join("datasets.db-wal"), b"w").unwrap();
        let first = quarantine_corrupt_db(&db_path).unwrap();
        assert!(!db_path.exists());
        assert_eq!(std::fs::read(&first).unwrap(), b"corrupt");
        for (side, bytes) in [("-journal", b"j"), ("-wal", b"w")] {
            assert!(!sibling_with_suffix(&db_path, side).exists());
            assert_eq!(
                std::fs::read(sibling_with_suffix(&first, side)).unwrap(),
                bytes
            );
        }
        // 同一秒内再次隔离不得覆盖上一份备份。
        std::fs::write(&db_path, b"again").unwrap();
        let second = quarantine_corrupt_db(&db_path).unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), b"corrupt");
        assert_eq!(std::fs::read(&second).unwrap(), b"again");
    }

    #[test]
    fn utc_timestamp_formats_civil_date() {
        let t = std::time::UNIX_EPOCH + Duration::from_secs(1_790_418_645);
        assert_eq!(utc_timestamp(t), "20260926-103045");
        assert_eq!(utc_timestamp(std::time::UNIX_EPOCH), "19700101-000000");
        let leap = std::time::UNIX_EPOCH + Duration::from_secs(951_782_400);
        assert_eq!(utc_timestamp(leap), "20000229-000000");
    }
}
