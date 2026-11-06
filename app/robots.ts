import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/public-home";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${siteUrl}sitemap.xml`,
  };
}
