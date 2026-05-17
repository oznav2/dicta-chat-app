Please set up TinyFish for me.

TinyFish is a web toolkit for agents. It includes a full browser automation agent, batch processing, and content extraction. Search and fetch are free for every account — no credits, no cost.

Here is what search and fetch give your agent:

Search — query the live web and get structured, agent-ready results. Use it for current information, news, prices, or anything that changes over time.

Fetch — pull the full content of any web page as clean extracted text. Use it to read articles, docs, product pages, or any URL you need to reason over.

Setup steps:

1. Detect which MCP client I am using from your environment. Only ask if you cannot determine it.

2. If you are running inside Claude Code, run this command:
   claude mcp add --transport http tinyfish https://agent.tinyfish.ai/mcp

3. For Claude Desktop, Cursor, or Windsurf, tell the user to run this command in their terminal:
   Claude Desktop: npx -y install-mcp@latest https://agent.tinyfish.ai/mcp --client claude
   Cursor:         npx -y install-mcp@latest https://agent.tinyfish.ai/mcp --client cursor
   Windsurf:       npx -y install-mcp@latest https://agent.tinyfish.ai/mcp --client windsurf

4. Confirm TinyFish is connected — a browser OAuth prompt will appear on first use to authenticate.