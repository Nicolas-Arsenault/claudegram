/**
 * Screenshot Capture Module
 *
 * Captures screenshots on macOS.
 *
 * Uses native macOS screencapture tool.
 *
 * IMPORTANT: Requires Screen Recording permission in System Preferences > Privacy & Security
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

export interface DisplayInfo {
  index: number;
  name: string;
  resolution: string;
  isMain: boolean;
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
   * Lists available displays using system_profiler.
   */
  async listDisplays(): Promise<DisplayInfo[]> {
    try {
      const { stdout } = await execAsync('system_profiler SPDisplaysDataType -json');
      const data = JSON.parse(stdout);

      const displays: DisplayInfo[] = [];
      let index = 1;

      for (const gpu of data.SPDisplaysDataType || []) {
        for (const display of gpu.spdisplays_ndrvs || []) {
          displays.push({
            index: index++,
            name: display._name || 'Unknown Display',
            resolution: display._spdisplays_resolution || 'Unknown',
            isMain: display.spdisplays_main === 'spdisplays_yes',
          });
        }
      }

      return displays;
    } catch (error) {
      // Fallback: assume at least one display exists
      return [{
        index: 1,
        name: 'Main Display',
        resolution: 'Unknown',
        isMain: true,
      }];
    }
  }

  /**
   * Formats display list for Telegram output.
   */
  formatDisplayList(displays: DisplayInfo[]): string {
    if (displays.length === 0) {
      return 'No displays found.';
    }

    const lines = ['Available displays:'];
    for (const display of displays) {
      const mainIndicator = display.isMain ? ' (Main)' : '';
      lines.push(`  ${display.index}. ${display.name}${mainIndicator}`);
      lines.push(`     ${display.resolution}`);
    }

    lines.push('');
    lines.push('Use /screenshot <n> to capture display n.');
    lines.push('');
    lines.push('Note: Requires Screen Recording permission in');
    lines.push('System Settings > Privacy & Security');

    return lines.join('\n');
  }

  /**
   * Captures a screenshot of the specified display.
   *
   * @param displayIndex - The display index (1-based)
   * @returns Screenshot result with file path or error
   */
  async captureDisplay(displayIndex: number): Promise<ScreenshotResult> {
    await this.ensureOutputDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `screenshot-${displayIndex}-${timestamp}.png`;
    const filePath = path.join(this.outputDir, filename);

    try {
      // screencapture -D uses 1-based display index
      // -x suppresses sound
      await execAsync(`screencapture -x -D ${displayIndex} "${filePath}"`);

      // Verify the file was created and has content
      try {
        const stats = await fs.stat(filePath);
        if (stats.size > 0) {
          return { success: true, filePath };
        }
        // Empty file means permission denied or invalid display
        await fs.unlink(filePath).catch(() => {});
        return {
          success: false,
          error: 'Screenshot failed. Grant Screen Recording permission in System Settings > Privacy & Security.',
        };
      } catch {
        return {
          success: false,
          error: `Display ${displayIndex} not found or permission denied.`,
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

  /**
   * Captures the main display.
   */
  async captureMainDisplay(): Promise<ScreenshotResult> {
    return this.captureDisplay(1);
  }
}
