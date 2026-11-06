import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'IRH CORE — Discord management platform',
    template: '%s · IRH CORE',
  },
  description:
    'IRH CORE is an all-in-one Discord bot and management platform: moderation, automod, security, logging, tickets, leveling, giveaways, invite tracking and more.',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#070a15',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full font-sans">{children}</body>
    </html>
  );
}
