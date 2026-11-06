import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/public-home";

export default function sitemap(): MetadataRoute.Sitemap {
  // Update dates when the corresponding public page changes substantially.
  return [
    { url: siteUrl, lastModified: "2026-11-06" },
    { url: `${siteUrl}about`, lastModified: "2026-11-06" },
    { url: `${siteUrl}contact`, lastModified: "2026-11-06" },
    { url: `${siteUrl}privacy`, lastModified: "2026-10-31" },
  ];
}
