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
 * - AI_BACKEND: AI backend to use - 'claude' or 'codex' (default: 'claude')
 * - SCREENSHOT_OUTPUT_DIR: Directory for screenshots (default: ./screenshots)
 * - INPUT_IMAGE_DIR: Directory for received images (default: ./inputs)
 * - SESSION_IDLE_TIMEOUT_MS: Idle timeout in ms (default: 3 hours)
 */

import * as path from 'path';

/**
 * Supported AI backends.
 */
export type AIBackend = 'claude' | 'codex';

export interface Config {
  telegramBotToken: string;
  allowedUserIds: number[];
  aiBackend: AIBackend;
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

  // Parse AI backend selection (default: claude)
  const aiBackendStr = process.env.AI_BACKEND?.toLowerCase() || 'claude';
  if (aiBackendStr !== 'claude' && aiBackendStr !== 'codex') {
    throw new Error(`Invalid AI_BACKEND: ${aiBackendStr}. Must be 'claude' or 'codex'`);
  }
  const aiBackend: AIBackend = aiBackendStr;

  // Use __dirname to resolve relative to the package, not cwd
  const packageRoot = path.resolve(__dirname, '..');

  const screenshotOutputDir = process.env.SCREENSHOT_OUTPUT_DIR
    ? path.resolve(process.env.SCREENSHOT_OUTPUT_DIR)
    : path.join(packageRoot, 'screenshots');
  const inputImageDir = process.env.INPUT_IMAGE_DIR
    ? path.resolve(process.env.INPUT_IMAGE_DIR)
    : path.join(packageRoot, 'inputs');

  // Default idle timeout: 3 hours
  const sessionIdleTimeoutMs = parseInt(
    process.env.SESSION_IDLE_TIMEOUT_MS || '10800000',
    10
  );

  // System prompt file - defaults to CLAUDE_PROMPT.md in the package root
  const defaultPromptFile = path.join(packageRoot, 'CLAUDE_PROMPT.md');
  let systemPromptFile: string | null = process.env.SYSTEM_PROMPT_FILE
    ? path.resolve(process.env.SYSTEM_PROMPT_FILE)
    : defaultPromptFile;

  // Check if the file exists, set to null if not
  try {
    require('fs').accessSync(systemPromptFile, require('fs').constants.R_OK);
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
    aiBackend,
    screenshotOutputDir,
    inputImageDir,
    sessionIdleTimeoutMs,
    systemPromptFile,
  };
}
