/**
 * Shared Types for AI Clients
 *
 * Defines the common interface and types that all AI clients
 * (Claude Code, OpenAI Codex, etc.) must implement.
 */

import { ChildProcess } from 'child_process';

/**
 * Response from an AI client operation.
 */
export interface AIResponse {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * State of an active session.
 */
export interface SessionState {
  chatId: number;
  sessionId: string;
  lastActivity: number;
  conversationStarted: boolean;
  activeProcess?: ChildProcess;
}

/**
 * Progress event emitted during AI operations.
 */
export interface ProgressEvent {
  type: 'tool_use' | 'thinking' | 'working' | 'result';
  message: string;
}

/**
 * Callback invoked when a session ends.
 */
export type SessionEndCallback = (chatId: number, reason: string) => void;

/**
 * Callback invoked during AI operations to report progress.
 */
export type ProgressCallback = (chatId: number, event: ProgressEvent) => void;

/**
 * AI Client Interface
 *
 * All AI backends (Claude Code, Codex, etc.) must implement this interface
 * to ensure consistent behavior across the application.
 */
export interface AIClient {
  /**
   * Creates a new session for a chat.
   * Returns the session state, or an existing session if one exists.
   */
  createSession(chatId: number): SessionState;

  /**
   * Checks if a session exists for a chat.
   */
  hasSession(chatId: number): boolean;

  /**
   * Terminates a session and kills any active process.
   * Returns true if a session was terminated, false if no session existed.
   */
  killSession(chatId: number): boolean;

  /**
   * Sends a message to the AI and returns the response.
   * Streams progress events during execution.
   */
  sendMessage(chatId: number, message: string): Promise<AIResponse>;

  /**
   * Sends an image path notification to the AI.
   */
  sendImage(chatId: number, imagePath: string, caption?: string): Promise<AIResponse>;

  /**
   * Registers a callback for session termination events.
   */
  setSessionEndCallback(callback: SessionEndCallback): void;

  /**
   * Registers a callback for progress events during command execution.
   */
  setProgressCallback(callback: ProgressCallback): void;

  /**
   * Shuts down all sessions and cleans up resources.
   */
  shutdown(): void;
}
