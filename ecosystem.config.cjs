module.exports = {
  apps: [{
    name: 'duko-advance',
    script: 'dist/index.js',
    cwd: './server',
    env: {
      NODE_ENV: 'production',
      PORT: 3023,
    },
  }],
};
