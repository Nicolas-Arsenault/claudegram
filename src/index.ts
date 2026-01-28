#!/usr/bin/env node

/**
 * Claudegram - Main Entry Point
 *
 * Control Claude Code from Telegram with full PTY terminal support.
 *
 * Usage:
 *   claudegram
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN - Required: Telegram bot API token
 *   ALLOWED_USER_IDS   - Required: Comma-separated list of allowed Telegram user IDs
 *   SCREENSHOT_OUTPUT_DIR - Optional: Directory for screenshots (default: ./screenshots)
 *   INPUT_IMAGE_DIR    - Optional: Directory for received images (default: ./inputs)
 *   SESSION_IDLE_TIMEOUT_MS - Optional: Idle timeout in ms (default: 1800000 / 30 min)
 */

import { loadConfig } from './config';
import { TelegramBot } from './telegram/bot';

async function main(): Promise<void> {
  console.log('Claudegram');
  console.log('==========\n');

  // Load configuration
  let config;
  try {
    config = loadConfig();
    console.log('Configuration loaded successfully.');
    console.log(`  Allowed users: ${config.allowedUserIds.join(', ')}`);
    console.log(`  Screenshot dir: ${config.screenshotOutputDir}`);
    console.log(`  Input image dir: ${config.inputImageDir}`);
    console.log(`  Idle timeout: ${config.sessionIdleTimeoutMs}ms\n`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`Configuration error: ${errMsg}`);
    console.error('\nRequired environment variables:');
    console.error('  TELEGRAM_BOT_TOKEN=<your-bot-token>');
    console.error('  ALLOWED_USER_IDS=<comma-separated-user-ids>');
    process.exit(1);
  }

  // Create and start the bot
  const bot = new TelegramBot(config);

  // Handle shutdown signals
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start the bot
  try {
    await bot.start();
    console.log('\nBridge is running. Press Ctrl+C to stop.\n');
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start bot: ${errMsg}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
