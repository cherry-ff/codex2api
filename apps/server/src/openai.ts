import { randomUUID } from "node:crypto";

import type { ChatMessage, JobRecord, TokenUsage } from "./types.js";

function formatUsage(usage: TokenUsage | null) {
  if (!usage) {
    return undefined;
  }

  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cachedInputTokens
    },
    completion_tokens_details: {
      reasoning_tokens: usage.reasoningOutputTokens
    }
  };
}

export function buildCodexPrompt(messages: ChatMessage[]): string {
  const systemMessages = messages.filter((message) => message.role === "system");
  const developerMessages = messages.filter((message) => message.role === "developer");
  const conversationMessages = messages.filter(
    (message) => message.role === "user" || message.role === "assistant" || message.role === "tool"
  );
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");

  const sections: string[] = [];

  if (systemMessages.length > 0) {
    sections.push("[system]");
    sections.push(systemMessages.map((message) => message.content).join("\n\n"));
    sections.push("");
  }

  if (developerMessages.length > 0) {
    sections.push("[developer]");
    sections.push(developerMessages.map((message) => message.content).join("\n\n"));
    sections.push("");
  }

  if (conversationMessages.length > 0) {
    sections.push("[conversation]");
    for (const message of conversationMessages) {
      sections.push(`${message.role}: ${message.content}`);
    }
    sections.push("");
  }

  if (latestUserMessage) {
    sections.push("[latest user request]");
    sections.push(latestUserMessage.content);
  }

  return sections.join("\n");
}

export function formatChatCompletion(job: JobRecord, model: string, text: string, usage: TokenUsage | null) {
  const created = Math.floor(new Date(job.createdAt).getTime() / 1000);

  return {
    id: `chatcmpl_${job.id}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text
        },
        finish_reason: "stop"
      }
    ],
    usage: formatUsage(usage)
  };
}

export function createChunk(
  model: string,
  completionId: string,
  delta: string,
  done = false,
  includeUsage = false
) {
  return {
    id: completionId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: done ? {} : { content: delta },
        finish_reason: done ? "stop" : null
      }
    ],
    usage: includeUsage ? null : undefined
  };
}

export function createUsageChunk(model: string, completionId: string, usage: TokenUsage | null) {
  return {
    id: completionId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage: formatUsage(usage)
  };
}

export function newCompletionId(): string {
  return `chatcmpl_${randomUUID()}`;
}
