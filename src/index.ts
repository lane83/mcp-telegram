#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import TelegramBot from 'node-telegram-bot-api';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
if (!TELEGRAM_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
}

class TelegramServer {
  private server: Server;
  private bot: TelegramBot;

  constructor() {
    this.server = new Server(
      {
        name: 'telegram-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    this.setupBotHandlers();
    this.setupServerHandlers();
  }

  private setupBotHandlers() {
    this.bot.on('message', (msg: TelegramBot.Message) => {
      const chatId = msg.chat.id;
      console.log(`Received message from chat ID: ${chatId}`);
      if (!msg.text) return;
      
      // Echo messages back to user
      this.bot.sendMessage(chatId, `You said: ${msg.text}`);
    });
  }

  private setupServerHandlers() {
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
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'send_message') {
        if (!request.params.arguments || typeof request.params.arguments !== 'object') {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments');
        }
        
        const { chatId, message } = request.params.arguments;
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
      throw new McpError(ErrorCode.MethodNotFound, 'Unknown tool');
    });

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Telegram MCP server running on stdio');
  }
}

const server = new TelegramServer();
server.run().catch(console.error);
