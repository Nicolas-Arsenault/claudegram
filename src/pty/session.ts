/**
 * PTY Session Manager
 *
 * Manages pseudo-terminal sessions for Claude Code as specified in project.md Section 5.
 *
 * Key requirements from spec:
 * - Claude Code relies on interactive prompts, ANSI escape sequences, cursor movement,
 *   progress indicators, and streaming output
 * - Plain stdin/stdout is insufficient - PTY is mandatory
 * - Default model: 1 Telegram chat = 1 Claude Code PTY session
 * - Optional idle timeout (default: 30 minutes)
 */

import * as pty from 'node-pty';
import * as os from 'os';

export interface SessionOptions {
  workingDir?: string;
  idleTimeoutMs?: number;
}

export interface Session {
  chatId: number;
  ptyProcess: pty.IPty;
  lastActivity: number;
  outputBuffer: string;
}

type OutputCallback = (chatId: number, data: string) => void;
type SessionEndCallback = (chatId: number, reason: string) => void;

export class SessionManager {
  private sessions: Map<number, Session> = new Map();
  private idleTimeoutMs: number;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private onOutput: OutputCallback | null = null;
  private onSessionEnd: SessionEndCallback | null = null;

  constructor(idleTimeoutMs: number = 1800000) {
    this.idleTimeoutMs = idleTimeoutMs;
    this.startIdleCheck();
  }

  /**
   * Registers a callback for PTY output data.
   */
  setOutputCallback(callback: OutputCallback): void {
    this.onOutput = callback;
  }

  /**
   * Registers a callback for session termination events.
   */
  setSessionEndCallback(callback: SessionEndCallback): void {
    this.onSessionEnd = callback;
  }

  /**
   * Creates a new Claude Code PTY session for a Telegram chat.
   * If a session already exists for this chat, returns the existing one.
   */
  getOrCreateSession(chatId: number, options: SessionOptions = {}): Session {
    let session = this.sessions.get(chatId);
    if (session) {
      return session;
    }

    const workingDir = options.workingDir || process.cwd();
    const homeDir = os.homedir();

    // Try to find claude binary in common locations
    const claudePaths = [
      `${homeDir}/.local/bin/claude`,
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      'claude', // fallback to PATH
    ];

    let claudePath = 'claude';
    for (const p of claudePaths) {
      try {
        require('fs').accessSync(p, require('fs').constants.X_OK);
        claudePath = p;
        break;
      } catch {
        // Continue to next path
      }
    }

    console.log(`Spawning Claude from: ${claudePath}`);

    // Spawn Claude Code in a PTY
    const ptyProcess = pty.spawn(claudePath, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: workingDir,
      env: {
        ...process.env,
        HOME: homeDir,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

    session = {
      chatId,
      ptyProcess,
      lastActivity: Date.now(),
      outputBuffer: '',
    };

    // Handle PTY output
    ptyProcess.onData((data: string) => {
      session!.lastActivity = Date.now();
      session!.outputBuffer += data;

      if (this.onOutput) {
        this.onOutput(chatId, data);
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      const reason = signal
        ? `Terminated by signal ${signal}`
        : `Exited with code ${exitCode}`;

      this.sessions.delete(chatId);

      if (this.onSessionEnd) {
        this.onSessionEnd(chatId, reason);
      }
    });

    this.sessions.set(chatId, session);
    return session;
  }

  /**
   * Writes data to a session's PTY.
   * As per project.md Section 5.3, appends newline to input.
   */
  write(chatId: number, data: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }

    session.lastActivity = Date.now();
    session.ptyProcess.write(data + '\n');
    return true;
  }

  /**
   * Writes raw data to a session's PTY without appending newline.
   * Used for special key sequences.
   */
  writeRaw(chatId: number, data: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }

    session.lastActivity = Date.now();
    session.ptyProcess.write(data);
    return true;
  }

  /**
   * Terminates a specific session.
   */
  killSession(chatId: number): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }

    session.ptyProcess.kill();
    this.sessions.delete(chatId);
    return true;
  }

  /**
   * Checks if a session exists for a chat.
   */
  hasSession(chatId: number): boolean {
    return this.sessions.has(chatId);
  }

  /**
   * Gets a session by chat ID.
   */
  getSession(chatId: number): Session | undefined {
    return this.sessions.get(chatId);
  }

  /**
   * Resizes a session's PTY dimensions.
   */
  resize(chatId: number, cols: number, rows: number): boolean {
    const session = this.sessions.get(chatId);
    if (!session) {
      return false;
    }

    session.ptyProcess.resize(cols, rows);
    return true;
  }

  /**
   * Starts the idle session check interval.
   */
  private startIdleCheck(): void {
    // Check for idle sessions every minute
    this.idleCheckInterval = setInterval(() => {
      const now = Date.now();

      for (const [chatId, session] of this.sessions) {
        if (now - session.lastActivity > this.idleTimeoutMs) {
          session.ptyProcess.kill();
          this.sessions.delete(chatId);

          if (this.onSessionEnd) {
            this.onSessionEnd(chatId, 'Session timed out due to inactivity');
          }
        }
      }
    }, 60000);
  }

  /**
   * Shuts down all sessions and stops the idle check.
   */
  shutdown(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }

    for (const [chatId, session] of this.sessions) {
      session.ptyProcess.kill();

      if (this.onSessionEnd) {
        this.onSessionEnd(chatId, 'Bridge shutting down');
      }
    }

    this.sessions.clear();
  }
}
