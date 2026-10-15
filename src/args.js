import {program} from "commander";

/**
 * 解析命令行参数 --port --dir 使用  commander 库
 * 端口有默认值，dir默认值是当前目录
 * @returns {Object} 解析后的参数对象
 * @returns {{port: number, dir: string}}
 */
export const resolveArgs = () => {
    program
        .option('--port <port>', 'Port to run the server on', 3000)
        .option('--dir <dir>', 'Directory to serve files from', process.cwd());

    program.parse(process.argv);

    const options = program.opts();

    return {
        port: parseInt(options.port, 10),
        dir: options.dir,
    };
}