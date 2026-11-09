/* Walks the running admin panel in a real headless Chrome and captures what it actually rendered.
 *
 *   node scripts/capture-panel.cjs                          # sign in, then every route
 *   node scripts/capture-panel.cjs --walk scripts/walks/qa.cjs
 *   node scripts/capture-panel.cjs --out ../Voiza-QA-Delivery/Admin --base http://localhost:5173
 *
 * Why this exists rather than a browser extension or a hand-driven session: the delivery brief asks
 * for screenshots of the running product, not mockups, and asks that a screen opening is not taken
 * as proof a feature works. So every capture is accompanied by the console errors and the failed
 * HTTP requests the page produced while it loaded, and the walk can click, fill and assert between
 * captures. A screen that renders beside a 500 is recorded as both, not as a pass.
 *
 * Chrome is driven over the DevTools protocol with Node's own WebSocket — no automation dependency,
 * and a throwaway profile so the operator's signed-in browser is never touched.
 *
 * Redaction is explicit. `--redact-phones` masks phone-shaped text before every capture; a walk can
 * also mask its own selectors. The manifest records which captures were redacted, because evidence
 * that silently was not is worse than evidence that says so.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PANEL_ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const BASE = arg('base', process.env.PANEL_URL || 'http://localhost:5173');
const OUT = path.resolve(arg('out', path.join(PANEL_ROOT, '..', 'Voiza-QA-Delivery', 'Admin')));
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const WIDTH = Number(arg('width', 1440));
const HEIGHT = Number(arg('height', 900));
const USERNAME = arg('username', process.env.ADMIN_USERNAME || 'admin');
const PASSWORD = arg('password', process.env.ADMIN_PASSWORD || 'voiza-admin');
const REDACT_PHONES = has('redact-phones');
const WALK = arg('walk', null);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// A DevTools connection: one page target, commands matched by id, events collected.
// ---------------------------------------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (waiter === undefined) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
        else waiter.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`could not attach to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const list = this.listeners.get(method) ?? [];
    list.push(listener);
    this.listeners.set(method, list);
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`page script threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  close() {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------
// Chrome, on a profile of its own
// ---------------------------------------------------------------------------
async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'voiza-panel-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  // Port 0 means Chrome picks one and writes it here; guessing a fixed port collides with whatever
  // else the machine is debugging.
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (fs.existsSync(portFile)) {
      const line = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (/^\d+$/.test(line)) { port = Number(line); break; }
    }
    if (child.exitCode !== null) throw new Error(`Chrome exited with ${child.exitCode} before it opened a debugging port`);
    await sleep(250);
  }
  if (port === null) { child.kill(); throw new Error('Chrome never wrote DevToolsActivePort'); }

  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find((target) => target.type === 'page');
  if (!page) { child.kill(); throw new Error('Chrome opened no page target'); }

  return { child, profile, port, cdp: await Cdp.connect(page.webSocketDebuggerUrl) };
}

// ---------------------------------------------------------------------------
// What the page did while it loaded — the half of the evidence a screenshot cannot show
// ---------------------------------------------------------------------------
const consoleErrors = [];
const consoleWarnings = [];
const failedRequests = [];
const requestUrls = new Map();

function watch(cdp) {
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error' && params.type !== 'warning') return;
    const entry = {
      type: params.type,
      text: params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 400),
    };
    // A warning is not a fault. Counting the two together would let a router's deprecation notice
    // read as a broken screen, and would hide a real error behind the noise of an expected one.
    (params.type === 'warning' ? consoleWarnings : consoleErrors).push(entry);
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    consoleErrors.push({ type: 'exception', text: (params.exceptionDetails.exception?.description ?? params.exceptionDetails.text).slice(0, 400) });
  });
  cdp.on('Network.requestWillBeSent', (params) => { requestUrls.set(params.requestId, params.request.url); });
  cdp.on('Network.responseReceived', (params) => {
    if (params.response.status < 400) return;
    failedRequests.push({ status: params.response.status, url: params.response.url.slice(0, 300) });
  });
  cdp.on('Network.loadingFailed', (params) => {
    // A cancelled request is a navigation, not a fault.
    if (params.canceled) return;
    failedRequests.push({ status: 0, url: (requestUrls.get(params.requestId) ?? '').slice(0, 300), error: params.errorText });
  });
}

/** Waits until the router has painted a heading and no spinner is left turning. */
async function settle(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(`(() => ({
      ready: document.readyState,
      heading: document.querySelector('main h1, h1')?.textContent?.trim() ?? null,
      spinning: document.querySelectorAll('.animate-spin').length,
      url: location.pathname,
      text: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 300),
    }))()`);
    if (last.ready === 'complete' && last.heading !== null && last.spinning === 0) return last;
    await sleep(250);
  }
  throw new Error(`the page never settled: ${JSON.stringify(last)}`);
}

/**
 * Masks phone-shaped text in place. Conservative on purpose: it only touches a run of digits that
 * starts with + or is 9–15 long with separators, so an amount, a count or a UUID is left alone.
 * Returns how many text nodes it changed, which goes into the manifest.
 */
async function maskPhones(cdp) {
  return cdp.evaluate(`(() => {
    const pattern = /\\+?\\d[\\d\\s().-]{7,16}\\d/g;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let changed = 0;
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue ?? '';
      if (!pattern.test(text)) continue;
      pattern.lastIndex = 0;
      node.nodeValue = text.replace(pattern, (match) => match.slice(0, 3) + '•••••' + match.slice(-2));
      changed += 1;
    }
    for (const input of document.querySelectorAll('input')) {
      if (input.type === 'password' || input.type === 'tel') { input.value = ''; changed += 1; }
    }
    return changed;
  })()`);
}

async function maskSelectors(cdp, selectors) {
  return cdp.evaluate(`(() => {
    let changed = 0;
    for (const selector of ${JSON.stringify(selectors)}) {
      for (const el of document.querySelectorAll(selector)) { el.textContent = '••••••'; changed += 1; }
    }
    return changed;
  })()`);
}

async function capture(cdp, name, { fullPage = true, redact = [] } = {}) {
  const state = await settle(cdp);
  let masked = 0;
  if (REDACT_PHONES) masked += await maskPhones(cdp);
  if (redact.length > 0) masked += await maskSelectors(cdp, redact);

  const file = `${name.replace(/[^A-Za-z0-9._-]+/g, '_')}.png`;
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(shot.data, 'base64'));

  const entry = {
    name,
    file,
    url: `${BASE}${state.url}`,
    heading: state.heading,
    capturedAt: new Date().toISOString(),
    viewport: `${WIDTH}x${HEIGHT}`,
    fullPage,
    redacted: masked > 0,
    maskedNodes: masked,
    // Drained per capture so each screenshot carries only what its own page produced.
    consoleErrors: consoleErrors.splice(0),
    consoleWarnings: consoleWarnings.splice(0),
    failedRequests: failedRequests.splice(0),
  };
  process.stdout.write(`CAPTURE ${file}  "${state.heading}"  errors=${entry.consoleErrors.length} warnings=${entry.consoleWarnings.length} failed=${entry.failedRequests.length}${masked > 0 ? `  redacted=${masked}` : ''}\n`);
  return entry;
}

// ---------------------------------------------------------------------------
// Signing in through the product's own form, not by planting a token
// ---------------------------------------------------------------------------
async function signIn(cdp) {
  await cdp.send('Page.navigate', { url: `${BASE}/login` });
  await settle(cdp);
  await cdp.evaluate(`(() => {
    const set = (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error('no field at ' + selector);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('input[type=text], input:not([type])', ${JSON.stringify(USERNAME)});
    set('input[type=password]', ${JSON.stringify(PASSWORD)});
  })()`);
  await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Sign in');
    if (!button) throw new Error('no Sign in button');
    button.click();
  })()`);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const at = await cdp.evaluate('location.pathname');
    if (at !== '/login') return;
    await sleep(250);
  }
  const message = await cdp.evaluate(`document.body.innerText.slice(0, 400)`);
  throw new Error(`sign-in did not leave /login: ${message}`);
}

/** Every route the sidebar can reach, read from the running app rather than copied from App.tsx. */
async function discoverRoutes(cdp) {
  return cdp.evaluate(`(() => Array.from(document.querySelectorAll('nav a[href], aside a[href]'))
    .map((a) => a.getAttribute('href'))
    .filter((href) => href && href.startsWith('/') && !href.startsWith('//'))
    .filter((href, at, all) => all.indexOf(href) === at))()`);
}

const DEFAULT_ROUTES = [
  '/', '/users', '/moderation', '/rooms', '/gifts', '/media', '/banners', '/decor', '/emoji',
  '/ranks', '/quests', '/withdrawals', '/games', '/partners', '/applications', '/recharges',
  '/commissions', '/agencies', '/finance', '/accounts', '/operators', '/qa', '/audit',
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { child, profile, cdp } = await launchChrome();
  const manifest = {
    startedAt: new Date().toISOString(),
    base: BASE,
    out: OUT,
    viewport: `${WIDTH}x${HEIGHT}`,
    chrome: CHROME,
    redactPhones: REDACT_PHONES,
    walk: WALK,
    captures: [],
    assertions: [],
  };

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    watch(cdp);

    await cdp.send('Page.navigate', { url: `${BASE}/login` });
    manifest.captures.push(await capture(cdp, '00-login', { redact: ['input[type=password]'] }));
    await signIn(cdp);
    await settle(cdp);

    if (WALK !== null) {
      const steps = require(path.resolve(WALK));
      if (!Array.isArray(steps)) throw new Error(`${WALK} must export an array of steps`);
      for (const step of steps) {
        if (step.action === 'navigate') {
          await cdp.send('Page.navigate', { url: `${BASE}${step.path}` });
        } else if (step.action === 'click') {
          await cdp.evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(step.selector)});
            if (!el) throw new Error('nothing to click at ' + ${JSON.stringify(step.selector)});
            el.click();
          })()`);
        } else if (step.action === 'clickText') {
          await cdp.evaluate(`(() => {
            const root = ${step.within ? `document.querySelector(${JSON.stringify(step.within)})` : 'document'};
            if (!root) throw new Error('no container at ' + ${JSON.stringify(step.within ?? 'document')});
            const el = Array.from(root.querySelectorAll(${JSON.stringify(step.selector ?? 'button')}))
              .find((node) => node.textContent.trim() === ${JSON.stringify(step.text)});
            if (!el) throw new Error('no clickable text ' + ${JSON.stringify(step.text)});
            el.click();
          })()`);
        } else if (step.action === 'fill') {
          await cdp.evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(step.selector)});
            if (!el) throw new Error('no field at ' + ${JSON.stringify(step.selector)});
            const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(step.value)});
            el.dispatchEvent(new Event('input', { bubbles: true }));
          })()`);
        } else if (step.action === 'select') {
          await cdp.evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(step.selector)});
            if (!el) throw new Error('no select at ' + ${JSON.stringify(step.selector)});
            Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(step.value)});
            el.dispatchEvent(new Event('change', { bubbles: true }));
          })()`);
        } else if (step.action === 'assert') {
          const value = await cdp.evaluate(step.expression);
          const passed = step.equals === undefined ? Boolean(value) : JSON.stringify(value) === JSON.stringify(step.equals);
          manifest.assertions.push({ name: step.name, passed, value, expected: step.equals });
          process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${step.name}  :: ${JSON.stringify(value).slice(0, 200)}\n`);
        } else if (step.action === 'waitFor') {
          // Polls rather than sleeps: a fixed delay either wastes the run or asserts against a
          // half-loaded table and reports a fault that is really the harness being impatient.
          const deadline = Date.now() + (step.timeoutMs ?? 20000);
          let value = null;
          let passed = false;
          while (Date.now() < deadline) {
            value = await cdp.evaluate(step.expression);
            passed = step.equals === undefined ? Boolean(value) : JSON.stringify(value) === JSON.stringify(step.equals);
            if (passed) break;
            await sleep(200);
          }
          manifest.assertions.push({ name: step.name, passed, value, expected: step.equals, waited: true });
          process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${step.name}  :: ${JSON.stringify(value).slice(0, 200)}\n`);
        } else if (step.action === 'scroll') {
          // The shell scrolls inside <main>, not on the document, so a full-page screenshot is only
          // ever one viewport tall. A walk scrolls the container itself to put the part it is
          // asserting about actually inside the frame.
          await cdp.evaluate(`(() => {
            const box = document.querySelector(${JSON.stringify(step.selector ?? 'main')});
            if (!box) throw new Error('nothing to scroll at ' + ${JSON.stringify(step.selector ?? 'main')});
            if (${JSON.stringify(step.intoView ?? null)} !== null) {
              const target = document.querySelector(${JSON.stringify(step.intoView ?? null)});
              if (!target) throw new Error('no scroll target at ' + ${JSON.stringify(step.intoView ?? null)});
              box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - ${Number(step.offset ?? 8)};
            } else if (${step.bottom === true}) {
              box.scrollTop = box.scrollHeight;
            } else {
              box.scrollTop = ${Number(step.top ?? 0)};
            }
          })()`);
        } else if (step.action === 'eval') {
          await cdp.evaluate(step.expression);
        } else if (step.action === 'wait') {
          await sleep(step.ms ?? 500);
        } else if (step.action !== 'capture') {
          throw new Error(`unknown step action ${step.action}`);
        }
        if (step.wait !== false && step.action !== 'wait' && step.action !== 'assert' && step.action !== 'waitFor') await sleep(step.settleMs ?? 700);
        if (step.capture === true || step.action === 'capture') {
          manifest.captures.push(await capture(cdp, step.name, { fullPage: step.fullPage !== false, redact: step.redact ?? [] }));
        }
      }
    } else {
      const discovered = await discoverRoutes(cdp);
      const routes = discovered.length > 0 ? discovered : DEFAULT_ROUTES;
      manifest.routes = routes;
      let index = 1;
      for (const route of routes) {
        await cdp.send('Page.navigate', { url: `${BASE}${route}` });
        const name = `${String(index).padStart(2, '0')}-${route === '/' ? 'overview' : route.replace(/^\//, '').replace(/\//g, '-')}`;
        manifest.captures.push(await capture(cdp, name));
        index += 1;
      }
    }
  } catch (error) {
    manifest.error = String(error.stack ?? error);
    process.stderr.write(`PANEL CAPTURE ERROR ${manifest.error}\n`);
    process.exitCode = 1;
  } finally {
    manifest.finishedAt = new Date().toISOString();
    manifest.failedAssertions = manifest.assertions.filter((a) => !a.passed).length;
    manifest.capturesWithErrors = manifest.captures.filter((c) => c.consoleErrors.length > 0 || c.failedRequests.length > 0).length;
    manifest.capturesWithWarnings = manifest.captures.filter((c) => c.consoleWarnings.length > 0).length;
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
    cdp.close();
    child.kill();
    // The throwaway profile holds a session cookie for a development operator; it does not outlive the
    // run. Chrome on Windows keeps a handle open for a moment after exit, so a failed tidy-up is
    // reported rather than allowed to replace the run's own error with a permission one.
    let removed = false;
    for (let attempt = 0; attempt < 6 && !removed; attempt += 1) {
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        removed = true;
      } catch {
        await sleep(400);
      }
    }
    manifest.profileRemoved = removed;
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
    if (!removed) process.stderr.write(`NOTE: the throwaway Chrome profile could not be deleted: ${profile}\n`);
  }

  process.stdout.write(`\n${manifest.captures.length} capture(s) in ${OUT}\n`);
  process.stdout.write(`${manifest.assertions.length - manifest.failedAssertions}/${manifest.assertions.length} assertions passed\n`);
  process.stdout.write(`${manifest.capturesWithErrors} capture(s) recorded a console error or a failed request — read manifest.json before calling any of them a pass\n`);
  process.stdout.write(`${manifest.capturesWithWarnings} capture(s) recorded a console warning; warnings are listed separately and are not counted as faults\n`);
  if (manifest.failedAssertions > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`PANEL CAPTURE CRASH ${error.stack ?? error}\n`);
  process.exitCode = 1;
});