const path = require('path');
const rspack = require('@rspack/core');
const { createConfig, createBuildTimestamp } = require('./build-config.cjs');
const targets = require('./targets.json');

const buildTs = createBuildTimestamp();
const outputPath = path.resolve(__dirname, 'dist/manual');
const compiler = rspack(Object.values(targets).map((target) => createConfig(target, {
  buildTs,
  outputPath,
  metaFilename: `${target.id}.build-meta.json`,
})));

compiler.run((error, stats) => {
  compiler.close((closeError) => {
    if (error || closeError) {
      console.error(error || closeError);
      process.exitCode = 1;
      return;
    }
    console.log(stats.toString({ colors: false, modules: false, chunks: false }));
    if (stats.hasErrors()) process.exitCode = 1;
  });
});
