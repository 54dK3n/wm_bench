import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "识物工坊｜浏览器里的橙子识别比赛训练台";
const description =
  "分别上传或拍摄橙子与非橙子图片，在浏览器中训练、测试并导入导出 TensorFlow.js 橙子识别模型。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const socialImage = new URL("/og.png", origin).toString();

  return {
    title,
    description,
    applicationName: "识物工坊",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      type: "website",
      title,
      description,
      siteName: "识物工坊",
      locale: "zh_CN",
      images: [{ url: socialImage, width: 1536, height: 1024, alt: "识物工坊橙子识别训练流程" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
