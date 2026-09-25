#!/usr/bin/env node
/* global WebSocket, fetch, process, console, setTimeout, clearTimeout */

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const POLL_INTERVAL_MS = 100;
// 探针通过后继续监听网络的驻留窗口:子框架(iframe srcdoc)与延时发出的请求往往晚于首屏挂载,
// 探针一返回就判定会漏掉它们(GAP-6-13)。可用 RELEASE_GATE_SETTLE_MS 调整,下限 500ms。
const SETTLE_MS = Math.max(500, Number(process.env.RELEASE_GATE_SETTLE_MS) || 3_000);
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
const OFFLINE_CONDITIONS = {
  offline: true,
  latency: 0,
  downloadThroughput: 0,
  uploadThroughput: 0,
  connectionType: 'none',
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function executable(pathname) {
  try {
    await access(pathname, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  const configured = process.env.CHROME_BIN?.trim();
  const candidates = [
    configured,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate;
  }
  throw new Error(`未找到 Chrome/Chromium；可通过 CHROME_BIN 指定。已检查：${candidates.join(', ')}`);
}

async function waitForDevToolsPort(userDataDirectory, browser, stderr) {
  const activePort = path.join(userDataDirectory, 'DevToolsActivePort');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (browser.exitCode != null) {
      throw new Error(`Chrome 在 DevTools 启动前退出 (${browser.exitCode})：${stderr()}`);
    }
    try {
      const [portLine] = (await readFile(activePort, 'utf8')).trim().split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* Chrome 尚未写入 DevToolsActivePort */ }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`等待 Chrome DevTools 端口超时：${stderr()}`);
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Set();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id != null) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.eventListeners) listener(message);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Chrome DevTools 连接关闭 (${pending.method})`));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('无法连接 Chrome DevTools WebSocket')), { once: true });
    });
    return new CdpClient(socket);
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
  }

  /** sessionId:flatten 模式下发给自动附加的子 target(子框架/worker)。 */
  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools 命令超时：${method}`));
      }, 10_000);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text
        ?? '未知浏览器表达式异常';
      throw new Error(detail);
    }
    return response.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function pageTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`无法读取 Chrome target 列表：HTTP ${response.status}`);
  const targets = await response.json();
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) throw new Error('Chrome 未创建可调试页面 target');
  return page.webSocketDebuggerUrl;
}

const PORTABLE_PROBE = `(() => {
  const root = document.querySelector('.app-root');
  if (!root) return null;
  const main = root.querySelector('main');
  const blocker = document.querySelector('[role="alert"]');
  const rect = root.getBoundingClientRect();
  return {
    status: 'passed',
    rootChildren: root.children.length,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    menuButtons: root.querySelectorAll('.menu-bar button').length,
    toolbarButtons: root.querySelectorAll('.toolbar button').length,
    sideNavButtons: root.querySelectorAll('.side-nav button').length,
    hasMain: Boolean(main),
    mainTextLength: (main?.textContent ?? '').trim().length,
    hasPageHeader: Boolean(root.querySelector('.page-header')),
    hasPageContent: Boolean(root.querySelector('.page-content')),
    blocker: blocker?.textContent?.trim() ?? null,
  };
})()`;

function validatePortable(result) {
  if (!result || result.status !== 'passed') throw new Error('便携版未挂载 .app-root');
  if (result.blocker) throw new Error(`便携版命中启动阻断：${result.blocker}`);
  if (!result.hasMain || !result.hasPageHeader || !result.hasPageContent) {
    throw new Error(`便携版主界面结构不完整：${JSON.stringify(result)}`);
  }
  if (result.rootChildren < 4 || result.menuButtons < 8 || result.toolbarButtons < 4 || result.sideNavButtons < 5) {
    throw new Error(`便携版只是空壳或关键 UI 缺失：${JSON.stringify(result)}`);
  }
  if (result.width < 300 || result.height < 300 || result.mainTextLength < 40) {
    throw new Error(`便携版没有可见的实质内容：${JSON.stringify(result)}`);
  }
}

async function waitForResult(client, mode, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  const expression = mode === 'office'
    ? 'globalThis.__RELEASE_GATE_RESULT__ ?? null'
    : PORTABLE_PROBE;
  while (Date.now() < deadline) {
    const result = await client.evaluate(expression);
    if (result) return result;
    await delay(POLL_INTERVAL_MS);
  }
  const diagnostic = await client.evaluate(`({
    readyState: document.readyState,
    title: document.title,
    text: (document.body?.innerText ?? '').slice(0, 1200),
    html: (document.documentElement?.outerHTML ?? '').slice(0, 1200),
  })`);
  throw new Error(`${mode} 浏览器门禁等待超时：${JSON.stringify(diagnostic)}`);
}

async function stopBrowser(browser) {
  if (!browser || browser.exitCode != null) return;
  browser.kill('SIGTERM');
  const exited = new Promise((resolve) => browser.once('exit', resolve));
  await Promise.race([exited, delay(2_000)]);
  if (browser.exitCode == null) browser.kill('SIGKILL');
}

async function run() {
  const [mode, artifactArgument] = process.argv.slice(2);
  if (!['portable', 'office'].includes(mode) || !artifactArgument) {
    throw new Error('用法：run_browser_gate.mjs <portable|office> <html-file>');
  }
  const artifact = path.resolve(artifactArgument);
  await access(artifact, fsConstants.R_OK);
  const chrome = await findChrome();
  const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'quality-release-chrome-'));
  let browser;
  let client;
  let stderrText = '';
  try {
    browser = spawn(chrome, [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--user-data-dir=${userDataDirectory}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.on('data', (chunk) => {
      stderrText = (stderrText + String(chunk)).slice(-20_000);
    });
    const port = await waitForDevToolsPort(userDataDirectory, browser, () => stderrText);
    client = await CdpClient.connect(await pageTarget(port));
    const browserErrors = [];
    const externalRequests = [];
    const recordRequest = (url) => {
      if (/^(?:https?|wss?|ftp):/i.test(url)) externalRequests.push(url);
    };
    // 子 target(跨进程子框架、worker 等)自动附加:同样离线、同样上报网络请求,再放行执行。
    const attachChild = async (sessionId) => {
      const steps = [
        ['Network.enable', {}],
        ['Network.setCacheDisabled', { cacheDisabled: true }],
        ['Network.emulateNetworkConditions', OFFLINE_CONDITIONS],
        ['Target.setAutoAttach', AUTO_ATTACH],
      ];
      for (const [method, params] of steps) {
        // 部分 target 类型不支持某些域(例如 service worker 不支持缓存开关),不支持即跳过。
        await client.send(method, params, sessionId).catch(() => {});
      }
      await client.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    };
    client.onEvent((event) => {
      if (event.method === 'Target.attachedToTarget') {
        attachChild(event.params.sessionId).catch((error) => browserErrors.push(`子 target 附加失败：${error.message}`));
        return;
      }
      if (event.method === 'Network.requestWillBeSent') {
        recordRequest(event.params.request.url);
        return;
      }
      if (event.method === 'Network.webSocketCreated') {
        recordRequest(event.params.url);
        return;
      }
      // 子 target 的控制台/异常不属于便携版主界面的启动错误口径,只收集网络证据。
      if (event.sessionId) return;
      if (event.method === 'Runtime.exceptionThrown') {
        browserErrors.push(event.params.exceptionDetails.exception?.description
          ?? event.params.exceptionDetails.text ?? '未捕获浏览器异常');
      } else if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
        browserErrors.push(event.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      } else if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
        browserErrors.push(event.params.entry.text);
      }
    });
    await Promise.all([
      client.send('Page.enable'),
      client.send('Runtime.enable'),
      client.send('Network.enable'),
      client.send('Log.enable'),
    ]);
    await client.send('Network.setCacheDisabled', { cacheDisabled: true });
    // 真正把页面置于离线网络栈；file:// 本体仍可加载，任何 HTTP(S) 依赖都会失败并被记录。
    await client.send('Network.emulateNetworkConditions', OFFLINE_CONDITIONS);
    // 同进程的 srcdoc 子框架请求经本页会话上报;跨进程子框架/worker 需自动附加才能看见。
    await client.send('Target.setAutoAttach', AUTO_ATTACH);
    const navigation = await client.send('Page.navigate', { url: pathToFileURL(artifact).href });
    if (navigation.errorText) throw new Error(`Chrome 无法打开 ${artifact}: ${navigation.errorText}`);
    const result = await waitForResult(client, mode, mode === 'office' ? 60_000 : 30_000);
    if (mode === 'portable') validatePortable(result);
    else if (result.status !== 'passed') throw new Error(`Office 浏览器门禁失败：${result.message ?? JSON.stringify(result)}`);
    // 驻留观察窗:探针通过后仍持续收集子框架与延时请求,再做「零外部请求」判定。
    await delay(SETTLE_MS);
    if (externalRequests.length > 0) {
      throw new Error(`离线门禁发现外部网络请求：${[...new Set(externalRequests)].join(', ')}`);
    }
    if (browserErrors.length > 0) {
      throw new Error(`浏览器出现启动/运行错误：${browserErrors.join(' | ')}`);
    }
    console.log(`${mode} browser gate passed offline via ${chrome}`);
    console.log(JSON.stringify(result));
  } finally {
    client?.close();
    await stopBrowser(browser);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
