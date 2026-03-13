class TextChunker {
  constructor(chunkSize = 1500, chunkOverlap = 200) {
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
    this.separators = ['\n\n', '\n', '. ', '! ', '? ', ', ', ' '];
  }

  splitIntoChunks(text) {
    const chunks = [];
    let cursor = 0;

    while (cursor < text.length) {
      const maxEnd = Math.min(cursor + this.chunkSize, text.length);
      let end = maxEnd;

      if (maxEnd < text.length) {
        const minBreak = Math.floor(cursor + this.chunkSize * 0.6);

        for (const separator of this.separators) {
          const idx = text.lastIndexOf(separator, maxEnd);
          if (idx >= minBreak) {
            end = idx + separator.length;
            break;
          }
        }
      }

      const slice = text.slice(cursor, end).trim();
      if (slice) {
        chunks.push(slice);
      }

      if (end >= text.length) {
        break;
      }

      cursor = Math.max(end - this.chunkOverlap, cursor + 1);
    }

    return chunks;
  }

  /**
   * Split text into chunks
   * @param {string} text - Text to split
   * @param {object} metadata - Optional metadata to attach to each chunk
   * @returns {Promise<Array<{content: string, metadata: object}>>}
   */
  async chunkText(text, metadata = {}) {
    try {
      if (!text || text.trim().length === 0) {
        throw new Error('Text is empty or invalid');
      }

      const chunks = this.splitIntoChunks(text);

      // Format chunks with metadata
      return chunks.map((chunkContent, index) => ({
        content: chunkContent,
        metadata: {
          ...metadata,
          chunkIndex: index,
          chunkLength: chunkContent.length,
          totalChunks: chunks.length,
        },
      }));
    } catch (error) {
      console.error('Error chunking text:', error);
      throw new Error(`Text chunking failed: ${error.message}`);
    }
  }

  /**
   * Chunk website content with section awareness
   * @param {object} scrapedData - Scraped website data from scraper service
   * @returns {Promise<Array<{content: string, metadata: object}>>}
   */
  async chunkWebsiteContent(scrapedData) {
    try {
      const { pages = [], metadata = {} } = scrapedData;
      
      if (!pages || pages.length === 0) {
        throw new Error('No pages found in scraped data');
      }

      const allChunks = [];

      // Process each page
      for (const page of pages) {
        const pageText = this.formatPageContent(page);
        
        const pageChunks = this.splitIntoChunks(pageText);

        // Add chunks with page-specific metadata
        pageChunks.forEach((chunkContent, index) => {
          allChunks.push({
            content: chunkContent,
            metadata: {
              sourceUrl: page.url,
              pageTitle: page.title,
              pageType: page.pageType || 'unknown',
              chunkIndex: index,
              chunkLength: chunkContent.length,
              totalPageChunks: pageChunks.length,
              scrapedAt: metadata.scrapedAt || new Date().toISOString(),
            },
          });
        });
      }

      return allChunks;
    } catch (error) {
      console.error('Error chunking website content:', error);
      throw new Error(`Website content chunking failed: ${error.message}`);
    }
  }

  /**
   * Format page content for chunking
   * @param {object} page - Page data from scraper
   * @returns {string}
   */
  formatPageContent(page) {
    const parts = [];

    // Add title
    if (page.title) {
      parts.push(`Title: ${page.title}`);
    }

    // Add meta description
    if (page.metadata?.description) {
      parts.push(`Description: ${page.metadata.description}`);
    }

    // Add main content
    if (page.content) {
      parts.push(page.content);
    }

    // Add headings if available
    if (page.headings && page.headings.length > 0) {
      parts.push('\nKey Topics:');
      page.headings.slice(0, 10).forEach(heading => {
        parts.push(`- ${heading}`);
      });
    }

    return parts.join('\n\n');
  }

  /**
   * Chunk document with metadata preservation
   * @param {string} text - Document text
   * @param {object} documentMetadata - Document metadata
   * @returns {Promise<Array<{content: string, metadata: object}>>}
   */
  async chunkDocument(text, documentMetadata = {}) {
    try {
      const chunks = await this.chunkText(text, {
        documentName: documentMetadata.fileName,
        documentType: documentMetadata.fileType,
        processedAt: new Date().toISOString(),
      });

      return chunks;
    } catch (error) {
      console.error('Error chunking document:', error);
      throw new Error(`Document chunking failed: ${error.message}`);
    }
  }

  /**
   * Get optimal chunk size based on content type
   * @param {string} contentType - Type of content (document, website, code)
   * @returns {number}
   */
  getOptimalChunkSize(contentType) {
    const sizes = {
      document: 1500,
      website: 1200,
      code: 2000,
      default: 1500,
    };

    return sizes[contentType] || sizes.default;
  }

  /**
   * Validate chunk quality
   * @param {string} chunk - Chunk content
   * @returns {boolean}
   */
  isValidChunk(chunk) {
    // Check if chunk has sufficient content
    if (!chunk || chunk.trim().length < 50) {
      return false;
    }

    // Check if chunk has meaningful words
    const wordCount = chunk.split(/\s+/).filter(word => word.length > 0).length;
    if (wordCount < 10) {
      return false;
    }

    return true;
  }

  /**
   * Get chunk statistics
   * @param {Array<object>} chunks - Array of chunks
   * @returns {object}
   */
  getChunkStats(chunks) {
    if (!chunks || chunks.length === 0) {
      return { totalChunks: 0, avgLength: 0, totalLength: 0 };
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
    const avgLength = Math.round(totalLength / chunks.length);

    return {
      totalChunks: chunks.length,
      avgLength,
      totalLength,
      minLength: Math.min(...chunks.map(c => c.content.length)),
      maxLength: Math.max(...chunks.map(c => c.content.length)),
    };
  }
}

module.exports = TextChunker;
