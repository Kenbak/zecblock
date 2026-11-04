import 'server-only';
import { proxyStagingData } from '@/lib/staging-data-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export const GET = proxyStagingData;
export const POST = proxyStagingData;
export const PUT = proxyStagingData;
export const PATCH = proxyStagingData;
export const DELETE = proxyStagingData;
export const HEAD = proxyStagingData;
export const OPTIONS = proxyStagingData;
