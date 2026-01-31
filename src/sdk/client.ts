/**
 * Claude Code SDK Client
 *
 * Provides a clean programmatic interface to Claude Code,
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
  UserInputQuestion,
} from './types';

// Re-export types for backwards compatibility
export { AIResponse, SessionState, ProgressEvent } from './types';

// Legacy type alias for backwards compatibility
export type ClaudeResponse = AIResponse;

// Interval for "still working" fallback messages (45 seconds)
const STILL_WORKING_INTERVAL_MS = 45000;

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
 * Result of parsing a tool use - can be a simple message or a special event.
 */
interface ToolParseResult {
  type: 'tool_use' | 'user_input_needed' | 'plan_start' | 'plan_exit' | 'task_update';
  message: string;
  questions?: UserInputQuestion[];
  taskInfo?: {
    action: 'create' | 'update' | 'list';
    subject?: string;
    status?: string;
  };
}

/**
 * Formats a tool use into a human-readable message or special event.
 */
function formatToolUse(toolName: string, input: any): ToolParseResult {
  switch (toolName) {
    case 'Bash':
      if (input?.command) {
        const cmd = input.command.length > 100
          ? input.command.substring(0, 97) + '...'
          : input.command;
        return { type: 'tool_use', message: `Running: ${cmd}` };
      }
      return { type: 'tool_use', message: 'Running command...' };

    case 'Read':
      if (input?.file_path) {
        return { type: 'tool_use', message: `Reading: ${input.file_path}` };
      }
      return { type: 'tool_use', message: 'Reading file...' };

    case 'Write':
      if (input?.file_path) {
        return { type: 'tool_use', message: `Writing: ${input.file_path}` };
      }
      return { type: 'tool_use', message: 'Writing file...' };

    case 'Edit':
      if (input?.file_path) {
        return { type: 'tool_use', message: `Editing: ${input.file_path}` };
      }
      return { type: 'tool_use', message: 'Editing file...' };

    case 'Glob':
      if (input?.pattern) {
        return { type: 'tool_use', message: `Searching files: ${input.pattern}` };
      }
      return { type: 'tool_use', message: 'Searching files...' };

    case 'Grep':
      if (input?.pattern) {
        const path = input.path ? ` in ${input.path}` : '';
        return { type: 'tool_use', message: `Searching for: "${input.pattern}"${path}` };
      }
      return { type: 'tool_use', message: 'Searching content...' };

    case 'WebFetch':
      if (input?.url) {
        return { type: 'tool_use', message: `Fetching: ${input.url}` };
      }
      return { type: 'tool_use', message: 'Fetching URL...' };

    case 'WebSearch':
      if (input?.query) {
        return { type: 'tool_use', message: `Searching web: "${input.query}"` };
      }
      return { type: 'tool_use', message: 'Searching web...' };

    case 'Task':
      if (input?.description) {
        return { type: 'tool_use', message: `Spawning agent: ${input.description}` };
      }
      return { type: 'tool_use', message: 'Spawning agent...' };

    // Plan mode tools
    case 'EnterPlanMode':
      return { type: 'plan_start', message: 'Entering plan mode...' };

    case 'ExitPlanMode':
      return { type: 'plan_exit', message: 'Exiting plan mode - ready to implement' };

    // Task management tools
    case 'TaskCreate':
      return {
        type: 'task_update',
        message: `Creating task: ${input?.subject || 'New task'}`,
        taskInfo: {
          action: 'create',
          subject: input?.subject,
        },
      };

    case 'TaskUpdate':
      const statusMsg = input?.status ? ` → ${input.status}` : '';
      return {
        type: 'task_update',
        message: `Updating task${statusMsg}`,
        taskInfo: {
          action: 'update',
          status: input?.status,
        },
      };

    case 'TaskList':
      return {
        type: 'task_update',
        message: 'Reviewing task list...',
        taskInfo: { action: 'list' },
      };

    // User input tool
    case 'AskUserQuestion':
      const questions: UserInputQuestion[] = [];
      if (input?.questions && Array.isArray(input.questions)) {
        for (const q of input.questions) {
          const options = (q.options || []).map((opt: any) => ({
            label: opt.label || '',
            description: opt.description,
          }));
          questions.push({
            question: q.question || 'Question',
            options,
          });
        }
      }
      return {
        type: 'user_input_needed',
        message: 'Waiting for your input...',
        questions,
      };

    default:
      return { type: 'tool_use', message: `Using ${toolName}...` };
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
          const result = formatToolUse(toolName, block.input);

          return {
            type: result.type,
            message: result.message,
            questions: result.questions,
            taskInfo: result.taskInfo,
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
        // For content_block_start, we just show the tool is starting
        // The full details come in the assistant message
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

export class ClaudeClient implements AIClient {
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
      let lastActivity = '';
      let workingMinutes = 0;
      const startTime = Date.now();

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
          const event = parseStreamEvent(line);
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
        proc.kill();

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
