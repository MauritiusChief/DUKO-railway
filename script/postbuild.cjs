// postbuild script：为 rspack 产物注入 Tampermonkey/ScriptCat 元数据头，并复制到 server/public/script/
const fs = require('fs');
const path = require('path');

let buildTs = 'unknown';
const metaPath = path.resolve(__dirname, '../server/public/script/build-meta.json');
if (fs.existsSync(metaPath)) {
  try {
    const metaJson = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    buildTs = metaJson.buildTs || 'unknown';
  } catch {}
}

const meta = `// ==UserScript==
// @name         DUKO Quote Filler ${buildTs}
// @namespace    https://dukouserp.com
// @version      ${buildTs}
// @description  在 Odoo quotation 页面通过粘贴 CSV 清单一键填入产品行
// @author       DUKO
// @match        https://dukouserp.com/odoo/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==
`;

const srcPath = path.resolve(__dirname, 'dist/duko-filler.user.js');

if (!fs.existsSync(srcPath)) {
  console.error('dist/duko-filler.user.js not found. Did rspack build succeed?');
  process.exit(1);
}

let content = fs.readFileSync(srcPath, 'utf-8');
content = meta + '\n' + content;

// Write back to dist/
fs.writeFileSync(srcPath, content, 'utf-8');
console.log('Prepended userscript metadata header');

// Copy to server/public/script/
const destDir = path.resolve(__dirname, '../server/public/script');
if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}
fs.copyFileSync(srcPath, path.join(destDir, 'duko-filler.user.js'));
console.log('Copied to server/public/script/');
