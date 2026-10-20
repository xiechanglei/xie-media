import {program} from "commander";
import {ARIA2_MAX_CONCURRENT_DOWNLOADS, ARIA2_SPLIT, ARIA2_MAX_CONNECTION_PER_SERVER, DEFAULT_APP_TITLE} from "./config.js";

/**
 * 解析命令行参数 --port --dir --title --max-downloads --split --max-connections 使用  commander 库
 * 端口有默认值，dir默认值是当前目录，title默认值为 DEFAULT_APP_TITLE，
 * max-downloads 默认值为 ARIA2_MAX_CONCURRENT_DOWNLOADS（离线下载同时进行的任务数上限），
 * split/max-connections 默认值为 ARIA2_SPLIT / ARIA2_MAX_CONNECTION_PER_SERVER（aria2 单任务分段与同源并发连接数）
 * @returns {Object} 解析后的参数对象
 * @returns {{port: number, dir: string, title: string, maxDownloads: number, split: number, maxConnections: number, sources: Object<string, 'default'|'cli'|'env'|'config'>}}
 */
export const resolveArgs = () => {
    program
        .option('--port <port>', 'Port to run the server on', 3000)
        .option('--dir <dir>', 'Directory to serve files from', process.cwd())
        .option('--title <title>', 'Application title (page title and banner)', DEFAULT_APP_TITLE)
        .option('--max-downloads <n>', 'Max concurrent offline download tasks (aria2 max-concurrent-downloads)', ARIA2_MAX_CONCURRENT_DOWNLOADS)
        .option('--split <n>', 'Max simultaneous connections per download task (aria2 split, 1-64)', ARIA2_SPLIT)
        .option('--max-connections <n>', 'Max connections to one server per task (aria2 max-connection-per-server, 1-16)', ARIA2_MAX_CONNECTION_PER_SERVER);

    program.parse(process.argv);

    const options = program.opts();

    // 非法值（非数字/越界）一律回退默认，避免 aria2 收到 0/NaN 或超上限参数直接拒启
    const clamp = (v, min, max, dft) => Math.min(max, Math.max(min, parseInt(v, 10) || dft));
    const maxConnections = clamp(options.maxConnections, 1, 16, ARIA2_MAX_CONNECTION_PER_SERVER);
    // aria2 硬性要求 split ≥ max-connection-per-server，否则启动即报错，静默抬到够用值
    const split = Math.max(clamp(options.split, 1, 64, ARIA2_SPLIT), maxConnections);

    return {
        port: parseInt(options.port, 10),
        dir: options.dir,
        title: (options.title || '').toString().trim() || DEFAULT_APP_TITLE,
        maxDownloads: Math.max(1, parseInt(options.maxDownloads, 10) || ARIA2_MAX_CONCURRENT_DOWNLOADS),
        split,
        maxConnections,
        // 记录每项参数的来源（default=未指定），启动横幅据此标注“默认”
        sources: {
            port: program.getOptionValueSource('port'),
            dir: program.getOptionValueSource('dir'),
            title: program.getOptionValueSource('title'),
            maxDownloads: program.getOptionValueSource('maxDownloads'),
            split: program.getOptionValueSource('split'),
            maxConnections: program.getOptionValueSource('maxConnections'),
        },
    };
}