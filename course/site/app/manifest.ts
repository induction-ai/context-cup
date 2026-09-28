import { COLORS, SITE_DESCRIPTION, SITE_NAME } from "@/src/lib/brand";
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "browser",
    background_color: COLORS.cream,
    theme_color: COLORS.cream,
    icons: [{ src: "/apple-icon", sizes: "180x180", type: "image/png" }],
  };
}
