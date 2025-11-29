const fs = require('fs').promises;
const path = require('path');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');

class DocumentProcessor {
  /**
   * Process a document and extract its text content
   * @param {string} filePath - Path to the document file
   * @param {string} fileType - Type of file (pdf, txt, docx)
   * @returns {Promise<{text: string, metadata: object}>}
   */
  async processDocument(filePath, fileType) {
    try {
      let text = '';
      let metadata = {
        fileType,
        fileName: path.basename(filePath),
        processedAt: new Date().toISOString(),
      };

      switch (fileType.toLowerCase()) {
        case 'pdf':
          const pdfResult = await this.processPDF(filePath);
          text = pdfResult.text;
          metadata = { ...metadata, ...pdfResult.metadata };
          break;

        case 'txt':
          text = await this.processTXT(filePath);
          break;

        case 'docx':
          text = await this.processDOCX(filePath);
          break;

        default:
          throw new Error(`Unsupported file type: ${fileType}`);
      }

      // Clean up the text
      text = this.cleanText(text);

      // Add text statistics to metadata
      metadata.characterCount = text.length;
      metadata.wordCount = text.split(/\s+/).filter(word => word.length > 0).length;

      return { text, metadata };
    } catch (error) {
      console.error('Error processing document:', error);
      throw new Error(`Failed to process document: ${error.message}`);
    }
  }

  /**
   * Process PDF file
   * @param {string} filePath - Path to PDF file
   * @returns {Promise<{text: string, metadata: object}>}
   */
  async processPDF(filePath) {
    let parser = null;
    try {
      const dataBuffer = await fs.readFile(filePath);
      
      // Use v2 API
      parser = new PDFParse({ data: dataBuffer });
      
      // Get text content
      const textResult = await parser.getText();
      
      // Get document info
      const infoResult = await parser.getInfo();

      return {
        text: textResult.text,
        metadata: {
          pages: infoResult.total,
          info: infoResult.info || {},
        },
      };
    } catch (error) {
      throw new Error(`PDF processing failed: ${error.message}`);
    } finally {
      // Always destroy parser to free memory
      if (parser) {
        await parser.destroy();
      }
    }
  }

  /**
   * Process TXT file
   * @param {string} filePath - Path to TXT file
   * @returns {Promise<string>}
   */
  async processTXT(filePath) {
    try {
      const text = await fs.readFile(filePath, 'utf-8');
      return text;
    } catch (error) {
      throw new Error(`TXT processing failed: ${error.message}`);
    }
  }

  /**
   * Process DOCX file
   * @param {string} filePath - Path to DOCX file
   * @returns {Promise<string>}
   */
  async processDOCX(filePath) {
    try {
      const buffer = await fs.readFile(filePath);
      const result = await mammoth.extractRawText({ buffer });
      
      if (result.messages.length > 0) {
        console.warn('DOCX conversion warnings:', result.messages);
      }

      return result.value;
    } catch (error) {
      throw new Error(`DOCX processing failed: ${error.message}`);
    }
  }

  /**
   * Clean and normalize extracted text
   * @param {string} text - Raw text to clean
   * @returns {string}
   */
  cleanText(text) {
    if (!text) return '';

    return text
      // Remove excessive whitespace
      .replace(/\s+/g, ' ')
      // Remove non-printable characters
      .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
      // Normalize line breaks
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // Remove multiple consecutive newlines (keep max 2)
      .replace(/\n{3,}/g, '\n\n')
      // Trim whitespace
      .trim();
  }

  /**
   * Validate file before processing
   * @param {string} filePath - Path to file
   * @param {number} maxSizeMB - Maximum file size in MB
   * @returns {Promise<{valid: boolean, error?: string}>}
   */
  async validateFile(filePath, maxSizeMB = 10) {
    try {
      const stats = await fs.stat(filePath);
      const fileSizeMB = stats.size / (1024 * 1024);

      if (fileSizeMB > maxSizeMB) {
        return {
          valid: false,
          error: `File size (${fileSizeMB.toFixed(2)}MB) exceeds maximum allowed size (${maxSizeMB}MB)`,
        };
      }

      const ext = path.extname(filePath).toLowerCase().slice(1);
      const allowedTypes = ['pdf', 'txt', 'docx'];

      if (!allowedTypes.includes(ext)) {
        return {
          valid: false,
          error: `File type .${ext} is not supported. Allowed types: ${allowedTypes.join(', ')}`,
        };
      }

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: `File validation failed: ${error.message}`,
      };
    }
  }

  /**
   * Extract metadata without full processing
   * @param {string} filePath - Path to file
   * @returns {Promise<object>}
   */
  async extractMetadata(filePath) {
    try {
      const stats = await fs.stat(filePath);
      const ext = path.extname(filePath).toLowerCase().slice(1);

      return {
        fileName: path.basename(filePath),
        fileType: ext,
        fileSizeBytes: stats.size,
        fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2),
        createdAt: stats.birthtime,
        modifiedAt: stats.mtime,
      };
    } catch (error) {
      throw new Error(`Metadata extraction failed: ${error.message}`);
    }
  }
}

module.exports = new DocumentProcessor();
