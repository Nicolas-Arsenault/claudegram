/**
 * Claude Code SDK Client
 *
 * Provides a clean programmatic interface to Claude Code,
 * replacing the PTY-based approach for more reliable output handling.
 */

import { spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import * as path from 'path';

export interface ClaudeResponse {
  success: boolean;
  output: string;
  error?: string;
}

export interface SessionState {
  chatId: number;
  sessionId: string;
  lastActivity: number;
  conversationStarted: boolean;
}

type SessionEndCallback = (chatId: number, reason: string) => void;

/**
 * Finds the Claude CLI binary path.
 */
function findClaudeBinary(): string {
  const homeDir = os.homedir();
  const claudePaths = [
    `${homeDir}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    'claude',
  ];

  for (const p of claudePaths) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // Continue to next path
    }
  }

  return 'claude';
}

export class ClaudeClient {
  private sessions: Map<number, SessionState> = new Map();
  private idleTimeoutMs: number;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private onSessionEnd: SessionEndCallback | null = null;
  private claudePath: string;
  private workingDir: string;

  constructor(idleTimeoutMs: number = 1800000, workingDir?: string) {
    this.idleTimeoutMs = idleTimeoutMs;
    this.claudePath = findClaudeBinary();
    this.workingDir = workingDir || process.cwd();
    this.startIdleCheck();
    console.log(`Claude SDK client initialized, using: ${this.claudePath}`);
  }

  /**
   * Registers a callback for session termination events.
   */
  setSessionEndCallback(callback: SessionEndCallback): void {
    this.onSessionEnd = callback;
  }

  /**
   * Creates a new session for a chat.
   */
  createSession(chatId: number): SessionState {
    const existing = this.sessions.get(chatId);
    if (existing) {
      return existing;
    }

    const session: SessionState = {
      chatId,
      sessionId: randomUUID(),
      lastActivity: Date.now(),
      conversationStarted: false,
    };

    this.sessions.set(chatId, session);
    return session;
  }

  /**
   * Sends a message to Claude and returns the response.
   */
  async sendMessage(chatId: number, message: string): Promise<ClaudeResponse> {
    const session = this.sessions.get(chatId);
    if (!session) {
      return {
        success: false,
        output: '',
        error: 'No active session. Use /start to begin.',
      };
    }

    session.lastActivity = Date.now();

    const args = [
      '-p',  // --print shorthand
      '--dangerously-skip-permissions',
      '--output-format', 'text',
    ];

    // Use --resume to continue conversation if we've already started
    if (session.conversationStarted) {
      args.push('--resume', session.sessionId);
    } else {
      // First message - set session ID for future resumption
      args.push('--session-id', session.sessionId);
      session.conversationStarted = true;
    }

    return this.executeCommand(args, message);
  }

  /**
   * Sends an image path notification to Claude.
   */
  async sendImage(chatId: number, imagePath: string, caption?: string): Promise<ClaudeResponse> {
    const message = caption
      ? `User sent an image: ${imagePath}\n${caption}`
      : `User sent an image: ${imagePath}\nPlease inspect this image.`;

    return this.sendMessage(chatId, message);
  }

  /**
   * Executes a Claude CLI command and returns the result.
   * Message is passed via stdin for reliability.
   */
  private executeCommand(args: string[], message: string): Promise<ClaudeResponse> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      const proc = spawn(this.claudePath, args, {
        cwd: this.workingDir,
        env: {
          ...process.env,
          HOME: os.homedir(),
        },
      });

      // Pass message via stdin
      proc.stdin.write(message);
      proc.stdin.end();

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({
            success: true,
            output: stdout.trim(),
          });
        } else {
          resolve({
            success: false,
            output: stdout.trim(),
            error: stderr.trim() || `Process exited with code ${code}`,
          });
        }
      });

      proc.on('error', (err) => {
        resolve({
          success: false,
          output: '',
          error: `Failed to spawn Claude: ${err.message}`,
        });
      });
    });
  }

  /**
   * Checks if a session exists for a chat.
   */
  hasSession(chatId: number): boolean {
    return this.sessions.has(chatId);
  }

  /**
   * Terminates a session.
   */
  killSession(chatId: number): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }

    this.sessions.delete(chatId);
    return true;
  }

  /**
   * Starts the idle session check interval.
   */
  private startIdleCheck(): void {
    this.idleCheckInterval = setInterval(() => {
      const now = Date.now();

      for (const [chatId, session] of this.sessions) {
        if (now - session.lastActivity > this.idleTimeoutMs) {
          this.sessions.delete(chatId);

          if (this.onSessionEnd) {
            this.onSessionEnd(chatId, 'Session timed out due to inactivity');
          }
        }
      }
    }, 60000);
  }

  /**
   * Shuts down all sessions.
   */
  shutdown(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }

    for (const [chatId] of this.sessions) {
      if (this.onSessionEnd) {
        this.onSessionEnd(chatId, 'Bridge shutting down');
      }
    }

    this.sessions.clear();
  }
}
