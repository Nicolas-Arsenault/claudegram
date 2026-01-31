/**
 * Telegram Bot Handler
 *
 * Implements the Telegram bot interface using AI clients (Claude Code or OpenAI Codex)
 * for clean, reliable communication without terminal parsing issues.
 */

import { Telegraf, Context } from 'telegraf';
import { Message } from 'telegraf/types';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as https from 'https';
import { exec } from 'child_process';

import { AIClient, ProgressEvent } from '../sdk/types';
import { ClaudeClient } from '../sdk/client';
import { CodexClient } from '../sdk/codex-client';
import { ScreenshotCapture } from '../screenshot/capture';
import { AccessControl } from '../security/access';
import { Config } from '../config';

/**
 * Creates the appropriate AI client based on configuration.
 */
function createAIClient(config: Config): AIClient {
  const idleTimeout = config.sessionIdleTimeoutMs;
  const workingDir = process.cwd();
  const systemPrompt = config.systemPromptFile;

  switch (config.aiBackend) {
    case 'codex':
      return new CodexClient(idleTimeout, workingDir, systemPrompt);
    case 'claude':
    default:
      return new ClaudeClient(idleTimeout, workingDir, systemPrompt);
  }
}

// Minimum interval between progress updates per chat (10 seconds)
const PROGRESS_THROTTLE_MS = 10000;

export class TelegramBot {
  private bot: Telegraf;
  private aiClient: AIClient;
  private screenshotCapture: ScreenshotCapture;
  private accessControl: AccessControl;
  private inputImageDir: string;
  private lastProgressUpdate: Map<number, number> = new Map();

  constructor(config: Config) {
    this.bot = new Telegraf(config.telegramBotToken);
    this.aiClient = createAIClient(config);
    this.screenshotCapture = new ScreenshotCapture(config.screenshotOutputDir);
    this.accessControl = new AccessControl(config.allowedUserIds);
    this.inputImageDir = config.inputImageDir;

    this.setupSessionCallbacks();
    this.setupHandlers();
  }

  /**
   * Sets up callbacks for session termination and progress updates.
   */
  private setupSessionCallbacks(): void {
    this.aiClient.setSessionEndCallback((chatId, reason) => {
      this.sendMessage(chatId, `Session ended: ${reason}`);
    });

    this.aiClient.setProgressCallback((chatId, event) => {
      this.sendProgressUpdate(chatId, event);
    });
  }

  /**
   * Sends a progress update to the user.
   * Throttled to avoid spamming - only sends if enough time has passed since last update.
   * Special events (user input, plan mode) are always sent immediately.
   */
  private async sendProgressUpdate(chatId: number, event: ProgressEvent): Promise<void> {
    const now = Date.now();
    const lastUpdate = this.lastProgressUpdate.get(chatId) || 0;

    // These event types should always be sent immediately (not throttled)
    const priorityEvents = ['user_input_needed', 'plan_start', 'plan_exit'];
    const isPriority = priorityEvents.includes(event.type);

    // Throttle updates to avoid spam (except for priority events and "still working" which are already time-gated)
    if (!isPriority && event.type !== 'working' && now - lastUpdate < PROGRESS_THROTTLE_MS) {
      return;
    }

    this.lastProgressUpdate.set(chatId, now);

    try {
      // Handle special event types with custom formatting
      if (event.type === 'user_input_needed' && event.questions) {
        await this.sendUserInputRequest(chatId, event.questions);
        return;
      }

      if (event.type === 'plan_start') {
        await this.bot.telegram.sendMessage(
          chatId,
          '📋 *Entering Plan Mode*\n\nClaude is planning the implementation. You\'ll see the plan before execution.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (event.type === 'plan_exit') {
        await this.bot.telegram.sendMessage(
          chatId,
          '✅ *Plan Approved*\n\nProceeding with implementation...',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (event.type === 'task_update' && event.taskInfo) {
        const icon = event.taskInfo.action === 'create' ? '📝' :
                     event.taskInfo.action === 'update' ? '✏️' : '📋';
        await this.bot.telegram.sendMessage(chatId, `${icon} ${event.message}`);
        return;
      }

      // Standard progress events
      const icon = event.type === 'tool_use' ? '🔧' :
                   event.type === 'thinking' ? '💭' :
                   '⏳';

      await this.bot.telegram.sendMessage(chatId, `${icon} ${event.message}`);
    } catch (error) {
      console.error(`Failed to send progress update to ${chatId}:`, error);
    }
  }

  /**
   * Sends a formatted user input request to Telegram.
   */
  private async sendUserInputRequest(
    chatId: number,
    questions: { question: string; options: { label: string; description?: string }[] }[]
  ): Promise<void> {
    for (const q of questions) {
      let message = `❓ *Claude needs your input:*\n\n${q.question}\n\n`;

      if (q.options.length > 0) {
        message += '*Options:*\n';
        for (let i = 0; i < q.options.length; i++) {
          const opt = q.options[i];
          message += `${i + 1}. *${opt.label}*`;
          if (opt.description) {
            message += ` - ${opt.description}`;
          }
          message += '\n';
        }
        message += '\n_Reply with your choice or type a custom response._';
      }

      try {
        await this.bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch {
        // Fall back to plain text if Markdown fails
        await this.bot.telegram.sendMessage(chatId, message.replace(/[*_]/g, ''));
      }
    }
  }

  /**
   * Sends a message to a Telegram chat, handling message length limits.
   * Attempts to parse as Markdown, falls back to plain text if it fails.
   */
  private async sendMessage(chatId: number, text: string): Promise<void> {
    const MAX_MESSAGE_LENGTH = 4096;

    const sendChunk = async (chunk: string) => {
      try {
        // Try sending with Markdown parsing
        await this.bot.telegram.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
      } catch {
        // Fall back to plain text if Markdown parsing fails
        await this.bot.telegram.sendMessage(chatId, chunk);
      }
    };

    try {
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await sendChunk(text);
      } else {
        const chunks = this.splitMessage(text, MAX_MESSAGE_LENGTH);
        for (const chunk of chunks) {
          await sendChunk(chunk);
        }
      }
    } catch (error) {
      console.error(`Failed to send message to ${chatId}:`, error);
    }
  }

  /**
   * Splits a message into chunks, preferring line boundaries.
   */
  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = maxLength;
      }

      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).replace(/^\n/, '');
    }

    return chunks;
  }

  /**
   * Sets up Telegram bot command and message handlers.
   */
  private setupHandlers(): void {
    // Access control middleware
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.accessControl.isAuthorized(userId)) {
        console.log(`Unauthorized access attempt from user ${userId}`);
        return;
      }
      return next();
    });

    // Handle /start command
    this.bot.command('start', async (ctx) => {
      const chatId = ctx.chat.id;

      if (this.aiClient.hasSession(chatId)) {
        await ctx.reply(
          'Claude session already active.\n\n' +
          'Use /kill to terminate and /start again for a fresh session.'
        );
        return;
      }

      this.aiClient.createSession(chatId);
      await ctx.reply(
        'Starting new Claude Code session...\n\n' +
        'This is a fresh session with no previous context.\n\n' +
        'Commands:\n' +
        '  /screenshot - List available displays\n' +
        '  /screenshot <n> - Capture display n\n' +
        '  /interrupt - Stop current operation (keeps session)\n' +
        '  /kill - Terminate current session\n' +
        '  /status - Check session status\n' +
        '  /cmd <command> - Execute shell command directly\n\n' +
        'All other messages are sent to Claude Code.'
      );
    });

    // Handle /screenshot command
    this.bot.command('screenshot', async (ctx) => {
      await this.handleScreenshot(ctx);
    });

    // Handle /kill command
    this.bot.command('kill', async (ctx) => {
      const chatId = ctx.chat.id;
      if (this.aiClient.killSession(chatId)) {
        await ctx.reply(
          'Claude session terminated.\n\n' +
          'Use /start to begin a new session.'
        );
      } else {
        await ctx.reply('No active session to terminate.');
      }
    });

    // Handle /interrupt command
    this.bot.command('interrupt', async (ctx) => {
      const chatId = ctx.chat.id;
      if (this.aiClient.interruptProcess(chatId)) {
        await ctx.reply(
          '⚡ Interrupt signal sent.\n\n' +
          'The current operation will be stopped. Session remains active.'
        );
      } else {
        await ctx.reply(
          'Nothing to interrupt.\n\n' +
          'No operation is currently running.'
        );
      }
    });

    // Handle /status command
    this.bot.command('status', async (ctx) => {
      const chatId = ctx.chat.id;
      if (this.aiClient.hasSession(chatId)) {
        await ctx.reply(
          'Session active.\n\n' +
          'Claude Code is ready to receive messages.'
        );
      } else {
        await ctx.reply(
          'No active session.\n\n' +
          'Use /start to begin a new Claude Code session.'
        );
      }
    });

    // Handle /cmd command - execute shell commands directly
    this.bot.command('cmd', async (ctx) => {
      const message = ctx.message as Message.TextMessage;
      const text = message.text;
      const chatId = ctx.chat.id;

      const cmdMatch = text.match(/^\/cmd\s+(.+)$/s);
      if (!cmdMatch) {
        await ctx.reply('Usage: /cmd <command>\n\nExample: /cmd ls -la');
        return;
      }

      const command = cmdMatch[1];
      await ctx.reply(`Executing: ${command}`);

      exec(command, { maxBuffer: 10 * 1024 * 1024 }, async (error, stdout, stderr) => {
        const parts: string[] = [];

        if (stdout) {
          parts.push(`stdout:\n${stdout}`);
        }

        if (stderr) {
          parts.push(`stderr:\n${stderr}`);
        }

        const exitCode = error ? error.code ?? 1 : 0;
        parts.push(`Exit code: ${exitCode}`);

        const output = parts.join('\n\n');
        await this.sendMessage(chatId, output || 'Command completed with no output.');
      });
    });

    // Handle photos
    this.bot.on('photo', async (ctx) => {
      await this.handleImage(ctx, 'photo');
    });

    // Handle documents (for images sent as files)
    this.bot.on('document', async (ctx) => {
      const doc = ctx.message.document;
      if (doc.mime_type?.startsWith('image/')) {
        await this.handleImage(ctx, 'document');
      } else {
        await ctx.reply('Only image documents are supported.');
      }
    });

    // Handle all other text messages
    this.bot.on('text', async (ctx) => {
      await this.handleTextMessage(ctx);
    });
  }

  /**
   * Handles /screenshot command.
   */
  private async handleScreenshot(ctx: Context): Promise<void> {
    const message = ctx.message as Message.TextMessage;
    const text = message.text;

    const parts = text.split(/\s+/);
    const indexArg = parts[1];

    if (!indexArg) {
      try {
        const displays = await this.screenshotCapture.listDisplays();
        const formatted = this.screenshotCapture.formatDisplayList(displays);
        await ctx.reply(formatted);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        await ctx.reply(`Failed to list displays: ${errMsg}`);
      }
    } else {
      const displayIndex = parseInt(indexArg, 10);
      if (isNaN(displayIndex) || displayIndex < 1) {
        await ctx.reply('Invalid display index. Use a positive integer.');
        return;
      }

      await ctx.reply(`Capturing display ${displayIndex}...`);

      const result = await this.screenshotCapture.captureDisplay(displayIndex);
      if (result.success && result.filePath) {
        try {
          await ctx.replyWithPhoto({ source: result.filePath });
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          await ctx.reply(`Failed to send screenshot: ${errMsg}`);
        }
      } else {
        await ctx.reply(result.error || 'Failed to capture screenshot.');
      }
    }
  }

  /**
   * Handles image messages.
   */
  private async handleImage(
    ctx: Context,
    type: 'photo' | 'document'
  ): Promise<void> {
    const chatId = ctx.chat!.id;
    const message = ctx.message as Message.PhotoMessage | Message.DocumentMessage;

    let fileId: string;
    let extension = 'png';

    if (type === 'photo') {
      const photos = (message as Message.PhotoMessage).photo;
      fileId = photos[photos.length - 1].file_id;
    } else {
      const doc = (message as Message.DocumentMessage).document;
      fileId = doc.file_id;
      if (doc.file_name) {
        const ext = path.extname(doc.file_name).slice(1);
        if (ext) extension = ext;
      }
    }

    try {
      await fs.mkdir(this.inputImageDir, { recursive: true });

      const file = await ctx.telegram.getFile(fileId);
      if (!file.file_path) {
        await ctx.reply('Failed to get file path from Telegram.');
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `image-${timestamp}.${extension}`;
      const localPath = path.join(this.inputImageDir, filename);

      const fileUrl = `https://api.telegram.org/file/bot${this.bot.telegram.token}/${file.file_path}`;
      await this.downloadFile(fileUrl, localPath);

      if (!this.aiClient.hasSession(chatId)) {
        await ctx.reply(
          'Image saved, but no active Claude session.\n\n' +
          'Use /start to begin a session, then send the image again.'
        );
        return;
      }

      const caption = (message as any).caption || undefined;
      await ctx.reply('🖼️ Image saved. Processing...');

      // Process in background to avoid Telegraf timeout
      this.aiClient.sendImage(chatId, localPath, caption)
        .then(async (response) => {
          if (response.success) {
            await this.sendMessage(chatId, response.output);
          } else {
            await this.sendMessage(chatId, `❌ Error: ${response.error || 'Unknown error'}`);
          }
        })
        .catch((error) => {
          const errMsg = error instanceof Error ? error.message : String(error);
          this.sendMessage(chatId, `❌ Error processing image: ${errMsg}`);
        });

      return; // Return immediately, processing continues in background
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Failed to process image: ${errMsg}`);
    }
  }

  /**
   * Downloads a file from a URL to a local path.
   */
  private downloadFile(url: string, localPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = require('fs').createWriteStream(localPath);

      file.on('error', (err: Error) => {
        file.destroy();
        require('fs').unlink(localPath, () => {});
        reject(err);
      });

      https.get(url, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        file.destroy();
        require('fs').unlink(localPath, () => {});
        reject(err);
      });
    });
  }

  /**
   * Handles text messages - sends to Claude via SDK.
   * Processing is done in the background to avoid Telegraf's 90s handler timeout.
   */
  private async handleTextMessage(ctx: Context): Promise<void> {
    const message = ctx.message as Message.TextMessage;
    const chatId = ctx.chat!.id;
    const text = message.text;

    if (!this.aiClient.hasSession(chatId)) {
      await ctx.reply(
        'No active Claude session.\n\n' +
        'Use /start to begin a new session.'
      );
      return;
    }

    // Acknowledge immediately to avoid Telegraf timeout
    await ctx.reply('🚀 Working on it...');

    // Process in background - don't await, let Telegraf return immediately
    this.processClaudeMessage(chatId, text).catch((error) => {
      console.error(`Background processing error for chat ${chatId}:`, error);
      this.sendMessage(chatId, `Error: ${error.message || 'Unknown error'}`);
    });
  }

  /**
   * Processes a Claude message in the background.
   * This allows long-running tasks without blocking Telegraf's update handler.
   */
  private async processClaudeMessage(chatId: number, text: string): Promise<void> {
    const response = await this.aiClient.sendMessage(chatId, text);

    if (response.success) {
      if (response.output) {
        await this.sendMessage(chatId, response.output);
      } else {
        await this.sendMessage(chatId, '✅ Task completed with no text output.');
      }
    } else {
      const errorMsg = response.error || 'Unknown error occurred';
      await this.sendMessage(chatId, `❌ Error: ${errorMsg}`);
      if (response.output) {
        await this.sendMessage(chatId, response.output);
      }
    }
  }

  /**
   * Starts the Telegram bot.
   */
  async start(): Promise<void> {
    console.log('Starting Telegram bot...');
    await this.bot.launch();
    console.log('Telegram bot started.');
  }

  /**
   * Stops the Telegram bot and cleans up sessions.
   */
  async stop(): Promise<void> {
    console.log('Stopping Telegram bot...');
    this.aiClient.shutdown();
    this.bot.stop('SIGTERM');
    console.log('Telegram bot stopped.');
  }
}
