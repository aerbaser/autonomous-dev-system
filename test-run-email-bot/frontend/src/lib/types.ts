// Ping
export interface PingResponse {
  status: string;
}

// Accounts
export interface AccountCreate {
  email: string;
  display_name?: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  username: string;
  password: string;
}

export interface AccountCreatedResponse {
  id: number;
  email: string;
  imap_connected: boolean;
  inbox_count: number;
}

export interface AccountListItem {
  id: number;
  email: string;
  display_name: string | null;
  is_active: boolean;
  created_at: string;
}

export interface AccountTestResult {
  imap_ok: boolean;
  smtp_ok: boolean;
  inbox_count: number;
  error: string | null;
}

// Emails
export interface EmailListItem {
  id: number;
  uid: number;
  from_name: string;
  from_address: string;
  subject: string;
  date: string;
  is_read: boolean;
  category: EmailCategory | null;
  category_source: CategorySource | null;
}

export interface EmailListResponse {
  emails: EmailListItem[];
  total: number;
  page: number;
  pages: number;
}

export interface EmailDetail {
  id: number;
  from_name: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  body_text: string | null;
  body_html: string | null;
  date: string;
  is_read: boolean;
  category: EmailCategory | null;
  category_source: CategorySource | null;
  headers: Record<string, string>;
}

export interface CategoryUpdateRequest {
  category: EmailCategory;
}

export interface CategoryUpdateResponse {
  id: number;
  category: EmailCategory;
  category_source: 'manual';
}

// Send email
export interface SendEmailRequest {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  reply_to_id?: number | null;
}

export interface SendEmailResponse {
  success: boolean;
  message_id: string;
}

// Folders
export interface Folder {
  name: string;
  unread_count: number;
  total_count: number;
}

// Drafts
export interface GenerateDraftRequest {
  email_id: number;
  tone: DraftTone;
}

export interface GenerateDraftResponse {
  draft_body: string;
  detected_language: string;
  generation_time_ms: number;
}

// Chat
export interface ChatRequest {
  message: string;
  session_id?: number | null;
}

export interface ReferencedEmail {
  id: number;
  subject: string;
  date: string;
}

export interface ChatResponse {
  response: string;
  session_id: number;
  referenced_emails: ReferencedEmail[];
}

export interface ChatMessageItem {
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface ChatSessionHistory {
  session_id: number;
  messages: ChatMessageItem[];
}

// Sync
export interface SyncTriggerResponse {
  synced_count: number;
  folder: string;
  duration_ms: number;
}

// Health
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthResponse {
  status: HealthStatus;
  imap_connected: boolean;
  ollama_running: boolean;
  model_loaded: boolean;
  model_name: string | null;
  vram_usage_mb: number | null;
  db_size_mb: number;
  last_sync_at: string | null;
  email_count: number;
}

export interface OllamaModel {
  name: string;
  size_gb: number;
  loaded: boolean;
}

export interface OllamaStatusResponse {
  ollama_version: string | null;
  running: boolean;
  models: OllamaModel[];
  error: string | null;
  pull_command: string;
}

// Enums / literals
export type EmailCategory = 'Work' | 'Personal' | 'Newsletters' | 'Transactions' | 'Spam';
export type CategorySource = 'ai' | 'manual';
export type DraftTone = 'professional' | 'casual' | 'concise';
