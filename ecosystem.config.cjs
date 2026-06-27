module.exports = {
  apps: [{
    name: 'duko-chat',
    script: 'dist/index.js',
    cwd: './server',
    env: {
      NODE_ENV: 'production',
      PORT: 3021,
    },
  }],
};
