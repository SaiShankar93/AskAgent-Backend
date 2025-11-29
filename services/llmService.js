const OpenAI = require('openai');

class LLMService {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    this.defaultModel = process.env.LLM_MODEL || 'gpt-4o';
    this.model = this.defaultModel;
    this.maxTokens = Number(process.env.LLM_MAX_TOKENS || 2048);
    this.temperature = Number(process.env.LLM_TEMPERATURE || 0.7);
    this.topP = Number(process.env.LLM_TOP_P || 1);
    
    // Model fallback order when overloaded
    this.fallbackModels = [
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-3.5-turbo',
    ];
  }

  getGenerationConfig(overrides = {}) {
    return {
      max_tokens: overrides.maxTokens ?? this.maxTokens,
      temperature: overrides.temperature ?? this.temperature,
      top_p: overrides.topP ?? this.topP,
    };
  }

  async generateResponse(prompt, options = {}) {
    const requestedModel = options.model || this.defaultModel;
    const modelsToTry = [requestedModel, ...this.fallbackModels.filter(m => m !== requestedModel)];
    
    let lastError = null;
    
    for (const model of modelsToTry) {
      try {
        const config = this.getGenerationConfig(options);

        console.log(`[LLM] Generating response with ${model}`);
        console.log(`[LLM] Prompt length: ${prompt.length} characters`);

        const startTime = Date.now();
        const response = await this.client.chat.completions.create({
          model,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          ...config,
        });
        const generationTime = Date.now() - startTime;

        const content = response.choices[0]?.message?.content || '';
        const usage = this.normalizeUsage(response.usage);

        console.log(`[LLM] Response generated in ${generationTime}ms`);
        if (usage.totalTokens) {
          console.log(`[LLM] Tokens used: ${usage.totalTokens}`);
        }

        return {
          content,
          model,
          usage,
          metadata: {
            generationTimeMs: generationTime,
            finishReason: response.choices[0]?.finish_reason,
          },
        };
      } catch (error) {
        lastError = error;
        const errorMessage = error.message || '';
        
        if (errorMessage.includes('overloaded') || errorMessage.includes('503') || errorMessage.includes('429')) {
          console.warn(`[LLM] Model ${model} is overloaded, trying fallback...`);
          continue;
        }
        
        // For non-overload errors, throw immediately
        console.error('[LLM] Error generating response:', error);
        throw new Error(`Failed to generate response: ${error.message}`);
      }
    }
    
    // All models failed
    console.error('[LLM] All models failed:', lastError);
    throw new Error(`Failed to generate response: All models are overloaded or unavailable. ${lastError?.message || ''}`);
  }

  async generateChatResponse(messages, options = {}) {
    const requestedModel = options.model || this.defaultModel;
    const modelsToTry = [requestedModel, ...this.fallbackModels.filter(m => m !== requestedModel)];
    
    let lastError = null;
    
    for (const model of modelsToTry) {
      try {
        const config = this.getGenerationConfig(options);

        console.log(`[LLM] Generating chat response with ${messages.length} messages using ${model}`);

        const formattedMessages = messages.map(msg => ({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        }));

        const startTime = Date.now();
        const response = await this.client.chat.completions.create({
          model,
          messages: formattedMessages,
          ...config,
        });
        const generationTime = Date.now() - startTime;

        const content = response.choices[0]?.message?.content || '';
        const usage = this.normalizeUsage(response.usage);

        console.log(`[LLM] Chat response generated in ${generationTime}ms`);

        return {
          content,
          model,
          usage,
          metadata: {
            generationTimeMs: generationTime,
            finishReason: response.choices[0]?.finish_reason,
          },
        };
      } catch (error) {
        lastError = error;
        const errorMessage = error.message || '';
        
        if (errorMessage.includes('overloaded') || errorMessage.includes('503') || errorMessage.includes('429')) {
          console.warn(`[LLM] Model ${model} is overloaded, trying fallback...`);
          continue;
        }
        
        // For non-overload errors, throw immediately
        console.error('[LLM] Error generating chat response:', error);
        throw new Error(`Failed to generate chat response: ${error.message}`);
      }
    }
    
    // All models failed
    console.error('[LLM] All models failed:', lastError);
    throw new Error(`Failed to generate chat response: All models are overloaded or unavailable. ${lastError?.message || ''}`);
  }

  /**
   * Generate response with tool calling support
   * Used for generic requests (summarize, outline) when we need to fetch all content
   * @param {string} prompt - System prompt
   * @param {string} userMessage - User's message
   * @param {Array} tools - Available tools
   * @param {Function} toolExecutor - Function to execute tool calls
   * @param {object} options - Generation options
   * @returns {Promise<object>} Response with content
   */
  async generateWithTools(prompt, userMessage, tools, toolExecutor, options = {}) {
    const requestedModel = options.model || this.defaultModel;
    const modelsToTry = [requestedModel, ...this.fallbackModels.filter(m => m !== requestedModel)];
    
    let lastError = null;
    
    for (const model of modelsToTry) {
      try {
        const config = this.getGenerationConfig(options);

        console.log(`[LLM] Generating response with tools using ${model}`);

        const messages = [
          { role: 'system', content: prompt },
          { role: 'user', content: userMessage },
        ];

        const startTime = Date.now();
        
        // First call - may return tool calls
        let response = await this.client.chat.completions.create({
          model,
          messages,
          tools,
          tool_choice: 'auto',
          ...config,
        });

        let responseMessage = response.choices[0]?.message;
        
        // Check if model wants to use tools
        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
          console.log(`[LLM] Model requested ${responseMessage.tool_calls.length} tool call(s)`);
          
          // Add assistant's tool call message
          messages.push(responseMessage);
          
          // Execute each tool call
          for (const toolCall of responseMessage.tool_calls) {
            const functionName = toolCall.function.name;
            const functionArgs = JSON.parse(toolCall.function.arguments);
            
            console.log(`[LLM] Executing tool: ${functionName}`);
            
            // Execute tool and get result
            const toolResult = await toolExecutor(functionName, functionArgs);
            
            // Add tool result to messages
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
            });
          }
          
          // Get final response after tool execution
          response = await this.client.chat.completions.create({
            model,
            messages,
            ...config,
          });
          
          responseMessage = response.choices[0]?.message;
        }

        const generationTime = Date.now() - startTime;
        const content = responseMessage?.content || '';
        const usage = this.normalizeUsage(response.usage);

        console.log(`[LLM] Tool-assisted response generated in ${generationTime}ms`);

        return {
          content,
          model,
          usage,
          metadata: {
            generationTimeMs: generationTime,
            finishReason: response.choices[0]?.finish_reason,
            usedTools: responseMessage.tool_calls?.length > 0,
          },
        };
      } catch (error) {
        lastError = error;
        const errorMessage = error.message || '';
        
        if (errorMessage.includes('overloaded') || errorMessage.includes('503') || errorMessage.includes('429')) {
          console.warn(`[LLM] Model ${model} is overloaded, trying fallback...`);
          continue;
        }
        
        console.error('[LLM] Error generating response with tools:', error);
        throw new Error(`Failed to generate response with tools: ${error.message}`);
      }
    }
    
    console.error('[LLM] All models failed:', lastError);
    throw new Error(`Failed to generate response with tools: All models are overloaded. ${lastError?.message || ''}`);
  }

  async generateStreamingResponse(prompt, onChunk, options = {}) {
    const requestedModel = options.model || this.defaultModel;
    const modelsToTry = [requestedModel, ...this.fallbackModels.filter(m => m !== requestedModel)];
    
    let lastError = null;
    
    for (const model of modelsToTry) {
      try {
        const config = this.getGenerationConfig(options);

        console.log(`[LLM] Starting streaming response using ${model}`);

        const startTime = Date.now();
        const stream = await this.client.chat.completions.create({
          model,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          ...config,
          stream: true,
        });

        let fullContent = '';

        for await (const chunk of stream) {
          const text = chunk.choices[0]?.delta?.content || '';
          if (text) {
            fullContent += text;
            onChunk(text);
          }
        }

        const generationTime = Date.now() - startTime;
        console.log(`[LLM] Streaming completed in ${generationTime}ms`);

        return {
          content: fullContent,
          model,
          metadata: {
            generationTimeMs: generationTime,
            contentLength: fullContent.length,
          },
        };
      } catch (error) {
        lastError = error;
        const errorMessage = error.message || '';
        
        if (errorMessage.includes('overloaded') || errorMessage.includes('503') || errorMessage.includes('429')) {
          console.warn(`[LLM] Model ${model} is overloaded, trying fallback...`);
          continue;
        }
        
        // For non-overload errors, throw immediately
        console.error('[LLM] Error in streaming response:', error);
        throw new Error(`Failed to generate streaming response: ${error.message}`);
      }
    }
    
    // All models failed
    console.error('[LLM] All models failed:', lastError);
    throw new Error(`Failed to generate streaming response: All models are overloaded or unavailable. ${lastError?.message || ''}`);
  }

  async test() {
    try {
      console.log('[LLM] Testing service connectivity...');

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: 'Say "hello" if you can hear me.',
          },
        ],
        max_tokens: 50,
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content || '';
      console.log(`[LLM] Test response: ${content}`);
      console.log('[LLM] Service test successful');

      return true;
    } catch (error) {
      console.error('[LLM] Service test failed:', error);
      return false;
    }
  }

  getAvailableModels() {
    return [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        description: 'Most advanced model with vision and multimodal capabilities',
        contextWindow: 128000,
        recommended: true,
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        description: 'Fast and affordable model for everyday tasks',
        contextWindow: 128000,
        recommended: true,
      },
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        description: 'Previous generation with excellent performance',
        contextWindow: 128000,
        recommended: false,
      },
      {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
        description: 'Fast and cost-effective for simple tasks',
        contextWindow: 16385,
        recommended: false,
      },
    ];
  }

  normalizeUsage(rawUsage = {}) {
    if (!rawUsage) {
      return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    }

    const promptTokens = rawUsage.prompt_tokens ?? 0;
    const completionTokens = rawUsage.completion_tokens ?? 0;
    const totalTokens = rawUsage.total_tokens ?? (promptTokens + completionTokens);

    return {
      promptTokens,
      completionTokens,
      totalTokens,
    };
  }

  estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }

  isPromptWithinLimit(prompt, modelId = this.model) {
    const estimatedTokens = this.estimateTokens(prompt);
    const model = this.getAvailableModels().find(m => m.id === modelId);

    if (!model) return true;

    const maxPromptTokens = model.contextWindow * 0.8;
    return estimatedTokens <= maxPromptTokens;
  }

  formatErrorMessage(error) {
    const message = error.message.toLowerCase();

    if (message.includes('api key') || message.includes('unauthorized')) {
      return 'Invalid API key. Please check your OpenAI API configuration.';
    }

    if (message.includes('rate limit') || message.includes('429')) {
      return 'Rate limit exceeded. Please try again in a moment.';
    }

    if (message.includes('context length') || message.includes('maximum context')) {
      return 'Query too long. Please try with a shorter question.';
    }

    if (message.includes('timeout')) {
      return 'Request timed out. Please try again.';
    }

    if (message.includes('insufficient_quota')) {
      return 'OpenAI API quota exceeded. Please check your billing.';
    }

    return 'Unable to generate response. Please try again later.';
  }
}

module.exports = new LLMService();
