/**
 * Telegram Bot Handler
 *
 * Implements the Telegram bot interface using the Claude Code SDK
 * for clean, reliable communication without terminal parsing issues.
 */

import { Telegraf, Context } from 'telegraf';
import { Message } from 'telegraf/types';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as https from 'https';
import { exec } from 'child_process';

import { ClaudeClient } from '../sdk/client';
import { ScreenshotCapture } from '../screenshot/capture';
import { AccessControl } from '../security/access';
import { Config } from '../config';

export class TelegramBot {
  private bot: Telegraf;
  private claudeClient: ClaudeClient;
  private screenshotCapture: ScreenshotCapture;
  private accessControl: AccessControl;
  private inputImageDir: string;

  constructor(config: Config) {
    this.bot = new Telegraf(config.telegramBotToken);
    this.claudeClient = new ClaudeClient(config.sessionIdleTimeoutMs);
    this.screenshotCapture = new ScreenshotCapture(config.screenshotOutputDir);
    this.accessControl = new AccessControl(config.allowedUserIds);
    this.inputImageDir = config.inputImageDir;

    this.setupSessionCallbacks();
    this.setupHandlers();
  }

  /**
   * Sets up callbacks for session termination.
   */
  private setupSessionCallbacks(): void {
    this.claudeClient.setSessionEndCallback((chatId, reason) => {
      this.sendMessage(chatId, `Session ended: ${reason}`);
    });
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

      if (this.claudeClient.hasSession(chatId)) {
        await ctx.reply(
          'Claude session already active.\n\n' +
          'Use /kill to terminate and /start again for a fresh session.'
        );
        return;
      }

      this.claudeClient.createSession(chatId);
      await ctx.reply(
        'Starting new Claude Code session...\n\n' +
        'This is a fresh session with no previous context.\n\n' +
        'Commands:\n' +
        '  /screenshot - List available displays\n' +
        '  /screenshot <n> - Capture display n\n' +
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
      if (this.claudeClient.killSession(chatId)) {
        await ctx.reply(
          'Claude session terminated.\n\n' +
          'Use /start to begin a new session.'
        );
      } else {
        await ctx.reply('No active session to terminate.');
      }
    });

    // Handle /status command
    this.bot.command('status', async (ctx) => {
      const chatId = ctx.chat.id;
      if (this.claudeClient.hasSession(chatId)) {
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

      if (!this.claudeClient.hasSession(chatId)) {
        await ctx.reply(
          'Image saved, but no active Claude session.\n\n' +
          'Use /start to begin a session, then send the image again.'
        );
        return;
      }

      const caption = (message as any).caption || undefined;
      await ctx.reply('Image saved. Sending to Claude...');

      const response = await this.claudeClient.sendImage(chatId, localPath, caption);

      if (response.success) {
        await this.sendMessage(chatId, response.output);
      } else {
        await ctx.reply(`Error: ${response.error || 'Unknown error'}`);
      }
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
      https.get(url, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        require('fs').unlink(localPath, () => {});
        reject(err);
      });
    });
  }

  /**
   * Handles text messages - sends to Claude via SDK.
   */
  private async handleTextMessage(ctx: Context): Promise<void> {
    const message = ctx.message as Message.TextMessage;
    const chatId = ctx.chat!.id;
    const text = message.text;

    if (!this.claudeClient.hasSession(chatId)) {
      await ctx.reply(
        'No active Claude session.\n\n' +
        'Use /start to begin a new session.'
      );
      return;
    }

    // Show typing indicator
    await ctx.sendChatAction('typing');

    const response = await this.claudeClient.sendMessage(chatId, text);

    if (response.success) {
      if (response.output) {
        await this.sendMessage(chatId, response.output);
      } else {
        await ctx.reply('Claude completed the task with no text output.');
      }
    } else {
      const errorMsg = response.error || 'Unknown error occurred';
      await ctx.reply(`Error: ${errorMsg}`);
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
    this.claudeClient.shutdown();
    this.bot.stop('SIGTERM');
    console.log('Telegram bot stopped.');
  }
}
