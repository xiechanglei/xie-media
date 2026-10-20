// 磁盘文件通用小工具：流式 md5 / 移动文件（scanner 与离线下载入库共用）
import * as fs from 'node:fs'
import * as path from 'node:path'
import crypto from 'node:crypto'

/** 流式计算文件 md5（不整读内存） */
export function fileMd5Streaming(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5')
        const rs = fs.createReadStream(filePath)
        rs.on('error', reject)
        rs.on('data', (d) => hash.update(d))
        rs.on('end', () => resolve(hash.digest('hex')))
    })
}

/** 移动文件：同盘 rename 快路径，跨盘（EXDEV）降级 copy+unlink */
export function moveFile(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    try {
        fs.renameSync(src, dest)
    } catch (e) {
        if (e.code === 'EXDEV') {
            fs.copyFileSync(src, dest)
            fs.unlinkSync(src)
        } else {
            throw e
        }
    }
}

/** 递归收集目录下全部文件（返回绝对路径），跳过隐藏项 */
export function walkFiles(dir) {
    const out = []
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
    for (const ent of entries) {
        if (ent.name.startsWith('.')) continue
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) out.push(...walkFiles(full))
        else out.push(full)
    }
    return out
}
