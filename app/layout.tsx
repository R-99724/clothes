import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "衣样 YIYANG — AI 服装设计与试穿",
  description: "上传照片试穿服装，用对话设计新款，把喜欢的服装存入参考衣橱。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
