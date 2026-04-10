export const dynamic = 'force-dynamic';

import fs from 'fs/promises';
import path from 'path';
import { NextRequest } from 'next/server';
import { ok } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';

const ALLOWED_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a']);

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const soundsDir = path.join(process.cwd(), 'public', 'sounds');

  try {
    const entries = await fs.readdir(soundsDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));

    return ok({ files }, 'Sounds loaded');
  } catch {
    return ok({ files: [] }, 'Sounds folder not found');
  }
}
