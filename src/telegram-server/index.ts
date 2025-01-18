#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import TelegramBot from 'node-telegram-bot-api';
import { 
  CallToolRequestSchema, 
  ErrorCode, 
  ListToolsRequestSchema, 
  McpError 
} from '@modelcontextprotocol/sdk/types.js';

// Extended error codes
const ExtendedErrorCode = {
  ...ErrorCode,
  Timeout: 1000
} as const;

import config from '../../config.json';
import path from 'path';

if (!config?.telegram?.botToken) {
  throw new Error('Missing telegram.botToken in config.json');
}

if (!config.telegram.allowedChatIds || !Array.isArray(config.telegram.allowedChatIds)) {
  throw new Error('Missing or invalid telegram.allowedChatIds in config.json');
}

const TELEGRAM_TOKEN = config.telegram.botToken;
const ALLOWED_CHAT_IDS = new Set(config.telegram.allowedChatIds);

interface PendingRequest {
  resolve: (value: string) => void;
  reject: (reason?: any) => void;
  timeout: NodeJS.Timeout;
}

class TelegramServer {
  private server: Server;
  private bot: TelegramBot;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private requestTimeout = 300000; // 5 minutes

  constructor() {
    this.server = new Server({
      name: 'telegram-server',
      version: '2.0.0',
    }, {
      capabilities: {
        resources: {},
        tools: {},
      },
    });

    this.bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    console.log('Telegram bot initialized successfully');
    this.setupBotHandlers();
    this.setupServerHandlers();
  }

  private setupBotHandlers() {
    this.bot.on('message', (msg) => {
      console.log(`Received message from chat ${msg.chat.id}: ${msg.text}`);
      const chatId = msg.chat.id;
      if (!ALLOWED_CHAT_IDS.has(chatId)) {
        console.warn(`Received message from unauthorized chat ID: ${chatId}`);
        return;
      }
      const messageText = msg.text ?? '';
      
      // Skip if we don't have valid text content
      if (!messageText.trim()) {
        if (this.pendingRequests.has(chatId)) {
          const pendingRequest = this.pendingRequests.get(chatId);
          if (pendingRequest) {
            clearTimeout(pendingRequest.timeout);
            this.pendingRequests.delete(chatId);
            pendingRequest.reject(new McpError(ErrorCode.InvalidParams, 'Invalid message type'));
          }
        }
        return;
      }

      // Check if this is a response to a pending request
      const pendingRequest = this.pendingRequests.get(chatId);
      if (pendingRequest) {
        clearTimeout(pendingRequest.timeout);
        this.pendingRequests.delete(chatId);
        pendingRequest.resolve(messageText);
        return;
      }

      // Default behavior for non-request messages
      console.log(`Sending response to chat ${chatId}`);
      this.bot.sendMessage(chatId, `You said: ${messageText}`);
    });
  }

  private setupServerHandlers() {
    console.log('Setting up MCP server handlers');
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'send_message',
          description: 'Send a message through Telegram',
          inputSchema: {
            type: 'object',
            properties: {
              chatId: { type: 'number' },
              message: { type: 'string' }
            },
            required: ['chatId', 'message']
          }
        },
        {
          name: 'request_user_input',
          description: 'Request user input through Telegram',
          inputSchema: {
            type: 'object',
            properties: {
              chatId: { type: 'number' },
              prompt: { type: 'string' }
            },
            required: ['chatId', 'prompt']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'send_message':
          return this.handleSendMessage(request.params.arguments);
        case 'request_user_input':
          return this.handleRequestUserInput(request.params.arguments);
        default:
          throw new McpError(ErrorCode.MethodNotFound, 'Unknown tool');
      }
    });

    // Error handling
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
      console.log('Attempting to recover from error...');
    };
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private async handleSendMessage(args: any) {
    if (!args || typeof args !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments');
    }
    const { chatId, message } = args;
    if (typeof chatId !== 'number' || typeof message !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid argument types');
    }
    await this.bot.sendMessage(chatId, message);
    return {
      content: [{
        type: 'text',
        text: 'Message sent successfully'
      }]
    };
  }

  private async handleRequestUserInput(args: any) {
    if (!args || typeof args !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments');
    }
    const { chatId, prompt } = args;
    if (typeof chatId !== 'number' || typeof prompt !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid argument types');
    }

    // Send the prompt to the user
    await this.bot.sendMessage(chatId, prompt);

    // Create and return a promise that resolves when we get a response
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(chatId);
        reject(new McpError(ExtendedErrorCode.Timeout, 'Request timed out'));
      }, this.requestTimeout);

      this.pendingRequests.set(chatId, {
        resolve,
        reject,
        timeout
      });
    }).then(response => ({
      content: [{
        type: 'text',
        text: response
      }]
    }));
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.log('Telegram MCP server running on stdio');
    console.log('Bot username:', this.bot.getMe());
    console.log('MCP server initialized with tools:', [
      'send_message',
      'request_user_input'
    ]);
  }
}

const server = new TelegramServer();
server.run().catch(console.error);
