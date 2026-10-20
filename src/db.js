// SQLite 连接、建表迁移与基础查询封装（基于 Node 内置 node:sqlite）
import { DatabaseSync } from 'node:sqlite'

let _db = null

// 统一数据模型：collections 表达“一个资源集合”，items 是其文件列表（图片/视频混装，不再区分类型）。
// - 浏览方式由内容决定：详情页若全部为视频则用“播放器+列表”，否则用“平铺网格”。
// - favorites 通过 target_id 直接指向 collections.id。
// - albums/album_entries 是“资源的收藏册”（专辑 → 若干资源），与 v0.2 已废弃的同名表无关：
//   专辑只引用 collections.id、不持有文件也不复制标题，资源改名/换封面在专辑里自动同步。
//   条目只随“存在性变动”物理同步（资源被删则级联、被合并则重指向）；
//   “可见性变动”（转私有/送人）不动数据，由读取侧按 canRead 过滤，重新公开后条目自动回来。
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

-- 专辑（仅创建者可见：visibility 字段恒为 private，为将来开放广场预留、届时无需改表）
CREATE TABLE IF NOT EXISTS albums (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  owner_name  TEXT,
  visibility  TEXT NOT NULL DEFAULT 'private',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_albums_owner ON albums(owner_id);

-- 专辑条目：只存引用，无 sort_order（固定按 added_at 倒序，新加入的在前）；
-- added_by 用于“送人时只清送出者自己加的条目”，不误伤接收方或其他用户的专辑
CREATE TABLE IF NOT EXISTS album_entries (
  id             TEXT PRIMARY KEY,
  album_id       TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  collection_id  TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  added_at       INTEGER NOT NULL,
  added_by       TEXT NOT NULL,
  added_by_name  TEXT,
  UNIQUE(album_id, collection_id)
);
CREATE INDEX IF NOT EXISTS idx_album_entries_album      ON album_entries(album_id, added_at DESC);
-- 删资源时 CASCADE 要扫子表，无此索引会退化为全表扫
CREATE INDEX IF NOT EXISTS idx_album_entries_collection ON album_entries(collection_id);

-- 离线下载任务：dir 为每任务独立的下载目录（download/<id>/）；
-- gid 是 aria2 运行时句柄，重启续传后会变，跨重启对账的锚点是 info_hash；
-- 进度字段（total/completed/error）是轮询时的展示快照，aria2 不可达时回退用 DB 值
CREATE TABLE IF NOT EXISTS download_tasks (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  owner_name       TEXT,
  gid              TEXT,
  info_hash        TEXT,
  type             TEXT NOT NULL,           -- 'torrent' | 'magnet'
  source           TEXT NOT NULL,           -- 磁力整串 URI 或种子文件名（种子内容不落盘，会话恢复靠 aria2 session）
  display_name     TEXT,                    -- 种子/磁力里的资源名，入库时可改
  dir              TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'waiting',  -- waiting|active|paused|complete|error
  progression_mask TEXT,                    -- aria2 select-file 串（1-based 索引逗号分隔，如 '1,3,5'），重启对账时删后重加重放
  total_length     INTEGER,
  completed_length INTEGER,
  error_message    TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_download_tasks_owner ON download_tasks(owner_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_download_tasks_infohash ON download_tasks(info_hash) WHERE info_hash IS NOT NULL;
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
