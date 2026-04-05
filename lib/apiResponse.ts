import { NextResponse } from 'next/server';

export function ok<T>(data?: T, message?: string) {
  return NextResponse.json({ success: true, message, data });
}

export function fail(status: number, message: string, details?: unknown, errorCode?: string) {
  return NextResponse.json({ success: false, message, details, errorCode }, { status });
}
