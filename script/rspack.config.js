const path = require('path');
const fs = require('fs');
const rspack = require('@rspack/core');

const buildTs = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');

const metaDir = path.resolve(__dirname, '../server/public/script');
if (!fs.existsSync(metaDir)) {
  fs.mkdirSync(metaDir, { recursive: true });
}
fs.writeFileSync(
  path.join(metaDir, 'build-meta.json'),
  JSON.stringify({ buildTs }),
  'utf-8',
);

module.exports = {
  entry: './index.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'duko-filler.user.js',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
          },
        },
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    new rspack.DefinePlugin({
      __BUILD_TS__: JSON.stringify(buildTs),
    }),
  ],
};
