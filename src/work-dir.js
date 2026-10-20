// 工作目录初始化：upload_temp / store / thumbnails / scan / download / media.db
import * as fs from "node:fs";
import * as path from "node:path";

const TEMP_UPLOAD_DIR = 'upload_temp'
const MEDIA_STORE_DIR = 'store'
const THUMBNAIL_DIR = 'thumbnails'
const SCAN_DIR = 'scan'
const DOWNLOAD_DIR = 'download'
const DB_FILE = 'media.db'

function ensureDir(p) {
    if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
    }
}

/**
 * 初始化工作目录，缺失则创建，返回所有绝对路径。
 * @param {string} dir 用户指定的根目录（相对或绝对）
 * @returns {{
 *   root: string,
 *   uploadTempDir: string,
 *   storeDir: string,
 *   thumbnailDir: string,
 *   scanDir: string,
 *   downloadDir: string,
 *   dbFile: string
 * }}
 */
export const initStoreDir = (dir) => {
    const root = path.resolve(dir)
    ensureDir(root)
    const uploadTempDir = path.join(root, TEMP_UPLOAD_DIR)
    const storeDir = path.join(root, MEDIA_STORE_DIR)
    const thumbnailDir = path.join(root, THUMBNAIL_DIR)
    const scanDir = path.join(root, SCAN_DIR)
    const downloadDir = path.join(root, DOWNLOAD_DIR)
    ensureDir(uploadTempDir)
    ensureDir(storeDir)
    ensureDir(thumbnailDir)
    ensureDir(scanDir)
    const dbFile = path.join(root, DB_FILE)
    return { root, uploadTempDir, storeDir, thumbnailDir, scanDir, downloadDir, dbFile }
}
