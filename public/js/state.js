// 全局共享状态：唯一可变单例，各模块 import 后直接读写对应字段
export const state = {
    // 列表
    scope: 'mine',
    page: 0, pageSize: 24, keyword: '',
    total: 0, list: [], hasMore: true, loading: false,
    listDirty: false,        // 详情页发生变更后置 true，返回列表时重新拉取
    // 用户
    user: null,
    // 视图
    view: 'list',           // 'list' | 'detail'
    // 详情
    detail: null,           // 后端返回的 collection 数据
    viewMode: 'grid',       // 'list' | 'grid'：当前生效的浏览模式
    detailCurrentIdx: 0,    // 视频集当前播放索引
    itemEditor: null,       // { [itemId]: { name, deleted } } — 仅编辑态使用
    itemEditorOpen: false,
    itemAppending: false,
    itemEditorOrder0: '',   // 编辑开局顺序快照，退出时比对是否拖过序
    // 多选合并（仅列表页·我的）
    selectMode: false,
    selected: new Set(),    // Set<String(collectionId)>
    // 专辑：scope='albums' 为目录页，scope='album' + albumId 为内页
    albumId: null,
    albumHead: null,        // 当前专辑头部信息 { title, entryCount, invisibleCount }
    // 离线下载（aria2）
    offlineEnabled: false,
    offlineTimer: null,     // 任务列表轮询定时器（仅在 offline 视图运行）
    offlineTasks: [],
    dlIngestId: null,
}
