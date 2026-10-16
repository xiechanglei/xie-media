// ffmpeg / ffprobe 封装：可用性检测 + 视频缩略图懒生成 + 视频元数据探测
import { spawnSync, execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * 检测 ffmpeg 是否可用；不可用抛出异常。
 */
export function assertFfmpegAvailable() {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
    if (r.error || r.status !== 0) {
        const msg = (r.error && r.error.code === 'ENOENT')
            ? '未检测到 ffmpeg，请先安装：\n  Ubuntu/Debian: sudo apt install ffmpeg\n  macOS: brew install ffmpeg'
            : `ffmpeg 检测失败：${r.stderr || r.error?.message || 'unknown'}`
        throw new Error(msg)
    }
}

/** 解析 ffprobe JSON 输出为需要的 meta（失败返回 null；供异步探测使用） */
function parseProbeOutput(stdout) {
    let j
    try { j = JSON.parse(stdout) } catch { return null }
    const streams = Array.isArray(j.streams) ? j.streams : []
    const v = streams.find(s => s.codec_type === 'video')
    const a = streams.find(s => s.codec_type === 'audio')
    if (!v) return null
    const width = Number(v.width) || null
    const height = Number(v.height) || null
    const durationSec = Math.round(parseFloat(v.duration ?? j.format?.duration) * 10) / 10 || 0
    const bitRate = Number(j.format?.bit_rate) || Number(v.bit_rate) || null
    return {
        durationSec,
        width,
        height,
        videoCodec: v.codec_name || null,
        audioCodec: a?.codec_name || null,
        container: j.format?.format_name || null,
        bitRate,
    }
}

/**
 * 用 ffprobe 读取视频元数据（上传/扫描时调用，失败不阻断）。
 * 异步非阻塞：避免 spawnSync 在请求处理期间卡住整个事件循环。
 * @param {string} filePath 磁盘上已落盘的 video 文件绝对路径
 * @returns {Promise<{durationSec:number,width:number,height:number,videoCodec:string|null,audioCodec:string|null,container:string|null,bitRate:number|null}|null>}
 */
export function probeVideoMeta(filePath) {
    return new Promise((resolve) => {
        if (!fs.existsSync(filePath)) return resolve(null)
        execFile('ffprobe', [
            '-v', 'error',
            '-print_format', 'json',
            '-show_format', '-show_streams',
            filePath,
        ], { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
            if (err || !stdout) {
                console.warn('[ffprobe] 失败:', ((err && (err.stderr || err.message)) || '').slice(0, 200))
                return resolve(null)
            }
            resolve(parseProbeOutput(stdout))
        })
    })
}

/**
 * 确保视频缩略图存在；不存在则用 ffmpeg 抽取一帧生成。
 * 已存在则直接返回路径。生成失败返回 null，不抛出。
 *
 * @param {{ videoPath: string, thumbPath: string }} opts
 * @returns {string|null}
 */
export function ensureVideoThumbnail({ videoPath, thumbPath }) {
    if (fs.existsSync(thumbPath)) return thumbPath
    if (!fs.existsSync(videoPath)) return null
    // 缩略图目录按 md5 前缀分片，ffmpeg 不会自建父目录，先确保存在
    try { fs.mkdirSync(path.dirname(thumbPath), { recursive: true }) } catch {}

    // 优先 seek 到 3 秒处，取到一帧即可；若视频短于 3 秒则回退到 0。
    const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', '00:00:03',
        '-i', videoPath,
        '-frames:v', '1',
        '-q:v', '3',
        '-vf', 'scale=w=640:h=-1:force_original_aspect_ratio=decrease',
        '-y',
        thumbPath,
    ]
    let r = spawnSync('ffmpeg', args, { encoding: 'utf8' })
    if (r.status !== 0 || !fs.existsSync(thumbPath)) {
        // fallback 到 0 秒
        const args0 = args.map(a => a === '00:00:03' ? '00:00:00' : a)
        r = spawnSync('ffmpeg', args0, { encoding: 'utf8' })
        if (r.status !== 0 || !fs.existsSync(thumbPath)) {
            console.warn('[ffmpeg] 缩略图生成失败:', r.stderr || r.error?.message || '')
            try { if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath) } catch {}
            return null
        }
    }
    return thumbPath
}
