/**
 * Claude backend 的 MCP adapter：把传输无关的 TOOL_DEFS 挂进进程内 SDK MCP server。
 * codex 侧的 http-mcp-adapter 挂的是同一组定义（agent-backends.md §2.1）。
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { TOOL_DEFS, type InvestigationStore } from './definitions.js';

export const MCP_SERVER_NAME = 'inquestry';

export function toolName(bare: string): string {
  return `mcp__${MCP_SERVER_NAME}__${bare}`;
}

export function createInquestryMcpServer(store: InvestigationStore) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '0.1.0',
    tools: TOOL_DEFS.map((def) =>
      tool(def.name, def.description, def.shape, async (args: Record<string, unknown>) => {
        try {
          return { content: [{ type: 'text' as const, text: await def.run(store, args) }] };
        } catch (err) {
          // 工具抛错会让 agent 卡在原地重试，宁可把失败说清楚让它换路
          return {
            content: [{ type: 'text' as const, text: `失败：${(err as Error).message}` }],
            isError: true,
          };
        }
      }),
    ),
  });
}
