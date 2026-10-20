import {program} from "commander";
import {ARIA2_MAX_CONCURRENT_DOWNLOADS, DEFAULT_APP_TITLE} from "./config.js";

/**
 * 解析命令行参数 --port --dir --title --max-downloads 使用  commander 库
 * 端口有默认值，dir默认值是当前目录，title默认值为 DEFAULT_APP_TITLE，
 * max-downloads 默认值为 ARIA2_MAX_CONCURRENT_DOWNLOADS（离线下载同时进行的任务数上限）
 * @returns {Object} 解析后的参数对象
 * @returns {{port: number, dir: string, title: string, maxDownloads: number, sources: Object<string, 'default'|'cli'|'env'|'config'>}}
 */
export const resolveArgs = () => {
    program
        .option('--port <port>', 'Port to run the server on', 3000)
        .option('--dir <dir>', 'Directory to serve files from', process.cwd())
        .option('--title <title>', 'Application title (page title and banner)', DEFAULT_APP_TITLE)
        .option('--max-downloads <n>', 'Max concurrent offline download tasks (aria2 max-concurrent-downloads)', ARIA2_MAX_CONCURRENT_DOWNLOADS);

    program.parse(process.argv);

    const options = program.opts();

    return {
        port: parseInt(options.port, 10),
        dir: options.dir,
        title: (options.title || '').toString().trim() || DEFAULT_APP_TITLE,
        // 非法值（非数字/小于 1）一律回退默认，避免 aria2 收到 0 或 NaN 参数
        maxDownloads: Math.max(1, parseInt(options.maxDownloads, 10) || ARIA2_MAX_CONCURRENT_DOWNLOADS),
        // 记录每项参数的来源（default=未指定），启动横幅据此标注“默认”
        sources: {
            port: program.getOptionValueSource('port'),
            dir: program.getOptionValueSource('dir'),
            title: program.getOptionValueSource('title'),
            maxDownloads: program.getOptionValueSource('maxDownloads'),
        },
    };
}