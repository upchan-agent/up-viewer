# UP Dashboard 🆙

LUKSO Universal Profile Dashboard - View your profile, social graph, and assets.

## Features

- 🆙 Profile display with avatar
- 🤝 Social graph (followers/following)
- 💎 Assets (LYX, LSP7, LSP8)
- 🖼️ Grid & Standalone mode support

## Tech Stack

- Next.js 15 (App Router)
- @lukso/up-provider
- @lsp-indexer/react (self-hosted)
- ethers.js

## Setup

1. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```

2. Set your indexer URL:
   ```
   NEXT_PUBLIC_INDEXER_URL=https://your-indexer-url/v1/graphql
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Run development server:
   ```bash
   npm run dev
   ```

## Deployment

Deploy to Vercel:

```bash
vercel --prod
```

**Note:** Set `NEXT_PUBLIC_INDEXER_URL` in Vercel environment variables.

---

Made with ❤️ by 🆙chan