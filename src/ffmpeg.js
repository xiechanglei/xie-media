// ffmpeg / ffprobe 封装：可用性检测 + 视频缩略图懒生成 + 视频元数据探测 + 视频剪切
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
 * 视频剪切：去掉 [removeStartSec, removeEndSec] 区间（去广告用），保留前后两段拼接。
 * 任意时间点切断必须重编码；先写到调用方准备好的临时输出路径，成功后由调用方替换原文件。
 * 长任务用异步 spawn：不阻塞事件循环。失败抛 Error（附 stderr 尾部）。
 * @param {{ inputPath:string, outputPath:string, removeStartSec:number, removeEndSec:number, durationSec:number, hasAudio:boolean, ext:string }} opts
 */
export function removeVideoRange({ inputPath, outputPath, removeStartSec, removeEndSec, durationSec, hasAudio, ext }) {
    return new Promise((resolve, reject) => {
        const fc = buildCutOutFilter({ removeStartSec, removeEndSec, durationSec, hasAudio })
        if (!fc) { reject(new Error('剪切后剩余时长为 0，请调整时间段')); return }
        const args = [
            '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
            '-filter_complex', fc.filter,
            '-map', fc.vMap, ...(fc.aMap ? ['-map', fc.aMap] : []),
            ...encodeArgsFor(ext, hasAudio),
            '-map_metadata', '0',
            outputPath,
        ]
        const proc = spawn('ffmpeg', args)
        let tail = ''
        proc.stderr.on('data', d => { tail = (tail + d).slice(-4000) })
        proc.on('error', reject)
        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) return resolve()
            reject(new Error(`ffmpeg 剪切失败（exit ${code}）：` +
                tail.split('\n').map(s => s.trim()).filter(Boolean).slice(-3).join(' / ')))
        })
    })
}

/** 前后两段用 trim/atrim 截取后 concat 拼接，返回 filter_complex 与 map 标签；无剩余时长时返回 null */
function buildCutOutFilter({ removeStartSec, removeEndSec, durationSec, hasAudio }) {
    const EPS = 0.05
    const segs = []
    if (removeStartSec > EPS) segs.push([0, removeStartSec])
    if (durationSec - removeEndSec > EPS) segs.push([removeEndSec, durationSec])
    if (!segs.length) return null
    const parts = []
    const vLabels = [], aLabels = []
    segs.forEach(([ss, to], i) => {
        // 尾段直到片尾时省略 end，避免浮点边界把最后几帧切掉
        const toTail = durationSec - to <= EPS ? '' : `:end=${to}`
        parts.push(`[0:v]trim=start=${ss}${toTail},setpts=PTS-STARTPTS[v${i}]`)
        vLabels.push(`[v${i}]`)
        if (hasAudio) {
            parts.push(`[0:a]atrim=start=${ss}${toTail},asetpts=PTS-STARTPTS[a${i}]`)
            aLabels.push(`[a${i}]`)
        }
    })
    if (segs.length === 1) return { filter: parts.join(';'), vMap: '[v0]', aMap: hasAudio ? '[a0]' : null }
    const inputs = hasAudio ? vLabels.map((v, i) => `${v}${aLabels[i]}`).join('') : vLabels.join('')
    parts.push(`${inputs}concat=n=${segs.length}:v=1:a=${hasAudio ? 1 : 0}[outv]${hasAudio ? '[outa]' : ''}`)
    return { filter: parts.join(';'), vMap: '[outv]', aMap: hasAudio ? '[outa]' : null }
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
