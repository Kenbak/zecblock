import 'server-only';
import { proxyAskStaging } from '@/lib/ask/staging-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

export const GET = proxyAskStaging;
export const POST = proxyAskStaging;
export const PUT = proxyAskStaging;
export const PATCH = proxyAskStaging;
export const DELETE = proxyAskStaging;
export const HEAD = proxyAskStaging;
export const OPTIONS = proxyAskStaging;
