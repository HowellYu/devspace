export function prefersStatelessMcpTransport(userAgent: string | undefined): boolean {
  return (userAgent ?? "").toLowerCase().startsWith("openai-mcp/");
}
