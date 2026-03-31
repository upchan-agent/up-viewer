import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const indexerUrl = process.env.INDEXER_URL;
  if (!indexerUrl) {
    return NextResponse.json({ error: 'INDEXER_URL not configured' }, { status: 500 });
  }

  const body = await request.text();

  const response = await fetch(indexerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const data = await response.text();
  return new NextResponse(data, {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  });
}