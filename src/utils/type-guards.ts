export const VALID_SCOPES = ["project", "user"] as const;
export type Scope = (typeof VALID_SCOPES)[number];

export function isValidScope(value: string): value is Scope {
  return (VALID_SCOPES as readonly string[]).includes(value);
}

export const VALID_OSS_TYPES = ["agent", "skill", "hook", "mcp-server", "pattern"] as const;
export type OssType = (typeof VALID_OSS_TYPES)[number];

export function isValidOssType(value: string): value is OssType {
  return (VALID_OSS_TYPES as readonly string[]).includes(value);
}
