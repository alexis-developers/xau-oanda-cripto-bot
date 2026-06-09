// PM2 config — .cjs obrigatório em projetos ESM (type: "module")
module.exports = {
  apps: [
    {
      name:        'xau-oanda-bot',
      script:      'src/robot.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production'
      },
      restart_delay:    5000,
      max_restarts:     10,
      error_file:       'logs/err.log',
      out_file:         'logs/out.log',
      merge_logs:       true,
      log_date_format:  'YYYY-MM-DD HH:mm:ss'
    }
  ]
};
