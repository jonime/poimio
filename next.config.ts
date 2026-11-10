import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  typedRoutes: true,
  // Keep the RSC header visible so Proxy can defer navigation requests to Next.js.
  skipProxyUrlNormalize: true,
  async headers() {
    const supabaseUrl = URL.parse(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    const supabaseOrigin =
      supabaseUrl?.protocol === "http:" || supabaseUrl?.protocol === "https:"
        ? ` ${supabaseUrl.origin}`
        : "";
    const contentSecurityPolicy = [
      "default-src 'self'",
      // Next.js emits inline bootstrap scripts in the prerendered shell.
      "script-src 'self' 'unsafe-inline'",
      "script-src-attr 'none'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' https:",
      "font-src 'self'",
      `connect-src 'self'${supabaseOrigin}`,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; ");

    return [
      {
        source: "/",
        headers: [{ key: "Link", value: '</llms.txt>; rel="describedby"' }],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Content-Security-Policy", value: contentSecurityPolicy }]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
