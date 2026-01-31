/**
 * OpenAI Codex CLI Client
 *
 * Provides a programmatic interface to OpenAI Codex CLI,
 * with streaming progress updates for long-running tasks.
 *
 * Implements the AIClient interface for use with the Telegram bot.
 */

import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import {
  AIClient,
  AIResponse,
  SessionState,
  ProgressEvent,
  SessionEndCallback,
  ProgressCallback,
} from './types';

// Interval for "still working" fallback messages (45 seconds)
const STILL_WORKING_INTERVAL_MS = 45000;

/**
 * Finds the Codex CLI binary path.
 */
function findCodexBinary(): string {
  const homeDir = os.homedir();
  const codexPaths = [
    `${homeDir}/.local/bin/codex`,
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    'codex',
  ];

  for (const p of codexPaths) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // Continue to next path
    }
  }

  return 'codex';
}

/**
 * Formats a tool use into a human-readable message.
 * Codex uses similar tool names to Claude.
 */
function formatToolUse(toolName: string, input: any): string {
  switch (toolName) {
    case 'shell':
    case 'bash':
      if (input?.command) {
        const cmd = input.command.length > 100
          ? input.command.substring(0, 97) + '...'
          : input.command;
        return `Running: ${cmd}`;
      }
      return 'Running command...';

    case 'read_file':
    case 'read':
      if (input?.file_path || input?.path) {
        return `Reading: ${input.file_path || input.path}`;
      }
      return 'Reading file...';

    case 'write_file':
    case 'write':
      if (input?.file_path || input?.path) {
        return `Writing: ${input.file_path || input.path}`;
      }
      return 'Writing file...';

    case 'edit_file':
    case 'edit':
      if (input?.file_path || input?.path) {
        return `Editing: ${input.file_path || input.path}`;
      }
      return 'Editing file...';

    case 'list_dir':
    case 'glob':
      if (input?.path || input?.pattern) {
        return `Listing: ${input.path || input.pattern}`;
      }
      return 'Listing directory...';

    case 'search':
    case 'grep':
      if (input?.pattern || input?.query) {
        const path = input.path ? ` in ${input.path}` : '';
        return `Searching for: "${input.pattern || input.query}"${path}`;
      }
      return 'Searching content...';

    default:
      return `Using ${toolName}...`;
  }
}

/**
 * Parses a JSON event from Codex CLI and extracts relevant progress info.
 * Codex outputs JSON events when using --json flag.
 */
function parseCodexEvent(line: string): ProgressEvent | null {
  try {
    const event = JSON.parse(line);

    // Handle Codex event types
    // Codex emits events like: { type: "function_call", name: "shell", arguments: {...} }
    if (event.type === 'function_call' || event.type === 'tool_call') {
      const toolName = event.name || event.function?.name || 'unknown tool';
      const input = event.arguments || event.function?.arguments || {};
      const message = formatToolUse(toolName, typeof input === 'string' ? JSON.parse(input) : input);

      return {
        type: 'tool_use',
        message,
      };
    }

    // Handle thinking/reasoning events
    if (event.type === 'thinking' || event.type === 'reasoning') {
      return {
        type: 'thinking',
        message: 'Thinking...',
      };
    }

    // Handle message events with tool calls
    if (event.type === 'message' && event.content) {
      for (const block of Array.isArray(event.content) ? event.content : [event.content]) {
        if (block.type === 'tool_use' || block.type === 'function_call') {
          const toolName = block.name || 'unknown tool';
          const message = formatToolUse(toolName, block.input || block.arguments);
          return {
            type: 'tool_use',
            message,
          };
        }
      }
    }

    // Handle completion/result events
    if (event.type === 'result' || event.type === 'done' || event.type === 'complete') {
      return {
        type: 'result',
        message: 'Completed',
      };
    }

    return null;
  } catch {
    // Not valid JSON or unrecognized format
    return null;
  }
}

export class CodexClient implements AIClient {
  private sessions: Map<number, SessionState> = new Map();
  private idleTimeoutMs: number;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private onSessionEnd: SessionEndCallback | null = null;
  private onProgress: ProgressCallback | null = null;
  private codexPath: string;
  private workingDir: string;
  private systemPromptFile: string | null;

  constructor(idleTimeoutMs: number = 1800000, workingDir?: string, systemPromptFile?: string | null) {
    this.idleTimeoutMs = idleTimeoutMs;
    this.codexPath = findCodexBinary();
    this.workingDir = workingDir || process.cwd();
    this.systemPromptFile = systemPromptFile || null;
    this.startIdleCheck();
    console.log(`Codex SDK client initialized, using: ${this.codexPath}`);
    if (this.systemPromptFile) {
      console.log(`Using system prompt from: ${this.systemPromptFile}`);
    }
  }

  /**
   * Registers a callback for session termination events.
   */
  setSessionEndCallback(callback: SessionEndCallback): void {
    this.onSessionEnd = callback;
  }

  /**
   * Registers a callback for progress events during command execution.
   */
  setProgressCallback(callback: ProgressCallback): void {
    this.onProgress = callback;
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
   * Sends a message to Codex and returns the response.
   * Streams progress events during execution.
   */
  async sendMessage(chatId: number, message: string): Promise<AIResponse> {
    const session = this.sessions.get(chatId);
    if (!session) {
      return {
        success: false,
        output: '',
        error: 'No active session. Use /start to begin.',
      };
    }

    session.lastActivity = Date.now();

    // Build arguments for codex exec
    // codex exec runs non-interactively, reading prompt from stdin
    const args = [
      'exec',
      '--json',  // Enable JSON streaming output
      '--full-auto',  // Skip approval prompts (equivalent to Claude's --dangerously-skip-permissions)
    ];

    // Resume session if we've already started a conversation
    if (session.conversationStarted && session.sessionId) {
      // Codex uses: codex exec resume <session_id>
      args.splice(1, 0, 'resume', session.sessionId);
    } else {
      session.conversationStarted = true;
    }

    return this.executeCommand(chatId, args, message);
  }

  /**
   * Sends an image path notification to Codex.
   */
  async sendImage(chatId: number, imagePath: string, caption?: string): Promise<AIResponse> {
    const message = caption
      ? `User sent an image: ${imagePath}\n${caption}`
      : `User sent an image: ${imagePath}\nPlease inspect this image.`;

    return this.sendMessage(chatId, message);
  }

  /**
   * Executes a Codex CLI command with streaming progress.
   */
  private executeCommand(chatId: number, args: string[], message: string): Promise<AIResponse> {
    return new Promise((resolve) => {
      let outputText = '';
      let stderr = '';
      let stillWorkingTimer: NodeJS.Timeout | null = null;
      let lastActivity = '';
      let workingMinutes = 0;
      const startTime = Date.now();

      const proc = spawn(this.codexPath, args, {
        cwd: this.workingDir,
        env: {
          ...process.env,
          HOME: os.homedir(),
        },
      });

      // Store process reference for potential cancellation
      const session = this.sessions.get(chatId);
      if (session) {
        session.activeProcess = proc;
      }

      // Set up "still working" fallback timer with elapsed time context
      const resetStillWorkingTimer = () => {
        if (stillWorkingTimer) {
          clearInterval(stillWorkingTimer);
        }
        stillWorkingTimer = setInterval(() => {
          if (this.onProgress) {
            workingMinutes = Math.floor((Date.now() - startTime) / 60000);
            const timeStr = workingMinutes > 0 ? ` (${workingMinutes}m elapsed)` : '';
            const activityStr = lastActivity ? ` Last: ${lastActivity}` : '';
            this.onProgress(chatId, {
              type: 'working',
              message: `Still working...${timeStr}${activityStr}`,
            });
          }
        }, STILL_WORKING_INTERVAL_MS);
      };

      resetStillWorkingTimer();

      // Pass message via stdin
      proc.stdin.write(message);
      proc.stdin.end();

      // Process streaming JSON output
      let buffer = '';
      proc.stdout.on('data', (data) => {
        buffer += data.toString();

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          // Try to parse as stream event
          const event = parseCodexEvent(line);
          if (event && this.onProgress) {
            resetStillWorkingTimer();
            // Don't send 'result' events as progress - that's the final state
            if (event.type !== 'result') {
              // Track last activity for "still working" messages
              lastActivity = event.message;
              this.onProgress(chatId, event);
            }
          }

          // Try to extract final result text
          try {
            const parsed = JSON.parse(line);
            // Handle Codex result formats
            if (parsed.type === 'result' || parsed.type === 'done') {
              if (parsed.output || parsed.text || parsed.content) {
                outputText = parsed.output || parsed.text || parsed.content;
              }
            } else if (parsed.type === 'message' && parsed.content) {
              // Collect text from message content
              const content = Array.isArray(parsed.content) ? parsed.content : [parsed.content];
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  outputText += block.text;
                } else if (typeof block === 'string') {
                  outputText += block;
                }
              }
            } else if (parsed.type === 'assistant' && parsed.text) {
              outputText += parsed.text;
            }
          } catch {
            // Not JSON, might be plain text output
            // Some Codex modes output plain text
            if (!line.startsWith('{')) {
              outputText += line + '\n';
            }
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        // Clear the still working timer
        if (stillWorkingTimer) {
          clearInterval(stillWorkingTimer);
        }

        // Clean up listeners to prevent memory leaks
        proc.stdout?.removeAllListeners();
        proc.stderr?.removeAllListeners();
        proc.removeAllListeners();

        // Clear active process reference
        if (session) {
          session.activeProcess = undefined;
        }

        if (code === 0) {
          resolve({
            success: true,
            output: outputText.trim(),
          });
        } else {
          resolve({
            success: false,
            output: outputText.trim(),
            error: stderr.trim() || `Process exited with code ${code}`,
          });
        }
      });

      proc.on('error', (err) => {
        if (stillWorkingTimer) {
          clearInterval(stillWorkingTimer);
        }

        // Clean up listeners to prevent memory leaks
        proc.stdout?.removeAllListeners();
        proc.stderr?.removeAllListeners();
        proc.removeAllListeners();

        if (session) {
          session.activeProcess = undefined;
        }
        resolve({
          success: false,
          output: '',
          error: `Failed to spawn Codex: ${err.message}`,
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
   * Terminates a session and kills any active process.
   */
  killSession(chatId: number): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }

    // Kill active process if running
    if (session.activeProcess) {
      this.cleanupProcess(session.activeProcess);
    }

    this.sessions.delete(chatId);
    return true;
  }

  /**
   * Interrupts the current active process without terminating the session.
   * Sends SIGINT (like Ctrl+C) to gracefully interrupt.
   */
  interruptProcess(chatId: number): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }

    if (!session.activeProcess) {
      return false;
    }

    // Send SIGINT for graceful interrupt (like Ctrl+C)
    session.activeProcess.kill('SIGINT');
    return true;
  }

  /**
   * Cleans up a child process by removing all listeners and killing it.
   */
  private cleanupProcess(proc: ChildProcess): void {
    proc.stdout?.removeAllListeners();
    proc.stderr?.removeAllListeners();
    proc.removeAllListeners();
    proc.kill('SIGTERM');
  }

  /**
   * Starts the idle session check interval.
   */
  private startIdleCheck(): void {
    this.idleCheckInterval = setInterval(() => {
      const now = Date.now();

      for (const [chatId, session] of this.sessions) {
        if (now - session.lastActivity > this.idleTimeoutMs) {
          if (session.activeProcess) {
            this.cleanupProcess(session.activeProcess);
          }
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

    for (const [chatId, session] of this.sessions) {
      if (session.activeProcess) {
        this.cleanupProcess(session.activeProcess);
      }
      if (this.onSessionEnd) {
        this.onSessionEnd(chatId, 'Bridge shutting down');
      }
    }

    this.sessions.clear();
  }
}
