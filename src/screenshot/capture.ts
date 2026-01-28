/**
 * Screenshot Capture Module
 *
 * Captures screenshots of windows on macOS.
 *
 * Uses native macOS tools:
 * - CGWindowListCopyWindowInfo via osascript for listing windows
 * - screencapture -l <windowid> for capturing specific windows
 *
 * IMPORTANT: Requires Screen Recording permission in System Preferences > Privacy & Security
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

export interface WindowInfo {
  index: number;
  id: number;
  name: string;
  owner: string;
  bounds: string;
}

export interface ScreenshotResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

export class ScreenshotCapture {
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
  }

  /**
   * Ensures the screenshot output directory exists.
   */
  async ensureOutputDir(): Promise<void> {
    await fs.mkdir(this.outputDir, { recursive: true });
  }

  /**
   * Lists visible windows using CGWindowListCopyWindowInfo.
   */
  async listWindows(): Promise<WindowInfo[]> {
    // JXA script to get window list
    const script = `
      ObjC.import('CoreGraphics');
      ObjC.import('Foundation');

      const kCGWindowListOptionOnScreenOnly = 1 << 0;
      const kCGWindowListExcludeDesktopElements = 1 << 4;
      const kCGNullWindowID = 0;

      const windowList = ObjC.deepUnwrap(
        $.CGWindowListCopyWindowInfo(
          kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
          kCGNullWindowID
        )
      );

      const windows = [];
      for (const win of windowList) {
        const owner = win.kCGWindowOwnerName || '';
        const name = win.kCGWindowName || '';
        const id = win.kCGWindowNumber;
        const bounds = win.kCGWindowBounds;
        const layer = win.kCGWindowLayer || 0;

        // Skip windows without names, menubar items, and system UI
        if (!name || layer < 0 || bounds.Width < 100 || bounds.Height < 100) continue;
        // Skip some system processes
        if (['Window Server', 'Dock', 'SystemUIServer'].includes(owner)) continue;

        windows.push({
          id: id,
          name: name,
          owner: owner,
          width: Math.round(bounds.Width),
          height: Math.round(bounds.Height)
        });
      }

      JSON.stringify(windows);
    `;

    try {
      const { stdout } = await execAsync(`osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`);
      const windows = JSON.parse(stdout.trim());

      return windows.map((win: any, idx: number) => ({
        index: idx + 1,
        id: win.id,
        name: win.name,
        owner: win.owner,
        bounds: `${win.width}x${win.height}`,
      }));
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list windows: ${errMsg}`);
    }
  }

  /**
   * Formats window list for Telegram output.
   */
  formatWindowList(windows: WindowInfo[]): string {
    if (windows.length === 0) {
      return 'No windows found.\n\nMake sure Screen Recording permission is granted in:\nSystem Preferences > Privacy & Security > Screen Recording';
    }

    const lines = ['Available windows:'];
    for (const win of windows) {
      lines.push(`  ${win.index}. ${win.owner} - ${win.name}`);
      lines.push(`     Size: ${win.bounds}`);
    }

    lines.push('');
    lines.push('Use /screenshot <index> to capture a window.');

    return lines.join('\n');
  }

  /**
   * Captures a screenshot of the specified window.
   *
   * @param windowIndex - The window index (1-based) from listWindows
   * @returns Screenshot result with file path or error
   */
  async captureWindow(windowIndex: number): Promise<ScreenshotResult> {
    await this.ensureOutputDir();

    // Get windows to find the window ID
    const windows = await this.listWindows();
    const window = windows.find(w => w.index === windowIndex);

    if (!window) {
      return {
        success: false,
        error: `Window ${windowIndex} not found. Use /screenshot to see available windows.`,
      };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `screenshot-${windowIndex}-${timestamp}.png`;
    const filePath = path.join(this.outputDir, filename);

    try {
      // screencapture -l uses window ID (CGWindowID)
      await execAsync(`screencapture -l ${window.id} "${filePath}"`);

      // Verify the file was created
      try {
        await fs.access(filePath);
        return { success: true, filePath };
      } catch {
        return {
          success: false,
          error: `Screenshot failed. Make sure Screen Recording permission is granted.`,
        };
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to capture screenshot: ${errMsg}`,
      };
    }
  }

  // Keep old method names for compatibility but redirect to window methods
  async listDisplays(): Promise<WindowInfo[]> {
    return this.listWindows();
  }

  formatDisplayList(windows: WindowInfo[]): string {
    return this.formatWindowList(windows);
  }

  async captureDisplay(index: number): Promise<ScreenshotResult> {
    return this.captureWindow(index);
  }
}
