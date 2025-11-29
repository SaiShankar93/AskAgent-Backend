const { PuppeteerWebBaseLoader } = require('@langchain/community/document_loaders/web/puppeteer');
const { URL } = require('url');

class WebsiteCrawler {
  constructor(baseUrl, maxPages = 10) {
    this.baseUrl = baseUrl;
    this.baseDomain = new URL(baseUrl).hostname;
    this.maxPages = maxPages;
    this.visitedUrls = new Set();
    this.urlsToVisit = [baseUrl];
    this.scrapedData = [];
  }

  /**
   * Crawl the entire website
   * @returns {Promise<Array>} Array of scraped documents with metadata
   */
  async crawl() {
    console.log(`[Crawler] Starting crawl of ${this.baseUrl} (max ${this.maxPages} pages)`);
    
    while (this.urlsToVisit.length > 0 && this.visitedUrls.size < this.maxPages) {
      const currentUrl = this.urlsToVisit.shift();
      
      // Skip if already visited
      if (this.visitedUrls.has(currentUrl)) {
        continue;
      }
      
      try {
        console.log(`[Crawler] Scraping (${this.visitedUrls.size + 1}/${this.maxPages}): ${currentUrl}`);
        
        // Mark as visited
        this.visitedUrls.add(currentUrl);
        
        // Scrape the page
        const pageData = await this.scrapePage(currentUrl);
        
        if (pageData) {
          this.scrapedData.push(pageData);
          
          // Add new URLs to visit
          const newUrls = pageData.links.filter(url => this.shouldVisitUrl(url));
          this.urlsToVisit.push(...newUrls);
        }
        
        // Small delay to avoid overwhelming the server
        await this.delay(500);
        
      } catch (error) {
        console.error(`[Crawler] Error scraping ${currentUrl}:`, error.message);
      }
    }
    
    console.log(`[Crawler] Crawl complete. Scraped ${this.scrapedData.length} pages`);
    return this.scrapedData;
  }

  /**
   * Scrape a single page
   * @param {string} url - URL to scrape
   * @returns {Promise<object>} Scraped page data
   */
  async scrapePage(url) {
    try {
      const loader = new PuppeteerWebBaseLoader(url, {
        launchOptions: {
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
        gotoOptions: {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        },
        evaluate: async (page, browser) => {
          // Wait for page to load
          await page.waitForSelector('body', { timeout: 10000 }).catch(() => {});
          
          // Extract metadata
          const title = await page.title();
          const metaDescription = await page.$eval('meta[name="description"]', el => el.content).catch(() => '');
          
          // Try to get favicon
          let favicon = null;
          try {
            favicon = await page.$eval('link[rel="icon"]', el => el.href);
          } catch (e) {
            try {
              favicon = await page.$eval('link[rel="shortcut icon"]', el => el.href);
            } catch (e2) {
              // Try to construct default favicon URL
              const currentUrl = page.url();
              const urlObj = new URL(currentUrl);
              favicon = `${urlObj.protocol}//${urlObj.hostname}/favicon.ico`;
            }
          }
          
          // Get the main content (remove script and style tags)
          const content = await page.evaluate(() => {
            // Remove unwanted elements
            const elementsToRemove = document.querySelectorAll('script, style, nav, header, footer, iframe, noscript');
            elementsToRemove.forEach(el => el.remove());
            
            // Get clean text content
            return document.body.innerText;
          });
          
          // Get all links on the page
          const links = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            return anchors.map(a => a.href).filter(href => href && !href.startsWith('#'));
          });
          
          // Get headings
          const headings = await page.evaluate(() => {
            const headingElements = Array.from(document.querySelectorAll('h1, h2, h3'));
            return headingElements.map(h => h.innerText.trim()).filter(text => text.length > 0);
          });
          
          return JSON.stringify({
            content,
            title,
            metaDescription,
            favicon,
            links,
            headings,
            url: page.url(),
          });
        },
      });
      
      const docs = await loader.load();
      
      if (docs.length === 0) {
        return null;
      }
      
      // Parse the scraped data
      const parsed = JSON.parse(docs[0].pageContent);
      
      return {
        url: parsed.url,
        title: parsed.title,
        description: parsed.metaDescription,
        favicon: parsed.favicon,
        content: parsed.content,
        headings: parsed.headings,
        links: parsed.links,
        wordCount: parsed.content.split(/\s+/).filter(w => w.length > 0).length,
      };
      
    } catch (error) {
      console.error(`[Crawler] Failed to scrape ${url}:`, error.message);
      return null;
    }
  }

  /**
   * Check if URL should be visited
   * @param {string} url - URL to check
   * @returns {boolean}
   */
  shouldVisitUrl(url) {
    try {
      const urlObj = new URL(url);
      
      // Only visit URLs from the same domain
      if (urlObj.hostname !== this.baseDomain) {
        return false;
      }
      
      // Skip already visited URLs
      if (this.visitedUrls.has(url)) {
        return false;
      }
      
      // Skip URLs already in queue
      if (this.urlsToVisit.includes(url)) {
        return false;
      }
      
      // Skip common non-content URLs
      const skipPatterns = [
        /\.(pdf|jpg|jpeg|png|gif|svg|webp|mp4|mp3|zip|exe)$/i,
        /\/wp-admin\//i,
        /\/admin\//i,
        /\/login/i,
        /\/logout/i,
        /\/cart/i,
        /\/checkout/i,
        /mailto:/i,
        /tel:/i,
        /javascript:/i,
      ];
      
      return !skipPatterns.some(pattern => pattern.test(url));
      
    } catch (error) {
      return false;
    }
  }

  /**
   * Delay helper
   * @param {number} ms - Milliseconds to delay
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get crawl summary
   * @returns {object}
   */
  getSummary() {
    const totalWords = this.scrapedData.reduce((sum, page) => sum + page.wordCount, 0);
    const totalContent = this.scrapedData.reduce((sum, page) => sum + page.content.length, 0);
    
    return {
      totalPages: this.scrapedData.length,
      totalWords,
      totalCharacters: totalContent,
      avgWordsPerPage: Math.round(totalWords / this.scrapedData.length),
      pages: this.scrapedData.map(p => ({
        url: p.url,
        title: p.title,
        wordCount: p.wordCount,
      })),
    };
  }
}

module.exports = WebsiteCrawler;
