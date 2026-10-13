// 发布专用：手动测试构建不调用此文件。
const fs = require('fs');
const path = require('path');

const srcDir = path.resolve(__dirname, 'dist');
const destDir = path.resolve(__dirname, '../server/public/script');
const files = ['duko-filler.user.js', 'build-meta.json'];
for (const filename of files) {
  if (!fs.existsSync(path.join(srcDir, filename))) {
    throw new Error(`${filename} not found. Did rspack build succeed?`);
  }
}
fs.mkdirSync(destDir, { recursive: true });
for (const filename of files) fs.copyFileSync(path.join(srcDir, filename), path.join(destDir, filename));
console.log('Published sales userscript and build metadata to server/public/script/');
