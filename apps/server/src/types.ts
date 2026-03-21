export type AccountStatus = "starting" | "ready" | "error" | "stopped";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timeout";

export interface RateLimitWindowRecord {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitRecord {
  accountId: string;
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindowRecord | null;
  secondary: RateLimitWindowRecord | null;
  planType: string | null;
  updatedAt: string;
}

export interface AccountRecord {
  id: string;
  name: string;
  codexHome: string;
  status: AccountStatus;
  authType: string | null;
  email: string | null;
  planType: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  lastRateLimitRefreshAt: string | null;
  rateLimits: RateLimitRecord[];
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecord {
  id: string;
  accountId: string | null;
  workspaceId: string;
  threadId: string | null;
  turnId: string | null;
  model: string;
  status: JobStatus;
  requestBody: string;
  finalText: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobEventRecord {
  id: string;
  jobId: string;
  seq: number;
  eventType: string;
  payloadJson: string;
  createdAt: string;
}

export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | ChatMessageContentPart[];
}

export interface ChatMessageTextContentPart {
  type: "text" | "input_text";
  text: string;
}

export interface ChatMessageImageContentPart {
  type: "image_url" | "input_image";
  image_url:
    | string
    | {
        url: string;
      };
}

export interface ChatMessageImageContentPartLegacy {
  type: "image";
  url: string;
}

export interface ChatMessageFileDescriptor {
  file_id?: string;
  filename?: string;
  mime_type?: string;
  file_data?: string;
  path?: string;
  file_url?: string;
  url?: string;
}

export interface ChatMessageFileContentPart {
  type: "file" | "input_file";
  file?: ChatMessageFileDescriptor;
  file_id?: string;
  filename?: string;
  mime_type?: string;
  file_data?: string;
  path?: string;
  file_url?: string;
  url?: string;
}

export type ChatMessageContentPart =
  | ChatMessageTextContentPart
  | ChatMessageImageContentPart
  | ChatMessageImageContentPartLegacy
  | ChatMessageFileContentPart;

export interface ChatCompletionRequestBody {
  model?: string;
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  temperature?: number;
  messages: ChatMessage[];
  metadata?: Record<string, unknown>;
}

export interface JobRequest {
  workspaceId: string;
  model: string;
  stream: boolean;
  messages: ChatMessage[];
  preparedInput?: PreparedCodexInput;
  metadata?: Record<string, unknown>;
  requestBody: ChatCompletionRequestBody;
}

export interface TokenUsage {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface JobExecutionResult {
  text: string;
  usage: TokenUsage | null;
  threadId: string;
  turnId: string;
  status: "completed" | "interrupted" | "failed";
  errorMessage?: string;
}

export interface JobRuntimeEvent {
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type CodexTurnInput =
  | {
      type: "text";
      text: string;
      text_elements: [];
    }
  | {
      type: "image";
      url: string;
    }
  | {
      type: "localImage";
      path: string;
    };

export interface PreparedCodexInput {
  input: CodexTurnInput[];
  cleanupPaths: string[];
}

export interface AccountSnapshot {
  authType: string | null;
  email: string | null;
  planType: string | null;
}
