import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { THEME_COLOR, THEME_SCRIPT } from "./lib/theme";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/manifest.webmanifest" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme et la couleur de la barre sont posés par THEME_SCRIPT avant l'hydratation.
    <html lang="fr" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="robots" content="noindex, nofollow" />
        <meta name="theme-color" content={THEME_COLOR.dark} suppressHydrationWarning />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Essaim" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
        <script
          // Web app installable : le service worker (public/sw.js) n'est enregistré qu'en ligne, pas en développement.
          dangerouslySetInnerHTML={{
            __html: `if("serviceWorker" in navigator && location.hostname !== "localhost") addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));`,
          }}
        />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Une erreur est survenue";
  let details = "Réessaie dans un instant.";
  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? "Page introuvable" : `Erreur ${error.status}`;
    details = typeof error.data === "string" ? error.data : error.statusText || details;
  } else if (error instanceof Error) {
    details = error.message;
  }
  return (
    <main className="error-page">
      <h1>{title}</h1>
      <p>{details}</p>
      <a className="btn primary" href="/">
        Retour à l'équipe
      </a>
    </main>
  );
}
