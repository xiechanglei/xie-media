// users.json 只读访问：文件由 xie-auth 负责写入，本模块只读取，用于
// - scan 自动入库时找归属 admin（scanner.js）
// - 送人（转移所有权）时列出/校验可接收的用户（media.js）
import * as fs from 'node:fs'

/** 读取 users.json 的用户数组；文件缺失或损坏时返回空数组 */
export function readUsers(usersFile) {
    try {
        const data = JSON.parse(fs.readFileSync(usersFile, 'utf8'))
        return Array.isArray(data.users) ? data.users : []
    } catch {
        return []
    }
}

/** 可用用户（status==='active'）；excludeId 用于排除自己 */
export function listActiveUsers(usersFile, excludeId) {
    return readUsers(usersFile)
        .filter((u) => u && u.status === 'active' && u.id !== excludeId)
        .map((u) => ({ id: u.id, username: u.username, role: u.role }))
}

/** 取第一个 active 的 admin（无 active 则退而取任意 admin）；没有则返回 null */
export function findAdmin(usersFile) {
    const users = readUsers(usersFile)
    const admin =
        users.find((u) => u.role === 'admin' && u.status === 'active') ||
        users.find((u) => u.role === 'admin')
    return admin ? { id: admin.id, username: admin.username } : null
}

/** 按 id 取一个可接收资源的用户（不存在 / 非 active / 与 excludeId 相同则返回 null） */
export function findActiveUser(usersFile, userId, excludeId) {
    if (!userId || userId === excludeId) return null
    const u = readUsers(usersFile).find((x) => x.id === userId && x.status === 'active')
    return u ? { id: u.id, username: u.username } : null
}
