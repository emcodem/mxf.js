import puppeteer from 'puppeteer';

export function getChromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try { return puppeteer.executablePath(); } catch { /* fall through */ }
  return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}
