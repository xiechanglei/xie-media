// 应用标题默认值（可通过启动命令 --title 覆盖）
export const DEFAULT_APP_TITLE = "media server"

// 允许上传的视频扩展名（小写，不带点）
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'mkv']
// 允许上传的图片扩展名（小写，不带点）
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif']

// 全部允许的扩展名（上传白名单）
export const ALLOWED_EXTENSIONS = [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]

// 单请求最大文件数（相册可能一次多张）
export const UPLOAD_MAX_FILES = 100

// 单文件大小上限（业务上"不限制"，用一个足够大的值即可）
export const UPLOAD_MAX_SIZE = '1TB'

// scan 目录自动入库：扫描间隔（毫秒）
export const SCAN_INTERVAL_MS = 10_000
// 半传输防护：文件 mtime 距今超过该毫秒数才认定"写完"，可入库
export const SCAN_MTIME_STABLE_MS = 30_000
