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
export type UserRole = 'admin' | 'user';

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
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT    NOT NULL UNIQUE,
      password_hash TEXT  NOT NULL,
      role        TEXT    NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
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
  `);
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
