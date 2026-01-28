/**
 * Telegram Bot Handler
 *
 * Implements the Telegram bot interface as specified in project.md Section 6.
 *
 * Supported inputs (Section 6.1):
 * - Plain text messages
 * - Slash commands
 * - Images (photo or document)
 *
 * Input handling rules (Section 6.2):
 * - Text message: Forward directly to PTY
 * - Slash command: Forward verbatim to PTY (no parsing or interpretation)
 * - Image: Download locally, save to filesystem, notify Claude Code via PTY with file path
 *
 * The bot must not interpret or reimplement Claude functionality.
 */

import { Telegraf, Context } from 'telegraf';
import { Message } from 'telegraf/types';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as https from 'https';

import { SessionManager } from '../pty/session';
import { ScreenshotCapture } from '../screenshot/capture';
import { AccessControl } from '../security/access';
import { Config } from '../config';

// ANSI escape code regex for stripping terminal sequences
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[PX^_].*?\x1b\\|\r/g;

// Maximum buffer size before forcing a flush (100KB)
const MAX_BUFFER_SIZE = 100 * 1024;

// Output debounce delay in milliseconds
const OUTPUT_DEBOUNCE_MS = 500;

export class TelegramBot {
  private bot: Telegraf;
  private sessionManager: SessionManager;
  private screenshotCapture: ScreenshotCapture;
  private accessControl: AccessControl;
  private inputImageDir: string;
  private outputBuffers: Map<number, string> = new Map();
  private outputTimers: Map<number, NodeJS.Timeout> = new Map();

  constructor(config: Config) {
    this.bot = new Telegraf(config.telegramBotToken);
    this.sessionManager = new SessionManager(config.sessionIdleTimeoutMs);
    this.screenshotCapture = new ScreenshotCapture(config.screenshotOutputDir);
    this.accessControl = new AccessControl(config.allowedUserIds);
    this.inputImageDir = config.inputImageDir;

    this.setupSessionCallbacks();
    this.setupHandlers();
  }

  /**
   * Sets up callbacks for PTY session output and termination.
   */
  private setupSessionCallbacks(): void {
    // Handle PTY output - buffer and debounce
    this.sessionManager.setOutputCallback((chatId, data) => {
      const existing = this.outputBuffers.get(chatId) || '';
      const newBuffer = existing + data;
      this.outputBuffers.set(chatId, newBuffer);

      // Clear existing timer
      const existingTimer = this.outputTimers.get(chatId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Force flush if buffer exceeds max size to prevent memory issues
      if (newBuffer.length >= MAX_BUFFER_SIZE) {
        this.flushOutput(chatId);
        return;
      }

      // Set new timer to flush output after debounce delay
      const timer = setTimeout(() => {
        this.flushOutput(chatId);
      }, OUTPUT_DEBOUNCE_MS);

      this.outputTimers.set(chatId, timer);
    });

    // Handle session termination
    this.sessionManager.setSessionEndCallback((chatId, reason) => {
      this.flushOutput(chatId);
      this.sendMessage(chatId, `Session ended: ${reason}`);
    });
  }

  /**
   * Flushes buffered output to Telegram.
   */
  private async flushOutput(chatId: number): Promise<void> {
    const buffer = this.outputBuffers.get(chatId);
    if (!buffer) return;

    this.outputBuffers.delete(chatId);
    this.outputTimers.delete(chatId);

    // Strip ANSI escape sequences for cleaner Telegram output
    const cleanOutput = buffer.replace(ANSI_REGEX, '');

    if (cleanOutput.trim()) {
      await this.sendMessage(chatId, cleanOutput);
    }
  }

  /**
   * Sends a message to a Telegram chat, handling message length limits.
   */
  private async sendMessage(chatId: number, text: string): Promise<void> {
    const MAX_MESSAGE_LENGTH = 4096;

    try {
      // Split long messages
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.bot.telegram.sendMessage(chatId, text);
      } else {
        // Split into chunks at line boundaries when possible
        const chunks = this.splitMessage(text, MAX_MESSAGE_LENGTH);
        for (const chunk of chunks) {
          await this.bot.telegram.sendMessage(chatId, chunk);
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

      // Try to find a good split point (newline)
      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // No good newline, split at max length
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
        return; // Silently ignore unauthorized users
      }
      return next();
    });

    // Handle /start command
    this.bot.command('start', async (ctx) => {
      const chatId = ctx.chat.id;
      await ctx.reply(
        'Claudegram\n\n' +
        'Commands:\n' +
        '  /screenshot - List available displays\n' +
        '  /screenshot <n> - Capture display n\n' +
        '  /kill - Terminate current Claude session\n\n' +
        'All other messages are forwarded to Claude Code.'
      );

      // Start a Claude session if one doesn't exist
      if (!this.sessionManager.hasSession(chatId)) {
        this.sessionManager.getOrCreateSession(chatId);
        await ctx.reply('Starting Claude Code session...');
      }
    });

    // Handle /screenshot command (Bridge command, not forwarded to Claude)
    this.bot.command('screenshot', async (ctx) => {
      await this.handleScreenshot(ctx);
    });

    // Handle /kill command (Bridge command, not forwarded to Claude)
    this.bot.command('kill', async (ctx) => {
      const chatId = ctx.chat.id;
      if (this.sessionManager.killSession(chatId)) {
        await ctx.reply('Claude session terminated.');
      } else {
        await ctx.reply('No active session to terminate.');
      }
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
        // Forward non-image documents as file path mentions
        await ctx.reply('Only image documents are supported.');
      }
    });

    // Handle all other text messages - forward to PTY
    this.bot.on('text', async (ctx) => {
      await this.handleTextMessage(ctx);
    });
  }

  /**
   * Handles /screenshot command as specified in project.md Section 9.
   */
  private async handleScreenshot(ctx: Context): Promise<void> {
    const message = ctx.message as Message.TextMessage;
    const text = message.text;
    const chatId = ctx.chat!.id;

    // Parse command arguments
    const parts = text.split(/\s+/);
    const indexArg = parts[1];

    if (!indexArg) {
      // List available displays
      try {
        const displays = await this.screenshotCapture.listDisplays();
        const formatted = this.screenshotCapture.formatDisplayList(displays);
        await ctx.reply(formatted);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        await ctx.reply(`Failed to list displays: ${errMsg}`);
      }
    } else {
      // Capture specific display
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
   * Handles image messages as specified in project.md Section 7.
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
      // Get the highest resolution photo
      const photos = (message as Message.PhotoMessage).photo;
      fileId = photos[photos.length - 1].file_id;
    } else {
      const doc = (message as Message.DocumentMessage).document;
      fileId = doc.file_id;
      // Try to get extension from filename or mime type
      if (doc.file_name) {
        const ext = path.extname(doc.file_name).slice(1);
        if (ext) extension = ext;
      }
    }

    try {
      // Ensure input directory exists
      await fs.mkdir(this.inputImageDir, { recursive: true });

      // Get file info from Telegram
      const file = await ctx.telegram.getFile(fileId);
      if (!file.file_path) {
        await ctx.reply('Failed to get file path from Telegram.');
        return;
      }

      // Generate local filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `image-${timestamp}.${extension}`;
      const localPath = path.join(this.inputImageDir, filename);

      // Download the file
      const fileUrl = `https://api.telegram.org/file/bot${this.bot.telegram.token}/${file.file_path}`;
      await this.downloadFile(fileUrl, localPath);

      // Notify Claude via PTY as specified in project.md Section 7.2
      const caption = (message as any).caption || 'Please inspect this image.';
      const notification = `User sent an image: ${localPath}\n${caption}`;

      // Ensure session exists
      this.sessionManager.getOrCreateSession(chatId);

      // Send to PTY
      this.sessionManager.write(chatId, notification);

      await ctx.reply(`Image saved. Notifying Claude...`);
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
   * Handles text messages - forwards to PTY as specified in project.md Section 6.2.
   * Slash commands are forwarded verbatim (no parsing or interpretation).
   */
  private async handleTextMessage(ctx: Context): Promise<void> {
    const message = ctx.message as Message.TextMessage;
    const chatId = ctx.chat!.id;
    const text = message.text;

    // Ensure session exists
    this.sessionManager.getOrCreateSession(chatId);

    // Forward directly to PTY (both plain text and slash commands)
    // As per spec: "Forward verbatim to PTY (no parsing or interpretation)"
    this.sessionManager.write(chatId, text);
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
    this.sessionManager.shutdown();
    this.bot.stop('SIGTERM');
    console.log('Telegram bot stopped.');
  }
}
