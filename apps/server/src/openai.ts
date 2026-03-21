import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import type {
  ChatMessage,
  ChatMessageContentPart,
  ChatMessageFileContentPart,
  CodexTurnInput,
  JobRecord,
  PreparedCodexInput,
  TokenUsage
} from "./types.js";

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

const TEXT_FILE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

const IMAGE_MIME_TYPE_EXTENSIONS = new Map<string, string>([
  ["image/avif", ".avif"],
  ["image/bmp", ".bmp"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
  ["image/svg+xml", ".svg"],
  ["image/webp", ".webp"]
]);

function asContentParts(content: ChatMessage["content"]): ChatMessageContentPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return content;
}

function getTextPartText(part: ChatMessageContentPart): string | null {
  if (part.type === "text" || part.type === "input_text") {
    return part.text;
  }

  return null;
}

function getImagePartUrl(part: ChatMessageContentPart): string | null {
  if (part.type === "image") {
    return part.url;
  }

  if (part.type === "image_url" || part.type === "input_image") {
    if (typeof part.image_url === "string") {
      return part.image_url;
    }

    return typeof part.image_url?.url === "string" ? part.image_url.url : null;
  }

  return null;
}

function getFileDescriptor(part: ChatMessageContentPart): ChatMessageFileContentPart | null {
  if (part.type !== "file" && part.type !== "input_file") {
    return null;
  }

  return part;
}

function describePartForPrompt(part: ChatMessageContentPart): string {
  const text = getTextPartText(part);
  if (text !== null) {
    return text;
  }

  const imageUrl = getImagePartUrl(part);
  if (imageUrl !== null) {
    return `[image: ${imageUrl}]`;
  }

  const filePart = getFileDescriptor(part);
  if (filePart) {
    const descriptor = filePart.file ?? filePart;
    const name =
      descriptor.filename ??
      descriptor.path ??
      descriptor.file_url ??
      descriptor.url ??
      "attached file";
    return `[file: ${name}]`;
  }

  return "[unsupported content]";
}

function normalizePromptText(value: string): string {
  return value.trim();
}

function buildContextPrompt(messages: ChatMessage[]): { prompt: string; latestUserMessage: ChatMessage | null } {
  const systemMessages = messages.filter((message) => message.role === "system");
  const developerMessages = messages.filter((message) => message.role === "developer");
  const latestUserIndex = [...messages].map((message) => message.role).lastIndexOf("user");
  const latestUserMessage = latestUserIndex >= 0 ? messages[latestUserIndex] : null;
  const conversationMessages = messages.filter((message, index) => {
    if (!(message.role === "user" || message.role === "assistant" || message.role === "tool")) {
      return false;
    }

    return index !== latestUserIndex;
  });

  const sections: string[] = [];

  if (systemMessages.length > 0) {
    sections.push("[system]");
    sections.push(systemMessages.map((message) => flattenMessageContent(message)).join("\n\n"));
    sections.push("");
  }

  if (developerMessages.length > 0) {
    sections.push("[developer]");
    sections.push(developerMessages.map((message) => flattenMessageContent(message)).join("\n\n"));
    sections.push("");
  }

  if (conversationMessages.length > 0) {
    sections.push("[conversation]");
    for (const message of conversationMessages) {
      sections.push(`${message.role}: ${flattenMessageContent(message)}`);
    }
    sections.push("");
  }

  return {
    prompt: normalizePromptText(sections.join("\n")),
    latestUserMessage
  };
}

export function flattenMessageContent(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content.map((part) => describePartForPrompt(part)).join("\n");
}

function isFileUrl(value: string): boolean {
  return value.startsWith("file://");
}

function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

function isRemoteUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function resolveLocalPath(rawPath: string, workspacePath: string): string {
  if (isFileUrl(rawPath)) {
    return fileURLToPath(rawPath);
  }

  return path.isAbsolute(rawPath) ? rawPath : path.resolve(workspacePath, rawPath);
}

function isImageLike(fileNameOrPath: string, mimeType: string | null): boolean {
  if (mimeType?.startsWith("image/")) {
    return true;
  }

  const extension = path.extname(fileNameOrPath).toLowerCase();
  return new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]).has(extension);
}

function isTextLike(fileNameOrPath: string, mimeType: string | null): boolean {
  if (!mimeType) {
    return TEXT_FILE_EXTENSIONS.has(path.extname(fileNameOrPath).toLowerCase());
  }

  return mimeType.startsWith("text/") || mimeType === "application/json" || mimeType.endsWith("+json");
}

function isPdfLike(fileNameOrPath: string, mimeType: string | null): boolean {
  return mimeType === "application/pdf" || path.extname(fileNameOrPath).toLowerCase() === ".pdf";
}

function decodePdfStringLiteral(literal: string): string {
  let output = "";

  for (let index = 1; index < literal.length - 1; index += 1) {
    const char = literal[index];
    if (char !== "\\") {
      output += char;
      continue;
    }

    const next = literal[index + 1];
    if (next === undefined) {
      break;
    }

    index += 1;

    switch (next) {
      case "n":
        output += "\n";
        break;
      case "r":
        output += "\r";
        break;
      case "t":
        output += "\t";
        break;
      case "b":
        output += "\b";
        break;
      case "f":
        output += "\f";
        break;
      case "\\":
      case "(":
      case ")":
        output += next;
        break;
      default: {
        if (/[0-7]/.test(next)) {
          let octal = next;
          while (octal.length < 3 && /[0-7]/.test(literal[index + 1] ?? "")) {
            octal += literal[index + 1];
            index += 1;
          }
          output += String.fromCharCode(Number.parseInt(octal, 8));
          break;
        }

        output += next;
        break;
      }
    }
  }

  return output;
}

function extractPdfTextOperators(source: string): string[] {
  const values: string[] = [];
  const singleRegex = /\((?:\\.|[^\\()])*\)\s*Tj/g;
  const arrayRegex = /\[(.*?)\]\s*TJ/gs;

  for (const match of source.matchAll(singleRegex)) {
    const literal = match[0].match(/\((?:\\.|[^\\()])*\)/)?.[0];
    if (literal) {
      values.push(decodePdfStringLiteral(literal));
    }
  }

  for (const match of source.matchAll(arrayRegex)) {
    const literals = match[1]?.match(/\((?:\\.|[^\\()])*\)/g) ?? [];
    if (literals.length > 0) {
      values.push(literals.map((literal) => decodePdfStringLiteral(literal)).join(""));
    }
  }

  return values;
}

function extractPdfText(bytes: Buffer): string {
  const document = bytes.toString("latin1");
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const values: string[] = [];

  for (const match of document.matchAll(streamRegex)) {
    let streamBytes = Buffer.from(match[1] ?? "", "latin1");
    const header = document.slice(Math.max(0, match.index - 256), match.index);
    if (/\/Filter\s*\/FlateDecode/.test(header)) {
      try {
        streamBytes = zlib.inflateSync(streamBytes);
      } catch {
        continue;
      }
    }

    values.push(...extractPdfTextOperators(streamBytes.toString("latin1")));
  }

  return values
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function decodeDataUrl(dataUrl: string): { mimeType: string | null; bytes: Buffer } {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    throw new Error("invalid data URL");
  }

  const header = dataUrl.slice(5, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const parts = header.split(";").filter(Boolean);
  const mimeType = parts[0] && !parts[0].includes("=") ? parts[0] : null;
  const isBase64 = parts.includes("base64");

  return {
    mimeType,
    bytes: isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8")
  };
}

function decodeFileData(fileData: string): { mimeType: string | null; bytes: Buffer } {
  if (isDataUrl(fileData)) {
    return decodeDataUrl(fileData);
  }

  return {
    mimeType: null,
    bytes: Buffer.from(fileData, "base64")
  };
}

function extensionForMimeType(mimeType: string | null): string {
  if (!mimeType) {
    return ".bin";
  }

  return IMAGE_MIME_TYPE_EXTENSIONS.get(mimeType.toLowerCase()) ?? ".bin";
}

async function writeTempFile(bytes: Buffer, extension: string, cleanupPaths: string[]): Promise<string> {
  const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const tempFilePath = path.join(os.tmpdir(), `codex2api-${randomUUID()}${normalizedExtension}`);
  await fs.writeFile(tempFilePath, bytes);
  cleanupPaths.push(tempFilePath);
  return tempFilePath;
}

async function inlineBytesAsInputs(
  bytes: Buffer,
  fileName: string,
  mimeType: string | null,
  cleanupPaths: string[]
): Promise<CodexTurnInput[]> {
  if (isPdfLike(fileName, mimeType)) {
    const extractedText = extractPdfText(bytes);
    if (!extractedText) {
      throw new Error(`unsupported PDF attachment: ${fileName} has no extractable text`);
    }

    return [
      {
        type: "text",
        text: `[attached pdf: ${path.basename(fileName)}]\n${extractedText}`,
        text_elements: []
      }
    ];
  }

  if (isImageLike(fileName, mimeType)) {
    const extension = path.extname(fileName) || extensionForMimeType(mimeType);
    return [{ type: "localImage", path: await writeTempFile(bytes, extension, cleanupPaths) }];
  }

  if (!isTextLike(fileName, mimeType)) {
    throw new Error(`unsupported file type for inline attachment: ${fileName}`);
  }

  return [
    {
      type: "text",
      text: `[attached file: ${path.basename(fileName)}]\n${bytes.toString("utf8")}`,
      text_elements: []
    }
  ];
}

async function filePartToInputs(
  part: ChatMessageFileContentPart,
  workspacePath: string,
  cleanupPaths: string[]
): Promise<CodexTurnInput[]> {
  const descriptor = part.file ?? part;
  if (descriptor.file_id) {
    throw new Error("file_id attachments are not supported; use file_data, path, or file_url");
  }

  const rawPath = descriptor.path ?? descriptor.file_url ?? descriptor.url;
  const fileName = descriptor.filename ?? rawPath ?? "attachment";
  const mimeType = descriptor.mime_type ?? null;

  if (rawPath) {
    if (isDataUrl(rawPath)) {
      const decoded = decodeDataUrl(rawPath);
      return inlineBytesAsInputs(decoded.bytes, fileName, mimeType ?? decoded.mimeType, cleanupPaths);
    }

    if (isRemoteUrl(rawPath)) {
      if (isImageLike(fileName, mimeType)) {
        return [{ type: "image", url: rawPath }];
      }

      throw new Error(`remote file URLs are only supported for images: ${rawPath}`);
    }

    const resolvedPath = resolveLocalPath(rawPath, workspacePath);
    if (isImageLike(fileName, mimeType)) {
      return [{ type: "localImage", path: resolvedPath }];
    }

    if (isPdfLike(fileName, mimeType)) {
      return inlineBytesAsInputs(await fs.readFile(resolvedPath), fileName, mimeType, cleanupPaths);
    }

    if (!isTextLike(fileName, mimeType)) {
      throw new Error(`unsupported local file type for inline attachment: ${rawPath}`);
    }

    const content = await fs.readFile(resolvedPath, "utf8");
    return [
      {
        type: "text",
        text: `[attached file: ${path.basename(fileName)}]\n${content}`,
        text_elements: []
      }
    ];
  }

  if (!descriptor.file_data) {
    throw new Error("file content part requires path, file_url, url, or file_data");
  }

  const decoded = decodeFileData(descriptor.file_data);
  return inlineBytesAsInputs(decoded.bytes, fileName, mimeType ?? decoded.mimeType, cleanupPaths);
}

async function latestUserMessageToInputs(
  message: ChatMessage | null,
  workspacePath: string,
  cleanupPaths: string[]
): Promise<CodexTurnInput[]> {
  if (!message) {
    return [];
  }

  if (typeof message.content === "string") {
    return message.content.trim()
      ? [
          {
            type: "text",
            text: message.content,
            text_elements: []
          }
        ]
      : [];
  }

  const inputs: CodexTurnInput[] = [];
  for (const part of asContentParts(message.content)) {
    const text = getTextPartText(part);
    if (text !== null) {
      if (text.trim()) {
        inputs.push({ type: "text", text, text_elements: [] });
      }
      continue;
    }

    const imageUrl = getImagePartUrl(part);
    if (imageUrl !== null) {
      if (isDataUrl(imageUrl)) {
        const decoded = decodeDataUrl(imageUrl);
        if (!decoded.mimeType?.startsWith("image/")) {
          throw new Error("input_image data URL must contain an image MIME type");
        }

        inputs.push({
          type: "localImage",
          path: await writeTempFile(decoded.bytes, extensionForMimeType(decoded.mimeType), cleanupPaths)
        });
        continue;
      }

      if (isFileUrl(imageUrl) || path.isAbsolute(imageUrl)) {
        inputs.push({ type: "localImage", path: resolveLocalPath(imageUrl, workspacePath) });
      } else {
        inputs.push({ type: "image", url: imageUrl });
      }
      continue;
    }

    const filePart = getFileDescriptor(part);
    if (filePart) {
      inputs.push(...(await filePartToInputs(filePart, workspacePath, cleanupPaths)));
    }
  }

  return inputs;
}

export async function prepareCodexInput(
  messages: ChatMessage[],
  workspacePath: string
): Promise<PreparedCodexInput> {
  try {
    const { prompt, latestUserMessage } = buildContextPrompt(messages);
    const cleanupPaths: string[] = [];
    const inputs: CodexTurnInput[] = [];

    if (prompt) {
      inputs.push({
        type: "text",
        text: prompt,
        text_elements: []
      });
    }

    const latestInputs = await latestUserMessageToInputs(latestUserMessage, workspacePath, cleanupPaths);
    inputs.push(...latestInputs);

    if (inputs.length === 0) {
      inputs.push({
        type: "text",
        text: normalizePromptText(messages.map((message) => `${message.role}: ${flattenMessageContent(message)}`).join("\n")),
        text_elements: []
      });
    }

    return {
      input: inputs,
      cleanupPaths
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid multimodal input";
    throw new Error(`invalid multimodal input: ${message}`);
  }
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
