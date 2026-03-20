const puppeteer = require('puppeteer');
const { URL } = require('url');

// ─── Launch options ────────────────────────────────────────────────────────────
const PUPPETEER_LAUNCH_OPTIONS = {
  headless: 'new',
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--no-first-run',
    '--no-zygote',
    // NOTE: --single-process is intentionally removed.
    // It causes "Navigating frame was detached" on sites that spawn
    // subframes or trigger navigation events before DOMContentLoaded.
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
  ],
};

// waitUntil strategies tried in order — from strictest to most permissive
const WAIT_STRATEGIES = [
  'domcontentloaded',
  'load',
  'networkidle2',
];

const PAGE_TIMEOUT   = 30_000;   // per-strategy timeout (ms)
const BODY_TIMEOUT   = 8_000;
const MAX_RETRIES    = 2;        // retries per page (different strategy each time)
const SCROLL_WAIT    = 1_200;    // wait after scroll-to-bottom (MS)

class WebsiteCrawler {
  constructor(baseUrl, maxPages = 10) {
    this.baseUrl      = baseUrl;
    this.baseDomain   = new URL(baseUrl).hostname;
    this.maxPages     = maxPages;
    this.visitedUrls  = new Set();
    this.urlsToVisit  = [baseUrl];
    this.scrapedData  = [];

    // Single shared browser — opened in crawl(), closed after.
    this._browser = null;
  }

  // ─── Public: crawl all pages ────────────────────────────────────────────────
  async crawl() {
    console.log(`[Crawler] Starting crawl of ${this.baseUrl} (max ${this.maxPages} pages)`);

    try {
      this._browser = await puppeteer.launch(PUPPETEER_LAUNCH_OPTIONS);

      while (this.urlsToVisit.length > 0 && this.visitedUrls.size < this.maxPages) {
        const currentUrl = this.urlsToVisit.shift();
        if (this.visitedUrls.has(currentUrl)) continue;

        console.log(`[Crawler] Scraping (${this.visitedUrls.size + 1}/${this.maxPages}): ${currentUrl}`);
        this.visitedUrls.add(currentUrl);

        try {
          const pageData = await this.scrapePage(currentUrl);
          if (pageData) {
            this.scrapedData.push(pageData);
            const newUrls = pageData.links.filter(u => this.shouldVisitUrl(u));
            this.urlsToVisit.push(...newUrls);
          }
        } catch (err) {
          console.error(`[Crawler] Error scraping ${currentUrl}:`, err.message);
        }

        await this.delay(500);
      }
    } finally {
      if (this._browser) {
        await this._browser.close().catch(() => {});
        this._browser = null;
      }
    }

    console.log(`[Crawler] Crawl complete. Scraped ${this.scrapedData.length} pages`);
    return this.scrapedData;
  }

  // ─── Scrape one page with retry + strategy fallback ─────────────────────────
  async scrapePage(url) {
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const strategy = WAIT_STRATEGIES[Math.min(attempt, WAIT_STRATEGIES.length - 1)];

      let page = null;
      try {
        page = await this._browser.newPage();

        // Block heavy resources that aren't needed for text extraction
        await page.setRequestInterception(true);
        page.on('request', req => {
          const type = req.resourceType();
          if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
            req.abort();
          } else {
            req.continue();
          }
        });

        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.goto(url, {
          waitUntil: strategy,
          timeout: PAGE_TIMEOUT,
        });

        // Wait for body to be present
        await page.waitForSelector('body', { timeout: BODY_TIMEOUT }).catch(() => {});

        // Scroll to trigger lazy-loaded content
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        await this.delay(SCROLL_WAIT);

        const parsed = await page.evaluate(() => {
          const title       = document.title || '';
          const description = document.querySelector('meta[name="description"]')?.content || '';
          const favicon     =
            document.querySelector('link[rel="icon"]')?.href ||
            document.querySelector('link[rel="shortcut icon"]')?.href ||
            `${location.protocol}//${location.hostname}/favicon.ico`;

          // Clone and strip noise before extracting text
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll('script, style, nav, header, footer, iframe, noscript, svg, [aria-hidden="true"]')
               .forEach(el => el.remove());

          // Prefer main / article blocks; fall back to full body
          const mainEl = clone.querySelector('main, article, [role="main"], #content, .content, #main');
          const rawText = (mainEl || clone).innerText || '';

          // Normalise whitespace
          const content = rawText.replace(/\n{3,}/g, '\n\n').trim();

          const links = Array.from(document.querySelectorAll('a[href]'))
            .map(a => {
              try { return new URL(a.getAttribute('href'), location.href).href; }
              catch { return null; }
            })
            .filter(Boolean);

          const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
            .map(h => (h.textContent || '').trim())
            .filter(t => t.length > 0);

          return { content, title, description, favicon, links, headings, url: location.href };
        });

        await page.close().catch(() => {});

        if (!parsed?.content || parsed.content.length < 50) {
          lastError = new Error(`Page has no usable content (${parsed?.content?.length ?? 0} chars)`);
          continue;   // try next strategy
        }

        return {
          url:       parsed.url,
          title:     parsed.title,
          description: parsed.description,
          favicon:   parsed.favicon,
          content:   parsed.content,
          headings:  parsed.headings,
          links:     parsed.links,
          wordCount: parsed.content.split(/\s+/).filter(w => w.length > 0).length,
        };

      } catch (err) {
        lastError = err;
        const isRecoverable =
          err.message.includes('detached') ||
          err.message.includes('timeout') ||
          err.message.includes('net::') ||
          err.message.includes('Navigation');

        if (page) await page.close().catch(() => {});

        if (!isRecoverable || attempt >= MAX_RETRIES) break;

        console.warn(`[Crawler] Attempt ${attempt + 1} failed for ${url} (${err.message.slice(0, 80)}). Retrying with strategy "${WAIT_STRATEGIES[attempt + 1] || 'networkidle2'}"…`);
        await this.delay(1500 * (attempt + 1));   // back-off
      }
    }

    console.error(`[Crawler] Failed to scrape ${url}:`, lastError?.message || 'unknown');
    return null;
  }

  // ─── URL filter ─────────────────────────────────────────────────────────────
  shouldVisitUrl(url) {
    try {
      const urlObj = new URL(url);
      if (urlObj.hostname !== this.baseDomain)         return false;
      if (this.visitedUrls.has(url))                   return false;
      if (this.urlsToVisit.includes(url))              return false;

      const skipPatterns = [
        /\.(pdf|jpg|jpeg|png|gif|svg|webp|mp4|mp3|zip|exe|css|js)$/i,
        /\/wp-admin\//i,
        /\/admin\//i,
        /\/login/i,
        /\/logout/i,
        /\/cart/i,
        /\/checkout/i,
        /^mailto:/i,
        /^tel:/i,
        /^javascript:/i,
        /#/,   // skip anchor-only links
      ];

      return !skipPatterns.some(pattern => pattern.test(url));
    } catch {
      return false;
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getSummary() {
    const totalWords   = this.scrapedData.reduce((s, p) => s + p.wordCount, 0);
    const totalContent = this.scrapedData.reduce((s, p) => s + p.content.length, 0);
    return {
      totalPages:     this.scrapedData.length,
      totalWords,
      totalCharacters: totalContent,
      avgWordsPerPage: this.scrapedData.length
        ? Math.round(totalWords / this.scrapedData.length)
        : 0,
      pages: this.scrapedData.map(p => ({ url: p.url, title: p.title, wordCount: p.wordCount })),
    };
  }
}

module.exports = WebsiteCrawler;
