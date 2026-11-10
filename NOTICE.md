# Attribution

## Vendored logic

The failure classification rules in `src/classify.ts` are adapted from:

- Project: tavily-mcp-loadbalancer
- Source: https://github.com/yatotm/tavily-mcp-loadbalancer
- License: MIT License
- Copyright: Copyright (c) yatotm and contributors

Adapted changes: the provider union was replaced with a configurable
`QuotaRules` object so any upstream can be described without code changes; the
judgement was split into HTTP-level and payload-level entry points; retry
safety is expressed as an explicit `requestNotProcessed` flag.

## Design notes

The upstream response shapes documented in `src/budget.ts` were measured
against the live Tavily, Firecrawl and Exa hosted MCP endpoints. They are
recorded as observations, not as vendor documentation.
