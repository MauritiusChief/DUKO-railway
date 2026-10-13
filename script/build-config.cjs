const path = require('path');
const rspack = require('@rspack/core');

function createBuildTimestamp() {
  return new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
}

function userscriptHeader(target, buildTs) {
  return `// ==UserScript==
// @name         ${target.name}
// @namespace    https://dukouserp.com
// @version      ${buildTs}
// @description  在 Odoo ${target.id} 页面通过粘贴 CSV 填入产品行
// @author       DUKO
// @match        https://dukouserp.com${target.path}
// @match        https://dukouserp.com${target.path}/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==`;
}

/** 纯配置工厂：加载配置不创建目录、不写入生产文件。 */
function createConfig(target, options = {}) {
  const buildTs = options.buildTs ?? createBuildTimestamp();
  return {
    name: target.id,
    mode: 'production',
    context: __dirname,
    entry: './index.ts',
    output: {
      path: options.outputPath ?? path.resolve(__dirname, 'dist'),
      filename: options.filename ?? target.filename,
    },
    resolve: { extensions: ['.ts', '.js'] },
    module: {
      rules: [{
        test: /\.ts$/,
        use: { loader: 'ts-loader', options: { transpileOnly: true } },
        exclude: /node_modules/,
      }],
    },
    plugins: [
      new rspack.DefinePlugin({
        __BUILD_TS__: JSON.stringify(buildTs),
        __ODOO_TARGET__: JSON.stringify(target),
      }),
      new rspack.BannerPlugin({
        banner: userscriptHeader(target, buildTs),
        raw: true,
        entryOnly: true,
        // 原始行注释必须在压缩之后加入，否则 metadata 会被压缩器移除。
        stage: rspack.Compilation.PROCESS_ASSETS_STAGE_REPORT,
      }),
      {
        apply(compiler) {
          compiler.hooks.thisCompilation.tap('BuildMetadata', (compilation) => {
            compilation.hooks.processAssets.tap({
              name: 'BuildMetadata',
              stage: rspack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
            }, () => {
              compilation.emitAsset(options.metaFilename ?? 'build-meta.json',
                new rspack.sources.RawSource(JSON.stringify({ buildTs, target: target.id })));
            });
          });
        },
      },
    ],
  };
}

module.exports = { createConfig, createBuildTimestamp, userscriptHeader };
