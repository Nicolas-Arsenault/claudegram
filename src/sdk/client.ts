/**
 * Claude Code SDK Client
 *
 * Provides a clean programmatic interface to Claude Code,
 * with streaming progress updates for long-running tasks.
 */

import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import { randomUUID } from 'crypto';

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
  activeProcess?: ChildProcess;
}

export interface ProgressEvent {
  type: 'tool_use' | 'thinking' | 'working' | 'result';
  message: string;
}

type SessionEndCallback = (chatId: number, reason: string) => void;
type ProgressCallback = (chatId: number, event: ProgressEvent) => void;

// Interval for "still working" fallback messages (30 seconds)
const STILL_WORKING_INTERVAL_MS = 30000;

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

/**
 * Formats a tool use into a human-readable message.
 */
function formatToolUse(toolName: string, input: any): string {
  switch (toolName) {
    case 'Bash':
      if (input?.command) {
        const cmd = input.command.length > 100
          ? input.command.substring(0, 97) + '...'
          : input.command;
        return `Running: ${cmd}`;
      }
      return 'Running command...';

    case 'Read':
      if (input?.file_path) {
        return `Reading: ${input.file_path}`;
      }
      return 'Reading file...';

    case 'Write':
      if (input?.file_path) {
        return `Writing: ${input.file_path}`;
      }
      return 'Writing file...';

    case 'Edit':
      if (input?.file_path) {
        return `Editing: ${input.file_path}`;
      }
      return 'Editing file...';

    case 'Glob':
      if (input?.pattern) {
        return `Searching files: ${input.pattern}`;
      }
      return 'Searching files...';

    case 'Grep':
      if (input?.pattern) {
        const path = input.path ? ` in ${input.path}` : '';
        return `Searching for: "${input.pattern}"${path}`;
      }
      return 'Searching content...';

    case 'WebFetch':
      if (input?.url) {
        return `Fetching: ${input.url}`;
      }
      return 'Fetching URL...';

    case 'WebSearch':
      if (input?.query) {
        return `Searching web: "${input.query}"`;
      }
      return 'Searching web...';

    case 'Task':
      if (input?.description) {
        return `Spawning agent: ${input.description}`;
      }
      return 'Spawning agent...';

    default:
      return `Using ${toolName}...`;
  }
}

/**
 * Parses a stream-json line from Claude CLI and extracts relevant progress info.
 */
function parseStreamEvent(line: string): ProgressEvent | null {
  try {
    const event = JSON.parse(line);

    // Handle different event types from Claude's stream-json output
    if (event.type === 'assistant' && event.message?.content) {
      // Assistant is producing output - check for tool use
      for (const block of event.message.content) {
        if (block.type === 'tool_use') {
          const toolName = block.name || 'unknown tool';
          const message = formatToolUse(toolName, block.input);

          return {
            type: 'tool_use',
            message,
          };
        } else if (block.type === 'thinking') {
          return {
            type: 'thinking',
            message: 'Thinking...',
          };
        }
      }
    } else if (event.type === 'content_block_start') {
      if (event.content_block?.type === 'tool_use') {
        const toolName = event.content_block.name || 'tool';
        return {
          type: 'tool_use',
          message: `Starting ${toolName}...`,
        };
      }
    } else if (event.type === 'result') {
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

export class ClaudeClient {
  private sessions: Map<number, SessionState> = new Map();
  private idleTimeoutMs: number;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private onSessionEnd: SessionEndCallback | null = null;
  private onProgress: ProgressCallback | null = null;
  private claudePath: string;
  private workingDir: string;
  private systemPromptFile: string | null;

  constructor(idleTimeoutMs: number = 1800000, workingDir?: string, systemPromptFile?: string | null) {
    this.idleTimeoutMs = idleTimeoutMs;
    this.claudePath = findClaudeBinary();
    this.workingDir = workingDir || process.cwd();
    this.systemPromptFile = systemPromptFile || null;
    this.startIdleCheck();
    console.log(`Claude SDK client initialized, using: ${this.claudePath}`);
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
   * Sends a message to Claude and returns the response.
   * Streams progress events during execution.
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
      '--output-format', 'stream-json',
      '--verbose',
    ];

    // Add system prompt if configured
    if (this.systemPromptFile) {
      args.push('--system-prompt', this.systemPromptFile);
    }

    // Use --resume to continue conversation if we've already started
    if (session.conversationStarted) {
      args.push('--resume', session.sessionId);
    } else {
      // First message - set session ID for future resumption
      args.push('--session-id', session.sessionId);
      session.conversationStarted = true;
    }

    return this.executeCommand(chatId, args, message);
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
   * Executes a Claude CLI command with streaming progress.
   */
  private executeCommand(chatId: number, args: string[], message: string): Promise<ClaudeResponse> {
    return new Promise((resolve) => {
      let outputText = '';
      let stderr = '';
      let stillWorkingTimer: NodeJS.Timeout | null = null;

      const proc = spawn(this.claudePath, args, {
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

      // Set up "still working" fallback timer
      const resetStillWorkingTimer = () => {
        if (stillWorkingTimer) {
          clearInterval(stillWorkingTimer);
        }
        stillWorkingTimer = setInterval(() => {
          if (this.onProgress) {
            this.onProgress(chatId, {
              type: 'working',
              message: 'Still working...',
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
          const event = parseStreamEvent(line);
          if (event && this.onProgress) {
            resetStillWorkingTimer();
            // Don't send 'result' events as progress - that's the final state
            if (event.type !== 'result') {
              this.onProgress(chatId, event);
            }
          }

          // Try to extract final result text
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'result' && parsed.result) {
              outputText = parsed.result;
            } else if (parsed.type === 'assistant' && parsed.message?.content) {
              // Collect text blocks from assistant messages
              for (const block of parsed.message.content) {
                if (block.type === 'text' && block.text) {
                  outputText += block.text;
                }
              }
            }
          } catch {
            // Not JSON, ignore
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
        if (session) {
          session.activeProcess = undefined;
        }
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
   * Terminates a session and kills any active process.
   */
  killSession(chatId: number): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }

    // Kill active process if running
    if (session.activeProcess) {
      session.activeProcess.kill('SIGTERM');
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
          if (session.activeProcess) {
            session.activeProcess.kill('SIGTERM');
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
        session.activeProcess.kill('SIGTERM');
      }
      if (this.onSessionEnd) {
        this.onSessionEnd(chatId, 'Bridge shutting down');
      }
    }

    this.sessions.clear();
  }
}
