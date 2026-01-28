/**
 * Configuration module for Claude Telegram Bridge
 *
 * Loads configuration from environment variables as specified in project.md Section 11.
 *
 * Required environment variables:
 * - TELEGRAM_BOT_TOKEN: Telegram bot API token
 * - ALLOWED_USER_IDS: Comma-separated list of allowed Telegram user IDs
 *
 * Optional environment variables:
 * - SCREENSHOT_OUTPUT_DIR: Directory for screenshots (default: ./screenshots)
 * - INPUT_IMAGE_DIR: Directory for received images (default: ./inputs)
 * - SESSION_IDLE_TIMEOUT_MS: Idle timeout in ms (default: 3 hours)
 */

import * as path from 'path';

export interface Config {
  telegramBotToken: string;
  allowedUserIds: number[];
  screenshotOutputDir: string;
  inputImageDir: string;
  sessionIdleTimeoutMs: number;
  systemPromptFile: string | null;
}

/**
 * Loads and validates configuration from environment variables.
 * Throws an error if required variables are missing.
 */
export function loadConfig(): Config {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
  }

  const allowedUserIdsStr = process.env.ALLOWED_USER_IDS;
  if (!allowedUserIdsStr) {
    throw new Error('ALLOWED_USER_IDS environment variable is required');
  }

  const allowedUserIds = allowedUserIdsStr
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0)
    .map(id => {
      const parsed = parseInt(id, 10);
      if (isNaN(parsed)) {
        throw new Error(`Invalid user ID in ALLOWED_USER_IDS: ${id}`);
      }
      return parsed;
    });

  if (allowedUserIds.length === 0) {
    throw new Error('ALLOWED_USER_IDS must contain at least one user ID');
  }

  const screenshotOutputDir = process.env.SCREENSHOT_OUTPUT_DIR || './screenshots';
  const inputImageDir = process.env.INPUT_IMAGE_DIR || './inputs';

  // Default idle timeout: 3 hours
  const sessionIdleTimeoutMs = parseInt(
    process.env.SESSION_IDLE_TIMEOUT_MS || '10800000',
    10
  );

  // System prompt file - defaults to CLAUDE_PROMPT.md if it exists
  const defaultPromptFile = './CLAUDE_PROMPT.md';
  let systemPromptFile: string | null = process.env.SYSTEM_PROMPT_FILE || defaultPromptFile;

  // Check if the file exists, set to null if not
  try {
    require('fs').accessSync(path.resolve(systemPromptFile), require('fs').constants.R_OK);
    systemPromptFile = path.resolve(systemPromptFile);
  } catch {
    if (process.env.SYSTEM_PROMPT_FILE) {
      // User explicitly set a file that doesn't exist - warn but continue
      console.warn(`Warning: SYSTEM_PROMPT_FILE '${systemPromptFile}' not found, running without system prompt`);
    }
    systemPromptFile = null;
  }

  return {
    telegramBotToken,
    allowedUserIds,
    screenshotOutputDir: path.resolve(screenshotOutputDir),
    inputImageDir: path.resolve(inputImageDir),
    sessionIdleTimeoutMs,
    systemPromptFile,
  };
}
