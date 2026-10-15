// SQLite 连接、建表迁移与基础查询封装（基于 Node 内置 node:sqlite）
import { DatabaseSync } from 'node:sqlite'

let _db = null

// 统一数据模型：collections 表达“一个资源集合”，items 是其文件列表（图片/视频混装，不再区分类型）。
// - 浏览方式由内容决定：详情页若全部为视频则用“播放器+列表”，否则用“平铺网格”。
// - favorites 通过 target_id 直接指向 collections.id。
const SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  category      TEXT,
  owner_id      TEXT NOT NULL,
  owner_name    TEXT,
  visibility    TEXT NOT NULL DEFAULT 'private',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collections_owner      ON collections(owner_id);
CREATE INDEX IF NOT EXISTS idx_collections_visibility ON collections(visibility);
CREATE INDEX IF NOT EXISTS idx_collections_created    ON collections(created_at DESC);

CREATE TABLE IF NOT EXISTS items (
  id             TEXT PRIMARY KEY,
  collection_id  TEXT NOT NULL,
  md5            TEXT NOT NULL,
  ext            TEXT,
  original_name  TEXT NOT NULL,           -- 上传时的原始文件名（不再修改）
  name           TEXT,                    -- 显示名（支持重命名；NULL 时前端回退到 original_name）
  mime           TEXT,
  size           INTEGER,
  media_type     TEXT NOT NULL,           -- 'video' | 'image'
  sort_order     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  meta_json      TEXT,                    -- 视频元数据（ffprobe 时长/分辨率/编码），图片/失败为 NULL
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_items_collection ON items(collection_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_items_md5        ON items(md5);

CREATE TABLE IF NOT EXISTS favorites (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  target_id    TEXT NOT NULL,             -- collections.id
  created_at   INTEGER NOT NULL,
  UNIQUE(user_id, target_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_user   ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_favorites_target ON favorites(target_id);
`

/**
 * 打开（或复用）SQLite 连接，并执行建表迁移。
 * @param {string} dbFile 数据库文件绝对路径
 */
export function initDb(dbFile) {
    if (_db) return _db
    _db = new DatabaseSync(dbFile)
    _db.exec('PRAGMA foreign_keys = ON')
    _db.exec('PRAGMA journal_mode = WAL')
    _db.exec(SCHEMA)
    return _db
}

export function getDb() {
    if (!_db) throw new Error('db not initialized')
    return _db
}

export function closeDb() {
    if (_db) { try { _db.close() } catch {} ; _db = null }
}

/** 便捷：执行多行返回 */
export function all(sql, ...params) {
    return getDb().prepare(sql).all(...params)
}

/** 便捷：执行单行返回 */
export function get(sql, ...params) {
    return getDb().prepare(sql).get(...params)
}

/** 便捷：执行写入 */
export function run(sql, ...params) {
    return getDb().prepare(sql).run(...params)
}

/** 事务包装：fn 抛错自动回滚 */
export function tx(fn) {
    const db = getDb()
    db.exec('BEGIN')
    try {
        const r = fn()
        db.exec('COMMIT')
        return r
    } catch (e) {
        try { db.exec('ROLLBACK') } catch {}
        throw e
    }
}
