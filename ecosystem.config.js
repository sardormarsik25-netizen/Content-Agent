module.exports = {
  apps: [
    {
      name: "content-agent-bot",
      script: "src/telegram-bot.ts",
      interpreter: "node",
      interpreter_args: "--experimental-strip-types",
      env: {
        NODE_ENV: "production",
      },
      // Auto-restart configuration
      watch: false,
      max_restarts: 10,
      min_uptime: "10s",
      max_memory_restart: "500M",
      // Restart delay with exponential backoff
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      // Logging
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      out_file: "./logs/bot-out.log",
      error_file: "./logs/bot-error.log",
      combine_logs: true,
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 10000,
      // Prevent multiple instances
      instances: 1,
      exec_mode: "fork",
    },
  ],
};