/**
 * Shared Playwright scrape for pipeline job URLs (used by ollama-cv-pipeline + interview-prep).
 */
import { chromium } from 'playwright';
import { classifyLiveness } from './liveness-core.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrapeJobPage(page, url, log) {
  let response;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) log(`  → Navigation retry ${attempt}/3…`);
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      break;
    } catch (e) {
      const msg = e?.message || '';
      const retryable = /ERR_ABORTED|ERR_CONNECTION|TIMED_OUT|Timeout|timeout|net::/i.test(msg);
      if (attempt < 3 && retryable) {
        await sleep(500 * attempt);
        continue;
      }
      throw e;
    }
  }
  const status = response?.status() ?? 0;
  await sleep(2000);
  const finalUrl = page.url();
  log(`  → Page ready (HTTP ${status}). Extracting visible text…`);
  const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
  const applyControls = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]'),
    );
    return candidates
      .filter((element) => {
        if (element.closest('nav, header, footer')) return false;
        if (element.closest('[aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (!element.getClientRects().length) return false;
        return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
      })
      .map((element) => {
        const label = [element.innerText, element.value, element.getAttribute('aria-label'), element.getAttribute('title')]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        return label;
      })
      .filter(Boolean);
  });
  const live = classifyLiveness({ status, finalUrl, bodyText, applyControls });
  const jdSnippet = bodyText.slice(0, 14_000);
  return { live, jdSnippet, status, finalUrl };
}

let chromiumBrowser = null;

export async function closeChromiumBrowser() {
  if (chromiumBrowser) {
    await chromiumBrowser.close().catch(() => {});
    chromiumBrowser = null;
  }
}

export async function ensureChromium(forceRelaunch = false) {
  if (!forceRelaunch && chromiumBrowser) {
    try {
      if (chromiumBrowser.isConnected()) return chromiumBrowser;
    } catch {
      /* stale handle */
    }
  }
  await closeChromiumBrowser();
  chromiumBrowser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'],
  });
  return chromiumBrowser;
}

const SCRAPE_TOTAL_MS = Math.max(30_000, parseInt(process.env.SCRAPE_TIMEOUT_MS || '120000', 10) || 120_000);

/**
 * @param {string} url
 * @param {(line: string) => void} [log]
 */
export async function scrapePipelineJob(url, log = console.log) {
  async function once() {
    log(`  → Chromium: loading ${url.slice(0, 80)}${url.length > 80 ? '…' : ''}`);
    const br = await ensureChromium(false);
    const page = await br.newPage();
    page.setDefaultNavigationTimeout(25_000);
    page.setDefaultTimeout(20_000);
    try {
      return await scrapeJobPage(page, url, log);
    } finally {
      await page.close().catch(() => {});
    }
  }
  const scrapeStarted = Date.now();
  const heartbeatMs = 15_000;
  const hb = setInterval(() => {
    const s = Math.round((Date.now() - scrapeStarted) / 1000);
    log(
      `  … still scraping (${s}s) — Chromium navigation or page scripts; will abort at ${Math.round(SCRAPE_TOTAL_MS / 1000)}s`,
    );
  }, heartbeatMs);

  const raced = Promise.race([
    once(),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Scrape exceeded ${SCRAPE_TOTAL_MS}ms (set SCRAPE_TIMEOUT_MS to increase). The site may be slow, blocking bots, or waiting on a challenge page.`,
            ),
          ),
        SCRAPE_TOTAL_MS,
      ),
    ),
  ]);
  try {
    return await raced;
  } catch (e) {
    const m = e?.message || '';
    if (/closed|has been closed|Target page|Browser has been closed/i.test(m)) {
      console.warn('  ⚠ Chromium disconnected; launching a new browser…');
      await ensureChromium(true);
      return await Promise.race([
        once(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Scrape exceeded ${SCRAPE_TOTAL_MS}ms after browser relaunch`)), SCRAPE_TOTAL_MS),
        ),
      ]);
    }
    throw e;
  } finally {
    clearInterval(hb);
  }
}
