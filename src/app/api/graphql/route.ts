import { NextRequest, NextResponse } from 'next/server';

const INDEXER_URL = process.env.INDEXER_URL || '';

function corsHeaders(origin?: string) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json',
  };
}

// Handle preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(request: NextRequest) {
  if (!INDEXER_URL) {
    return NextResponse.json({ error: 'INDEXER_URL not configured' }, { status: 500, headers: corsHeaders() });
  }

  const origin = request.headers.get('origin') || '*';
  const body = await request.text();

  const response = await fetch(INDEXER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const data = await response.text();
  return new NextResponse(data, {
    status: response.status,
    headers: corsHeaders(origin),
  });
}

export async function GET(request: NextRequest) {
  if (!INDEXER_URL) {
    return NextResponse.json({ error: 'INDEXER_URL not configured' }, { status: 500, headers: corsHeaders() });
  }

  const origin = request.headers.get('origin') || '*';
  const url = new URL(request.url);
  const query = url.searchParams.toString();
  const targetUrl = query ? `${INDEXER_URL}?${query}` : INDEXER_URL;

  const response = await fetch(targetUrl, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  const data = await response.text();
  return new NextResponse(data, {
    status: response.status,
    headers: corsHeaders(origin),
  });
}
