import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from 'next/font/google';
import './globals.css';
import 'maplibre-gl/dist/maplibre-gl.css';

// Panels: serif for names and headings, Plex for interface text, Plex Mono for data
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
});
const serif = Newsreader({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-serif',
});
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'SvalMap - Maritime Monitoring System',
  description: 'Real-time maritime monitoring for Svalbard EEZ and Barents Sea',
  keywords: 'maritime, monitoring, Svalbard, Barents Sea, vessel tracking',
  authors: [{ name: 'SvalMap Team' }],
  viewport: 'width=device-width, initial-scale=1',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body className={`${sans.className} h-screen overflow-hidden`}>
        <div className="h-screen w-full">{children}</div>
      </body>
    </html>
  );
}
