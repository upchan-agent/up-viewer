# UP Viewer 🆙

LUKSO Universal Profile viewer — browse profiles, social connections, assets, and activity.

## Features

- 🆙 Profile display with avatar & search
- 🤝 Social graph (followers / following)
- 💎 Assets (LYX, LSP7, LSP8) with image caching
- 📜 Activity list
- 🔗 GraphQL proxy via internal API route (`/api/graphql`)

## Tech Stack

- Next.js 15 (App Router) + React 19 + Tailwind CSS v4
- @lukso/up-provider, @lukso/up-modal
- @lsp-indexer/react, @erc725/erc725.js
- ethers.js, viem, wagmi
- @tanstack/react-query, @tanstack/react-virtual, SWR

## Getting Started

```bash
cp .env.example .env.local   # edit INDEXER_URL to your Hasura endpoint
npm install
npm run dev                  # http://localhost:3000
```

### Environment Variables

| Variable | Description |
|---|---|
| `INDEXER_URL` | Hasura GraphQL endpoint (server-side only) |
| `NEXT_PUBLIC_INDEXER_URL` | Proxy URL exposed to the client (default: `/api/graphql`) |

## Deploy

```bash
vercel
```

Set `INDEXER_URL` in Vercel environment variables.

---

Made with ❤️ by 🆙chan
