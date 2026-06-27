/**
 * 用户数据库 —— SQLite 持久化用户账号
 *
 * 表结构：users (id, username, password_hash, role, created_at)
 * 启动时自动建表并从环境变量播种管理员账号。
 */

import Database from 'better-sqlite3';
import path from 'path';

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
  `);
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
