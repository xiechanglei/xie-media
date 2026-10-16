import {program} from "commander";
import {DEFAULT_APP_TITLE} from "./config.js";

/**
 * 解析命令行参数 --port --dir --title 使用  commander 库
 * 端口有默认值，dir默认值是当前目录，title默认值为 DEFAULT_APP_TITLE
 * @returns {Object} 解析后的参数对象
 * @returns {{port: number, dir: string, title: string}}
 */
export const resolveArgs = () => {
    program
        .option('--port <port>', 'Port to run the server on', 3000)
        .option('--dir <dir>', 'Directory to serve files from', process.cwd())
        .option('--title <title>', 'Application title (page title and banner)', DEFAULT_APP_TITLE);

    program.parse(process.argv);

    const options = program.opts();

    return {
        port: parseInt(options.port, 10),
        dir: options.dir,
        title: (options.title || '').toString().trim() || DEFAULT_APP_TITLE,
    };
}