const { createConfig } = require('./build-config.cjs');
const targets = require('./targets.json');

// 发布入口继续使用现有下载文件名。生产复制仅在 postbuild 中发生。
module.exports = createConfig(targets.sales, { filename: 'duko-filler.user.js' });
