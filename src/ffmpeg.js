// ffmpeg / ffprobe 封装：可用性检测 + 视频缩略图懒生成 + 视频元数据探测 + 视频裁剪
import { spawnSync, spawn, execFile } from 'node:child_process'
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
 * 视频裁剪：只保留 [startSec, endSec] 这一连续区间，两端都可传 null 表示那一头不动。
 * 典型用法是一刀两断：留 startSec=null 即只剪片尾，留 endSec=null 即只剪片头。
 * 保留的是单段连续内容，所以能走 -c copy 流拷贝：不解码不重编码，耗时接近一次 remux。
 * 代价是 copy 只能在关键帧下刀，ffmpeg 会取所选时间之前最近的关键帧，实际起点可能早 1~2 秒，
 * 片头偶有几帧花屏；对「剪掉片头广告/片尾彩蛋」这类用途完全够用。
 * 若 copy 失败（个别容器/编码不支持时间戳重置），自动回退重编码，保证任何输入都能剪。
 * 长任务用异步 spawn：不阻塞事件循环。失败抛 Error（附 stderr 尾部）。
 * @param {{ inputPath:string, outputPath:string, startSec:number|null, endSec:number|null, hasAudio:boolean, ext:string }} opts
 */
export function trimVideoKeepRange({ inputPath, outputPath, startSec, endSec, hasAudio, ext }) {
    const from = startSec && startSec > 0 ? startSec : null
    const to = endSec && endSec > 0 ? endSec : null
    // -ss 放在 -i 之前是输入侧 seek：copy 模式直接跳到关键帧，前面的内容连解码都不做
    const head = ['-hide_banner', '-loglevel', 'error', '-y']
    if (from != null) head.push('-ss', from.toFixed(3))
    head.push('-i', inputPath)
    // 输入侧 seek 后时间戳已归零，故输出侧用相对时长 -t；保留到片尾时干脆不给结束参数，少写一次尾部索引
    const range = to != null ? ['-t', Math.max(0.001, (to - (from ?? 0))).toFixed(3)] : []
    const copyArgs = [...head, ...range,
        '-c', 'copy', '-avoid_negative_ts', 'make_zero',
        ...faststartFor(ext), outputPath]
    const encodeArgs = [...head, ...range, ...encodeArgsFor(ext, hasAudio), '-map_metadata', '0', outputPath]
    return runFfmpeg(copyArgs, '流拷贝')
        .catch(copyErr => runFfmpeg(encodeArgs, '重编码')
            .catch(encodeErr => { throw new Error(`${encodeErr.message}（流拷贝先失败：${copyErr.message}）`) }))
}

/** mp4/mov 把 moov 前置才能边下边播；流拷贝下这只是重排容器，不触及码率，代价极小 */
function faststartFor(ext) {
    const e = (ext || '').toLowerCase()
    return (e === 'mp4' || e === 'mov') ? ['-movflags', '+faststart'] : []
}

/** 跑一次 ffmpeg，退出码非 0 或没产出文件即抛错；label 用于区分同一次裁剪里的多条路径 */
function runFfmpeg(args, label) {
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', args)
        let tail = ''
        proc.stderr.on('data', d => { tail = (tail + d).slice(-4000) })
        proc.on('error', reject)
        proc.on('close', (code) => {
            const out = args[args.length - 1]
            if (code === 0 && fs.existsSync(out)) return resolve()
            const detail = tail.split('\n').map(s => s.trim()).filter(Boolean).slice(-3).join(' / ')
            reject(new Error(`ffmpeg ${label}失败（exit ${code}）：${detail}`))
        })
    })
}

/** 按容器选重编码参数：webm 只收 VP9/Opus；其余（mp4/mov/mkv/未知）统一 H.264/AAC，浏览器兼容优先 */
function encodeArgsFor(ext, hasAudio) {
    const e = (ext || '').toLowerCase()
    if (e === 'webm') {
        return ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-cpu-used', '4',
            ...(hasAudio ? ['-c:a', 'libopus', '-b:a', '128k'] : [])]
    }
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
        ...((e === 'mp4' || e === 'mov') ? ['-movflags', '+faststart'] : [])]
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
