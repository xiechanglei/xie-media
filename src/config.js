// 应用标题
export const APP_TITLE = "xie media server"

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
