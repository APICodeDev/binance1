import React from 'react';
// app/layout.tsx
import './globals.css';
import { Inter } from 'next/font/google'
import type { Viewport } from 'next'

const inter = Inter({ subsets: ['latin'] })

export const metadata = {
  title: 'KrakenDesk',
  description: 'Premium trading dashboard powered by Kraken Futures execution',
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0b0c0f',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-slate-950 text-slate-50 antialiased`}>
        {children}
      </body>
    </html>
  )
}
