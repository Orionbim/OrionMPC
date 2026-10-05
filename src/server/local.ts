import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.js";
await createServer().connect(new StdioServerTransport());
