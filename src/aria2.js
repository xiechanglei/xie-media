// aria2 集成：可用性探测 + JSON-RPC daemon 子进程生命周期 + RPC 客户端封装
// - 软降级：未安装/启动失败只关闭离线下载功能，不影响主服务（与 ffmpeg 的硬失败相反）
// - 会话持久化：--save-session/--input-file 让未完成任务跨重启续传（GID 会变，对账靠 info_hash）
// - 每任务显式传 dir 选项，daemon 默认 --dir 仅作兜底；seed-time=0 下完即 complete 不做种
import { spawnSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
    ARIA2_RPC_PORT,
    ARIA2_MAX_CONCURRENT_DOWNLOADS,
    ARIA2_SESSION_FILE,
    ARIA2_RPC_READY_TIMEOUT_MS,
} from './config.js'

const ARIA2_BIN = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'

/** 按平台给出安装指引（控制台提示用） */
export function aria2InstallHint() {
    switch (process.platform) {
        case 'linux':
            return '未检测到 aria2，离线下载功能不可用。安装： sudo apt install aria2（Debian/Ubuntu）/ sudo dnf install aria2（Fedora）'
        case 'darwin':
            return '未检测到 aria2，离线下载功能不可用。安装： brew install aria2'
        case 'win32':
            return '未检测到 aria2，离线下载功能不可用。请从 https://github.com/aria2/aria2/releases 下载 Windows 64 位压缩包解压，并将所在目录加入 PATH（或 scoop install aria2）'
        default:
            return '未检测到 aria2，离线下载功能不可用。参见 https://aria2.github.io/ 安装'
    }
}

/** 同步探测 aria2c 是否可用（不启动 daemon） */
export function detectAria2() {
    const r = spawnSync(ARIA2_BIN, ['--version'], { encoding: 'utf8' })
    if (r.error || r.status !== 0) {
        return {
            available: false,
            reason: (r.error && r.error.code === 'ENOENT') ? 'not_installed' : 'broken',
            detail: String(r.stderr || (r.error && r.error.message) || '').slice(0, 200),
        }
    }
    const version = String(r.stdout || '').split('\n')[0].trim()
    return { available: true, version }
}

/**
 * 创建 aria2 控制器。
 * @param {{ downloadDir: string, port?: number, maxConcurrentDownloads?: number }} cfg
 * @returns {{
 *   start: () => Promise<{ ok: boolean, reason?: string, version?: string, reused?: boolean }>,
 *   stop: () => void,
 *   isRunning: () => boolean,
 *   rpcCall: (method: string, params?: any[]) => Promise<any>,
 *   tellStatus: (gid: string, fields?: string[]) => Promise<any>,
 * }}
 */
export function createAria2(cfg) {
    const downloadDir = cfg.downloadDir
    const port = cfg.port || ARIA2_RPC_PORT
    const maxConcurrentDownloads = cfg.maxConcurrentDownloads || ARIA2_MAX_CONCURRENT_DOWNLOADS
    const rpcUrl = `http://127.0.0.1:${port}/jsonrpc`
    const sessionFile = path.join(downloadDir, ARIA2_SESSION_FILE)

    let child = null        // 我们拉起的 daemon（复用外部 daemon 时为 null）
    let running = false
    let stopping = false    // 主动 stop 标记：SIGTERM 关停时 aria2 若有失败任务会以非 0 退出，不应误报“异常退出”

    /** 发起一次 JSON-RPC 调用；网络失败或 aria2 返回 error 均抛 Error */
    async function rpcCall(method, params = []) {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'xm', method, params }),
            signal: AbortSignal.timeout(10_000),
        })
        // aria2 对 RPC 错误可能直接回 HTTP 400（body 仍是 JSON-RPC error 结构），透出真实错因
        let j
        try { j = await res.json() } catch { j = null }
        if (j && j.error) {
            const e = new Error(`${j.error.message}（code ${j.error.code}）`)
            e.aria2Code = j.error.code
            e.aria2Message = j.error.message
            throw e
        }
        if (!res.ok) throw new Error(`aria2 RPC HTTP ${res.status}`)
        return j ? j.result : null
    }

    /** tellStatus 快捷方式；fields 限定返回字段，减小响应 */
    async function tellStatus(gid, fields = ['status', 'totalLength', 'completedLength', 'downloadSpeed', 'errorCode', 'errorMessage', 'files', 'infoHash']) {
        return rpcCall('aria2.tellStatus', [gid, fields])
    }

    /** daemon 是否存活（含复用外部 daemon 的情形） */
    function isRunning() {
        if (child) return running
        // 复用模式下 running 只代表"上次探测时可用"，快速判真即可，出错由调用方兜底
        return running
    }

    /** 拉起子进程；stdio 收窄到 warn，防止进度条刷屏 */
    function spawnDaemon() {
        const args = [
            '--enable-rpc',
            `--rpc-listen-port=${port}`,
            '--rpc-listen-all=false',
            `--dir=${downloadDir}`,
            `--save-session=${sessionFile}`,
            `--auto-save-interval=20`,
            '--continue=true',
            '--file-allocation=none',
            '--seed-time=0',
            `--max-concurrent-downloads=${maxConcurrentDownloads}`,
            '--summary-interval=0',
            '--console-log-level=warn',
        ]
        // 会话文件存在才传 input-file，避免 aria2 报错退出
        if (fs.existsSync(sessionFile)) args.push(`--input-file=${sessionFile}`)
        child = spawn(ARIA2_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        // 只转发错误行：非 TTY 下 aria2 会周期性刷进度/状态与 tracker 警告，淹没服务日志；
        // daemon 启停异常由 exit 处理器兑底，进度信息前端已有权威链路（RPC 轮询）
        child.stdout.on('data', () => { /* 丢弃：常规输出无需入控制台 */ })
        child.stderr.on('data', (d) => { const s = String(d).trim(); if (s && /ERROR/.test(s)) console.error(`[aria2] ${s}`) })
        child.on('exit', (code) => {
            running = false
            if (!stopping && code !== 0 && code !== null) console.error(`[aria2] daemon 异常退出（code ${code}），离线下载暂不可用`)
            else console.log('[aria2] daemon 已退出')
            child = null
        })
    }

    /** 轮询 getVersion 直到 RPC 连通或超时 */
    async function waitForReady(timeoutMs) {
        const deadline = Date.now() + timeoutMs
        for (;;) {
            try {
                const v = await rpcCall('aria2.getVersion')
                return v
            } catch {
                if (Date.now() > deadline) return null
                await new Promise(r => setTimeout(r, 250))
            }
        }
    }

    /**
     * 启动（或复用）aria2 daemon。
     * 顺序：探测二进制 → 端口已有 RPC 则复用（提示会话持久化不归我们管）→ 否则拉起子进程并等待就绪。
     */
    async function start() {
        const det = detectAria2()
        if (!det.available) return { ok: false, reason: det.reason }
        fs.mkdirSync(downloadDir, { recursive: true })
        // 端口上已有 aria2：直接复用（可能是用户自起的 daemon 或上次残留）
        const existing = await rpcCall('aria2.getVersion').catch(() => null)
        if (existing) {
            running = true
            console.log(`[aria2] 复用端口 ${port} 上已运行的 daemon（version ${existing.version}）；若其未开启 --save-session，重启续传将不可用`)
            // 复用既存 daemon 时它带的是拉起方当时的参数，用 changeGlobalOption 把并发同步到本次配置
            //（max-concurrent-downloads 属于可运行时变更的全局选项；失败不阻断，仅提示差异）
            try {
                await rpcCall('aria2.changeGlobalOption', [{ maxConcurrentDownloads: String(maxConcurrentDownloads) }])
            } catch (e) {
                console.warn(`[aria2] 同步并发上限 ${maxConcurrentDownloads} 失败，沿用 daemon 现有值: ${e.message}`)
            }
            return { ok: true, version: existing.version, reused: true }
        }
        spawnDaemon()
        stopping = false
        const v = await waitForReady(ARIA2_RPC_READY_TIMEOUT_MS)
        if (!v) {
            stop()
            return { ok: false, reason: 'rpc_unreachable' }
        }
        running = true
        return { ok: true, version: v.version }
    }

    /** 关停（仅杀自己拉起的子进程；SIGTERM 触发 aria2 落盘会话） */
    function stop() {
        if (child) {
            stopping = true
            try { child.kill('SIGTERM') } catch { /* ignore */ }
            child = null
        }
        running = false
    }

    return { start, stop, isRunning, rpcCall, tellStatus }
}
