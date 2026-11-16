import puppeteer from 'puppeteer';

/** E2E browsers run headless unless E2E_HEADFUL=1 (for watching a test or debugging it). */
export const HEADLESS = !process.env.E2E_HEADFUL;

export function getChromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try { return puppeteer.executablePath(); } catch { /* fall through */ }
  return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}
