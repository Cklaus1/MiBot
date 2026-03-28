import type { Page, Frame } from 'playwright';
import type { CamofoxPage } from './camofox.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Types ─────────────────────────────────────────────────────────────

export interface PlaybookStep {
  action: 'click' | 'fill' | 'type' | 'wait' | 'screenshot' | 'press' | 'try' | 'log' | 'goto' | 'eval' | 'js_click';
  // Targeting
  text?: string;           // Match by visible text
  role?: string;           // ARIA role (button, textbox, etc.)
  name?: string;           // ARIA name for role
  selector?: string;       // CSS selector
  xpath?: string;          // XPath
  near_text?: string;      // Find input near this text label (xpath=following::input[1])
  frame?: 'main' | 'any' | string;  // Which frame to search (default: any)
  // Options
  url?: string;            // URL for goto action (supports {{var}} interpolation)
  wait_for?: string;       // For goto: wait for this text/selector after navigation (frame: any)
  value?: string;          // Value for fill/type (supports {{var}} interpolation)
  key?: string;            // Key for press (Enter, Tab, Escape, etc.)
  expression?: string;     // JavaScript expression for eval action
  exact?: boolean;         // Exact text match
  force?: boolean;         // Force click even if covered
  timeout?: number;        // Step timeout in ms (default: 10000)
  delay?: number;          // Delay in ms for wait action
  path?: string;           // File path for screenshot
  message?: string;        // Message for log action
  // Branching
  steps?: PlaybookStep[];  // Sub-steps for 'try' (tries each until one succeeds)
  optional?: boolean;      // Don't fail if step doesn't match (default: false)
}

export interface Playbook {
  name: string;
  platform: string;
  browser?: 'playwright' | 'camofox';  // Browser backend (default: playwright)
  variables?: Record<string, string>;
  steps: PlaybookStep[];
}

// ── Camofox Playbook Engine ───────────────────────────────────────────

/** Playbook engine for camofox-backed browsers (Google Meet). */
export class CamofoxPlaybookEngine {
  private page: CamofoxPage;
  private vars: Record<string, string>;

  constructor(page: CamofoxPage, variables: Record<string, string> = {}) {
    this.page = page;
    this.vars = variables;
  }

  async run(playbook: Playbook): Promise<void> {
    this.vars = { ...playbook.variables, ...this.vars };
    console.error(`[playbook] Running: ${playbook.name} (${playbook.steps.length} steps, camofox)`);

    for (let i = 0; i < playbook.steps.length; i++) {
      const step = playbook.steps[i];
      try {
        await this.executeStep(step, i + 1);
      } catch (err) {
        if (step.optional) {
          console.error(`[playbook] Step ${i + 1} (optional) skipped: ${(err as Error).message}`);
        } else {
          console.error(`[playbook] Step ${i + 1} FAILED: ${(err as Error).message}`);
          throw err;
        }
      }
    }
    console.error(`[playbook] Complete: ${playbook.name}`);
  }

  private async executeStep(step: PlaybookStep, num: number): Promise<void> {
    const timeout = step.timeout || 10000;

    switch (step.action) {
      case 'log':
        console.error(`[playbook] ${this.interpolate(step.message || '')}`);
        return;

      case 'goto': {
        const url = this.interpolate(step.url || '');
        await this.page.goto(url);
        console.error(`[playbook] Step ${num}: navigated to ${url.substring(0, 60)}`);
        if (step.wait_for) {
          const waitText = this.interpolate(step.wait_for);
          const start = Date.now();
          while (Date.now() - start < timeout) {
            if (await this.page.isTextVisible(waitText)) return;
            await this.page.waitForTimeout(1000);
          }
          console.error(`[playbook] Step ${num}: wait_for "${waitText}" not found (continuing)`);
        }
        return;
      }

      case 'wait':
        if (step.delay) {
          await this.page.waitForTimeout(step.delay);
          return;
        }
        if (step.text) {
          const start = Date.now();
          while (Date.now() - start < timeout) {
            if (await this.page.isTextVisible(step.text)) {
              console.error(`[playbook] Step ${num}: found "${step.text}"`);
              return;
            }
            await this.page.waitForTimeout(1000);
          }
          throw new Error(`Timeout waiting for "${step.text}"`);
        }
        if (step.selector) {
          // Wait for selector via eval
          const start = Date.now();
          while (Date.now() - start < timeout) {
            const found = await this.page.eval(`!!document.querySelector('${step.selector.replace(/'/g, "\\'")}')`);
            if (found) {
              console.error(`[playbook] Step ${num}: found ${step.selector}`);
              return;
            }
            await this.page.waitForTimeout(1000);
          }
          throw new Error(`Timeout waiting for ${step.selector}`);
        }
        return;

      case 'click': {
        const clicked = await this.clickElement(step, timeout);
        if (!clicked) throw new Error(`Could not click ${this.describeTarget(step)}`);
        console.error(`[playbook] Step ${num}: clicked ${this.describeTarget(step)}`);
        return;
      }

      case 'js_click': {
        // Click via JavaScript — for buttons that don't respond to Playwright/ref clicks (e.g., Meet's Join)
        const expr = step.expression ? this.interpolate(step.expression) : this.buildJsClickExpr(step);
        const result = await this.page.eval(expr);
        if (result === 'not found') throw new Error(`js_click: ${this.describeTarget(step)} not found`);
        console.error(`[playbook] Step ${num}: js_click ${result}`);
        return;
      }

      case 'fill': {
        const value = this.interpolate(step.value || '');
        const target = step.text || step.near_text || step.selector || '';
        const ref = await this.page.findRef(target);
        if (!ref) throw new Error(`Could not find field "${target}"`);
        await this.page.typeRef(ref, value);
        console.error(`[playbook] Step ${num}: filled "${target}" with "${value}"`);
        return;
      }

      case 'type': {
        const value = this.interpolate(step.value || '');
        const target = step.text || step.near_text || step.selector || '';
        if (target) {
          const ref = await this.page.findRef(target);
          if (ref) await this.page.clickRef(ref);
        }
        // Type character by character via eval
        await this.page.eval(`
          const el = document.activeElement;
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
            el.value = '${value.replace(/'/g, "\\'")}';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        `);
        console.error(`[playbook] Step ${num}: typed "${value}"`);
        return;
      }

      case 'press':
        await this.page.eval(`
          document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: '${step.key || 'Enter'}', bubbles: true }));
          document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', { key: '${step.key || 'Enter'}', bubbles: true }));
        `);
        console.error(`[playbook] Step ${num}: pressed ${step.key}`);
        return;

      case 'screenshot': {
        const screenshotPath = step.path || `/tmp/mibot-step-${num}.png`;
        await this.page.screenshot({ path: screenshotPath });
        console.error(`[playbook] Step ${num}: screenshot → ${screenshotPath}`);
        return;
      }

      case 'eval': {
        const expr = this.interpolate(step.expression || '');
        const result = await this.page.eval(expr);
        console.error(`[playbook] Step ${num}: eval → ${String(result).substring(0, 100)}`);
        return;
      }

      case 'try': {
        if (!step.steps || step.steps.length === 0) return;
        let lastErr: Error | null = null;
        for (let j = 0; j < step.steps.length; j++) {
          try {
            const childStep = step.steps[j].timeout ? step.steps[j] : { ...step.steps[j], timeout };
            await this.executeStep(childStep, num);
            return;
          } catch (err) {
            lastErr = err as Error;
          }
        }
        if (!step.optional) {
          throw lastErr || new Error('All try alternatives failed');
        }
        return;
      }

      default:
        throw new Error(`Unknown action: ${step.action}`);
    }
  }

  /** Click an element using camofox ref-based clicking. */
  private async clickElement(step: PlaybookStep, timeout: number): Promise<boolean> {
    const target = step.text || step.name || step.selector || '';
    if (!target) return false;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const ref = await this.page.findRef(target);
      if (ref) {
        await this.page.clickRef(ref);
        return true;
      }
      await this.page.waitForTimeout(1000);
    }
    return false;
  }

  /** Build a JS expression to click a button by text. */
  private buildJsClickExpr(step: PlaybookStep): string {
    const texts = [step.text, step.name].filter(Boolean);
    if (texts.length === 0) {
      if (step.selector) {
        return `(() => { const el = document.querySelector('${step.selector.replace(/'/g, "\\'")}'); if (el) { el.click(); return 'clicked: ' + el.textContent?.trim(); } return 'not found'; })()`;
      }
      return "'not found'";
    }
    const conditions = texts.map(t => `b.textContent?.includes('${t!.replace(/'/g, "\\'")}')`).join(' || ');
    return `(() => { const btns = Array.from(document.querySelectorAll('button')); const btn = btns.find(b => ${conditions}); if (btn) { btn.click(); return 'clicked: ' + btn.textContent?.trim(); } return 'not found'; })()`;
  }

  private interpolate(str: string): string {
    return str.replace(/\{\{(\w+)\}\}/g, (_, key) => this.vars[key] || `{{${key}}}`);
  }

  private describeTarget(step: PlaybookStep): string {
    if (step.text) return `"${step.text}"`;
    if (step.name) return `name="${step.name}"`;
    if (step.selector) return step.selector;
    if (step.near_text) return `near "${step.near_text}"`;
    return '(element)';
  }
}

// ── Playwright Playbook Engine ────────────────────────────────────────

export class PlaybookEngine {
  private page: Page;
  private vars: Record<string, string>;

  constructor(page: Page, variables: Record<string, string> = {}) {
    this.page = page;
    this.vars = variables;
  }

  /** Load a playbook from a JSON file. */
  static load(filePath: string): Playbook {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  }

  /** Load a playbook by platform name from the playbooks directory. */
  static loadForPlatform(platform: string): Playbook | null {
    const dirs = [
      path.join(os.homedir(), '.config', 'mibot', 'playbooks'),
      path.join(process.cwd(), 'playbooks'),
    ];
    for (const dir of dirs) {
      for (const ext of ['.json']) {
        const p = path.join(dir, `${platform}${ext}`);
        if (fs.existsSync(p)) return PlaybookEngine.load(p);
      }
    }
    return null;
  }

  /** Run all steps in a playbook. */
  async run(playbook: Playbook): Promise<void> {
    this.vars = { ...playbook.variables, ...this.vars };
    console.error(`[playbook] Running: ${playbook.name} (${playbook.steps.length} steps)`);

    for (let i = 0; i < playbook.steps.length; i++) {
      const step = playbook.steps[i];
      try {
        await this.executeStep(step, i + 1);
      } catch (err) {
        if (step.optional) {
          console.error(`[playbook] Step ${i + 1} (optional) skipped: ${(err as Error).message}`);
        } else {
          console.error(`[playbook] Step ${i + 1} FAILED: ${(err as Error).message}`);
          throw err;
        }
      }
    }
    console.error(`[playbook] Complete: ${playbook.name}`);
  }

  /** Execute a single step. */
  private async executeStep(step: PlaybookStep, num: number): Promise<void> {
    const timeout = step.timeout || 10000;

    switch (step.action) {
      case 'log':
        console.error(`[playbook] ${this.interpolate(step.message || '')}`);
        return;

      case 'goto': {
        const url = this.interpolate(step.url || '');
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout }).catch(() => {
          console.error(`[playbook] Step ${num}: navigation timeout (continuing anyway)`);
        });
        console.error(`[playbook] Step ${num}: navigated to ${url.substring(0, 60)}`);
        if (step.wait_for) {
          const waitText = this.interpolate(step.wait_for);
          const frames = this.getFrames('any');
          let found = false;
          for (const frame of frames) {
            const loc = frame.locator(`text=${waitText}`).first();
            if (await loc.isVisible({ timeout }).catch(() => false)) {
              found = true;
              break;
            }
          }
          if (!found) {
            console.error(`[playbook] Step ${num}: wait_for "${waitText}" not found (continuing)`);
          }
        }
        return;
      }

      case 'wait':
        if (step.delay) {
          await this.page.waitForTimeout(step.delay);
          return;
        }
        if (step.text || step.selector || step.role) {
          const loc = await this.findElement(step);
          await loc.waitFor({ state: 'visible', timeout });
          console.error(`[playbook] Step ${num}: waited for element`);
        }
        return;

      case 'click': {
        const loc = await this.findElement(step);
        await loc.click({ force: step.force, timeout });
        console.error(`[playbook] Step ${num}: clicked ${this.describeTarget(step)}`);
        return;
      }

      case 'js_click': {
        // For Playwright, fall back to regular evaluate
        const expr = step.expression ? this.interpolate(step.expression) : `(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const btn = btns.find(b => b.textContent?.includes('${(step.text || step.name || '').replace(/'/g, "\\'")}'));
          if (btn) { btn.click(); return 'clicked: ' + btn.textContent?.trim(); }
          return 'not found';
        })()`;
        const result = await this.page.evaluate(expr);
        if (result === 'not found') throw new Error(`js_click: ${this.describeTarget(step)} not found`);
        console.error(`[playbook] Step ${num}: js_click ${result}`);
        return;
      }

      case 'fill': {
        const loc = await this.findElement(step);
        await loc.click({ timeout });
        await loc.fill(this.interpolate(step.value || ''));
        console.error(`[playbook] Step ${num}: filled ${this.describeTarget(step)}`);
        return;
      }

      case 'type': {
        const value = this.interpolate(step.value || '');
        if (step.text || step.selector || step.role || step.near_text) {
          const loc = await this.findElement(step);
          await loc.click({ timeout });
        }
        await this.page.keyboard.type(value);
        console.error(`[playbook] Step ${num}: typed "${value}"`);
        return;
      }

      case 'press':
        await this.page.keyboard.press(step.key || 'Enter');
        console.error(`[playbook] Step ${num}: pressed ${step.key}`);
        return;

      case 'screenshot': {
        const screenshotPath = step.path || `/tmp/mibot-step-${num}.png`;
        await this.page.screenshot({ path: screenshotPath });
        console.error(`[playbook] Step ${num}: screenshot → ${screenshotPath}`);
        return;
      }

      case 'eval': {
        const expr = this.interpolate(step.expression || '');
        const result = await this.page.evaluate(expr);
        console.error(`[playbook] Step ${num}: eval → ${String(result).substring(0, 100)}`);
        return;
      }

      case 'try': {
        if (!step.steps || step.steps.length === 0) return;
        let lastErr: Error | null = null;
        for (let j = 0; j < step.steps.length; j++) {
          try {
            const childStep = step.steps[j].timeout ? step.steps[j] : { ...step.steps[j], timeout };
            await this.executeStep(childStep, num);
            return;
          } catch (err) {
            lastErr = err as Error;
          }
        }
        if (!step.optional) {
          throw lastErr || new Error('All try alternatives failed');
        }
        return;
      }

      default:
        throw new Error(`Unknown action: ${step.action}`);
    }
  }

  /** Find an element across frames based on step targeting options. */
  private async findElement(step: PlaybookStep) {
    const frames = this.getFrames(step.frame);

    for (const frame of frames) {
      try {
        const loc = this.buildLocator(frame, step);
        if (await loc.isVisible({ timeout: Math.min(step.timeout || 10000, 5000) }).catch(() => false)) {
          return loc;
        }
      } catch {
        continue;
      }
    }

    return this.buildLocator(frames[frames.length - 1], step);
  }

  /** Build a Playwright locator from step targeting options. */
  private buildLocator(frame: Page | Frame, step: PlaybookStep) {
    if (step.role) {
      const opts: any = {};
      if (step.name) opts.name = step.name;
      if (step.exact) opts.exact = true;
      return frame.getByRole(step.role as any, opts);
    }
    if (step.near_text) {
      return frame.locator(`text=${step.near_text}`).locator('xpath=following::input[1]');
    }
    if (step.xpath) {
      return frame.locator(`xpath=${step.xpath}`);
    }
    if (step.selector) {
      return frame.locator(step.selector);
    }
    if (step.text) {
      if (step.exact) {
        return frame.getByText(step.text, { exact: true });
      }
      return frame.locator(`text=${step.text}`).first();
    }
    throw new Error('Step has no targeting: need text, role, selector, xpath, or near_text');
  }

  /** Get frames to search based on the frame option. */
  private getFrames(frameOpt?: string): (Page | Frame)[] {
    if (!frameOpt || frameOpt === 'any') {
      return [this.page, ...this.page.frames().filter(f => f !== this.page.mainFrame())];
    }
    if (frameOpt === 'main') {
      return [this.page];
    }
    const matching = this.page.frames().filter(f => f.url().includes(frameOpt));
    return matching.length > 0 ? matching : [this.page];
  }

  /** Interpolate {{var}} placeholders in a string. */
  private interpolate(str: string): string {
    return str.replace(/\{\{(\w+)\}\}/g, (_, key) => this.vars[key] || `{{${key}}}`);
  }

  /** Describe a step's target for logging. */
  private describeTarget(step: PlaybookStep): string {
    if (step.text) return `"${step.text}"`;
    if (step.role) return `role=${step.role}${step.name ? ` name="${step.name}"` : ''}`;
    if (step.selector) return step.selector;
    if (step.near_text) return `near "${step.near_text}"`;
    return '(element)';
  }
}
