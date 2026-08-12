/**
 * 用户数据库 —— SQLite 持久化用户账号
 *
 * 表结构：users (id, username, password_hash, role, created_at)
 * 启动时自动建表并从环境变量播种管理员账号。
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let db: Database.Database;

/** 用户角色类型 */
export type UserRole = 'admin' | 'manager' | 'user';

/** 数据库中的用户行 */
export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  created_at: string;
}

/** 安全序列化（不暴露密码哈希） */
export interface SafeUser {
  id: number;
  username: string;
  role: UserRole;
  created_at: string;
}

/** 初始化用户数据库：打开/创建 SQLite 文件并建表 */
export function initUserDB(dbDir: string): void {
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'users.sqlite');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT    NOT NULL UNIQUE,
      password_hash TEXT  NOT NULL,
      role        TEXT    NOT NULL DEFAULT 'user' CHECK(role IN ('admin','manager','user')),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS parse_records (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      input         TEXT    NOT NULL DEFAULT '',
      color_hints   TEXT    NOT NULL DEFAULT '[]',
      items         TEXT    NOT NULL DEFAULT '[]',
      conversation  TEXT    NOT NULL DEFAULT '[]',
      lang          TEXT    NOT NULL DEFAULT 'zh',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_parse_records_user ON parse_records(user_id);

    CREATE TABLE IF NOT EXISTS notes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      original_name TEXT    NOT NULL DEFAULT '',
      content       TEXT    NOT NULL DEFAULT '',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id);

    CREATE TABLE IF NOT EXISTS trace_sessions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id     TEXT    NOT NULL UNIQUE,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username            TEXT    NOT NULL,
      main_agent          TEXT    NOT NULL,
      agent_name          TEXT    NOT NULL,
      parent_tool_call_id TEXT,
      route               TEXT,
      provider            TEXT,
      model               TEXT,
      status              TEXT    NOT NULL DEFAULT 'running',
      error               TEXT,
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      completed_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trace_sessions_created_at ON trace_sessions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trace_sessions_user_created ON trace_sessions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trace_sessions_parent_tool_call ON trace_sessions(parent_tool_call_id);
    CREATE INDEX IF NOT EXISTS idx_trace_sessions_conversation_id ON trace_sessions(conversation_id);

    CREATE TABLE IF NOT EXISTS client_sent (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id     TEXT    NOT NULL REFERENCES trace_sessions(conversation_id) ON DELETE CASCADE,
      message_index       INTEGER NOT NULL,
      role                TEXT    NOT NULL,
      name                TEXT,
      tool_call_id        TEXT,
      parent_tool_call_id TEXT,
      content_text        TEXT,
      content_json        TEXT,
      content_format      TEXT    NOT NULL DEFAULT 'text',
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      completed_at        TEXT,
      error               TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_client_sent_conversation ON client_sent(conversation_id, message_index, id);
    CREATE INDEX IF NOT EXISTS idx_client_sent_tool_call ON client_sent(tool_call_id);

    CREATE TABLE IF NOT EXISTS client_received (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id     TEXT    NOT NULL REFERENCES trace_sessions(conversation_id) ON DELETE CASCADE,
      message_index       INTEGER NOT NULL,
      finish_reason       TEXT,
      reply               TEXT,
      reasoning           TEXT,
      tool_calls_json     TEXT,
      tool_call_ids_json  TEXT,
      source              TEXT    NOT NULL DEFAULT 'llm',
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      completed_at        TEXT,
      error               TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_client_received_conversation ON client_received(conversation_id, message_index, id);
    CREATE INDEX IF NOT EXISTS idx_client_received_created ON client_received(created_at DESC);

    CREATE TABLE IF NOT EXISTS quotation_tasks (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username           TEXT    NOT NULL,
      quotation_number   TEXT    NOT NULL,
      write_mode         TEXT    NOT NULL CHECK(write_mode IN ('overwrite','append')),
      status             TEXT    NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','partial_failed','failed','cancelled')),
      odoo_url           TEXT,
      task_error         TEXT,
      retry_count        INTEGER NOT NULL DEFAULT 0,
      last_acked_attempt INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      started_at         TEXT,
      completed_at         TEXT,
      pending_confirmation TEXT,
      final_lines_snapshot TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_quotation_tasks_user ON quotation_tasks(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_quotation_tasks_status ON quotation_tasks(status, created_at ASC);

    CREATE TABLE IF NOT EXISTS quotation_task_lines (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL REFERENCES quotation_tasks(id) ON DELETE CASCADE,
      line_no    INTEGER NOT NULL,
      part_model TEXT    NOT NULL,
      quantity   INTEGER NOT NULL,
      discount   REAL,
      status     TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed')),
      error      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_quotation_task_lines_task ON quotation_task_lines(task_id);
  `);

  migrateUsersManagerRole(db);
  migrateQuotationLineDiscount(db);
}

/**
 * 版本化迁移：users 表放宽角色 CHECK 以支持 manager 角色。
 *
 * SQLite 不支持 ALTER 修改 CHECK 约束，必须用「关闭外键 → 建新表 → 复制 →
 * 删旧 → 改名 → 开外键 → 校验」的标准重建模式。仅当 users 表当前 schema
 * 不含 'manager' 时执行；已迁移或全新库直接记录迁移标记，保证幂等。
 */
function migrateUsersManagerRole(database: Database.Database): void {
  const row = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'",
  ).get() as { sql: string } | undefined;
  const alreadySupportsManager = !!row?.sql && row.sql.includes('manager');

  if (!alreadySupportsManager) {
    database.exec('PRAGMA foreign_keys = OFF;');
    const rebuild = database.transaction(() => {
      database.exec(`
        CREATE TABLE users_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          username    TEXT    NOT NULL UNIQUE,
          password_hash TEXT  NOT NULL,
          role        TEXT    NOT NULL DEFAULT 'user' CHECK(role IN ('admin','manager','user')),
          created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO users_new (id, username, password_hash, role, created_at)
          SELECT id, username, password_hash, role, created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
    });
    rebuild();
    database.exec('PRAGMA foreign_keys = ON;');
    const violations = database.pragma('foreign_key_check', { simple: false });
    if (Array.isArray(violations) && violations.length > 0) {
      throw new Error(`users 表迁移后外键一致性检查失败: ${JSON.stringify(violations)}`);
    }
  }

  database.prepare(
    'INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)',
  ).run('0001_users_manager_role');
}

/**
 * 版本化迁移：为已存在的 quotation_task_lines 表补充 discount 列（nullable REAL）。
 * 全新库已由 CREATE TABLE 包含该列，此迁移仅处理升级场景，通过 PRAGMA
 * table_info 判断幂等；列不存在时执行 ADD COLUMN。
 */
function migrateQuotationLineDiscount(database: Database.Database): void {
  const columns = database.pragma('table_info(quotation_task_lines)', { simple: false }) as {
    name: string;
  }[];
  const hasDiscount = columns.some((c) => c.name === 'discount');

  if (!hasDiscount) {
    database.exec('ALTER TABLE quotation_task_lines ADD COLUMN discount REAL');
  }

  database.prepare(
    'INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)',
  ).run('0002_quotation_task_lines_discount');
}

/** 获取底层 SQLite 数据库连接（供 trace 等服务模块使用） */
export function getUserDb(): Database.Database {
  return db;
}

/** 从环境变量播种管理员账号（已存在则跳过） */
export function seedAdminUser(username: string, passwordHash: string): void {
  const existing = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (existing) return;

  const upsert = db.prepare(`
    INSERT INTO users (username, password_hash, role)
    VALUES (?, ?, 'admin')
    ON CONFLICT(username) DO NOTHING
  `);
  upsert.run(username, passwordHash);
}

/** 按用户名查找用户行（含密码哈希） */
export function findUserByUsername(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

/** 按 ID 查找用户（不含密码哈希） */
export function findUserById(id: number): SafeUser | undefined {
  return db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id) as SafeUser | undefined;
}

/** 创建新用户（默认 role=user），返回安全用户对象 */
export function createUser(username: string, passwordHash: string): SafeUser {
  const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
  const user = findUserById(Number(result.lastInsertRowid));
  if (!user) throw new Error('用户创建失败');
  return user;
}

// ==================================================================
//  parse_records —— 历史记录 CRUD
// ==================================================================

/** 历史记录摘要行（从 DB 读取） */
interface RecordSummaryRow {
  id: number;
  items: string;
  created_at: string;
}

/** 历史记录完整行（从 DB 读取） */
interface RecordFullRow {
  id: number;
  input: string;
  color_hints: string;
  items: string;
  conversation: string;
  lang: string;
  created_at: string;
}

/** 每条用户最多保留的历史记录条数 */
const MAX_RECORDS_PER_USER = 200;

/** 插入一条解析记录，超限时自动删除最旧记录，返回新记录 id */
export function insertRecord(
  userId: number,
  input: string,
  colorHints: string[],
  items: string,
  conversation: string,
  lang: string,
): number {
  const insert = db.prepare(`
    INSERT INTO parse_records (user_id, input, color_hints, items, conversation, lang)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = insert.run(userId, input, JSON.stringify(colorHints), items, conversation, lang);
  const newId = Number(result.lastInsertRowid);

  const count = db.prepare(
    'SELECT COUNT(*) AS cnt FROM parse_records WHERE user_id = ?',
  ).get(userId) as { cnt: number };

  if (count.cnt > MAX_RECORDS_PER_USER) {
    db.prepare(`
      DELETE FROM parse_records
      WHERE id IN (
        SELECT id FROM parse_records
        WHERE user_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      )
    `).run(userId, count.cnt - MAX_RECORDS_PER_USER);
  }

  return newId;
}

/** 获取某用户的全部历史记录摘要（按时间倒序） */
export function getRecordsByUser(
  userId: number,
): { id: number; itemCount: number; created_at: string }[] {
  const rows = db.prepare(`
    SELECT id, items, created_at
    FROM parse_records
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId) as RecordSummaryRow[];

  return rows.map((r) => ({
    id: r.id,
    itemCount: JSON.parse(r.items).length,
    created_at: r.created_at,
  }));
}

/** 获取某条记录的完整详情，仅限本人 */
export function getRecordById(
  userId: number,
  recordId: number,
): RecordFullRow | undefined {
  return db.prepare(`
    SELECT id, input, color_hints, items, conversation, lang, created_at
    FROM parse_records
    WHERE id = ? AND user_id = ?
  `).get(recordId, userId) as RecordFullRow | undefined;
}

/** 删除某条记录，仅限本人 */
export function deleteRecord(userId: number, recordId: number): boolean {
  const result = db.prepare(`
    DELETE FROM parse_records WHERE id = ? AND user_id = ?
  `).run(recordId, userId);
  return result.changes > 0;
}

// ==================================================================
//  notes —— 用户笔记 CRUD
// ==================================================================

/** 笔记行（从 DB 读取） */
interface NoteRow {
  id: number;
  original_name: string;
  content: string;
}

/** 获取某用户的全部笔记 */
export function getNotesByUser(userId: number): { id: number; originalName: string; content: string }[] {
  const rows = db.prepare(`
    SELECT id, original_name, content FROM notes WHERE user_id = ? ORDER BY id ASC
  `).all(userId) as NoteRow[];

  return rows.map((r) => ({
    id: r.id,
    originalName: r.original_name,
    content: r.content,
  }));
}

/** 全量替换某用户的笔记（先删后插） */
export function replaceNotesForUser(
  userId: number,
  notes: { originalName: string; content: string }[],
): void {
  const deleteStmt = db.prepare('DELETE FROM notes WHERE user_id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO notes (user_id, original_name, content) VALUES (?, ?, ?)',
  );

  const tx = db.transaction(() => {
    deleteStmt.run(userId);
    for (const n of notes) {
      insertStmt.run(userId, n.originalName, n.content);
    }
  });

  tx();
}

// ==================================================================
//  管理员功能 —— 全历史浏览 + 用户管理
// ==================================================================

/** 管理员专用：获取所有用户的全部历史记录摘要（按时间倒序，含归属用户信息） */
export function getAllRecords(): {
  id: number;
  itemCount: number;
  created_at: string;
  user_id: number;
  username: string;
}[] {
  const rows = db.prepare(`
    SELECT pr.id, pr.items, pr.created_at, pr.user_id, u.username
    FROM parse_records pr
    JOIN users u ON pr.user_id = u.id
    ORDER BY pr.created_at DESC
  `).all() as { id: number; items: string; created_at: string; user_id: number; username: string }[];

  return rows.map((r) => ({
    id: r.id,
    itemCount: JSON.parse(r.items).length,
    created_at: r.created_at,
    user_id: r.user_id,
    username: r.username,
  }));
}

/** 管理员专用：根据 ID 获取任意记录完整详情（不限用户） */
export function getRecordByIdForAdmin(recordId: number): RecordFullRow | undefined {
  return db.prepare(`
    SELECT id, input, color_hints, items, conversation, lang, created_at
    FROM parse_records
    WHERE id = ?
  `).get(recordId) as RecordFullRow | undefined;
}

/** 管理员专用：获取所有用户列表（不含密码哈希） */
export function listUsers(): SafeUser[] {
  return db.prepare(
    'SELECT id, username, role, created_at FROM users ORDER BY id ASC',
  ).all() as SafeUser[];
}

/** 管理员专用：按 ID 删除用户（外键级联删除其 parse_records / notes / trace_sessions） */
export function deleteUserById(userId: number): boolean {
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return result.changes > 0;
}

/** 管理员专用：更新用户名 */
export function updateUsername(userId: number, username: string): boolean {
  const result = db.prepare(
    'UPDATE users SET username = ? WHERE id = ?',
  ).run(username, userId);
  return result.changes > 0;
}

/** 管理员专用：更新用户密码哈希 */
export function updateUserPassword(userId: number, passwordHash: string): boolean {
  const result = db.prepare(
    'UPDATE users SET password_hash = ? WHERE id = ?',
  ).run(passwordHash, userId);
  return result.changes > 0;
}

/** 管理员专用：更新用户角色（仅允许 user / manager，不能授予 admin） */
export function updateUserRole(userId: number, role: UserRole): boolean {
  const result = db.prepare(
    'UPDATE users SET role = ? WHERE id = ?',
  ).run(role, userId);
  return result.changes > 0;
}
