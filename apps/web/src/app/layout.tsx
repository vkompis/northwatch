import type { Metadata, Viewport } from 'next';
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

// Prefix for files in public/ when the site lives under a path (GitHub Pages)
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

export const metadata: Metadata = {
  title: 'NorthWatch — maritime OSINT for the High North',
  // "Add to Home Screen" opens the map full screen, without the browser bars
  manifest: `${basePath}/manifest.webmanifest`,
  // Translucent: the map runs under the iPhone status bar; globals.css pads the top bar for it
  appleWebApp: { capable: true, title: 'NorthWatch', statusBarStyle: 'black-translucent' },
  icons: { icon: `${basePath}/icon.svg`, apple: `${basePath}/apple-touch-icon.png` },
  description:
    'Live ships, sanctions and shadow-fleet lists, warnings and seabed infrastructure across the Norwegian Sea, Barents Sea and Svalbard',
  keywords: 'maritime, OSINT, Norwegian Sea, Barents Sea, Svalbard, vessel tracking, sanctions, shadow fleet',
  authors: [{ name: 'NorthWatch' }],
};

// cover: edge to edge on phones with a notch / home indicator (safe-area padding in globals.css)
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#101d25',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* Panels follow data-theme; set it before first paint so a light choice never flashes dark */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('svalmap.theme')==='light')document.documentElement.dataset.theme='light'}catch(e){}",
          }}
        />
      </head>
      <body className={`${sans.className} h-screen overflow-hidden`}>
        <div className="h-screen w-full">{children}</div>
      </body>
    </html>
  );
}
