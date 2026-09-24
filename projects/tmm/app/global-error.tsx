"use client";

import { useEffect, type CSSProperties } from "react";

type GlobalErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    console.error("识物工坊页面运行异常", error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body style={styles.body}>
        <main style={styles.card}>
          <div aria-hidden="true" style={styles.icon}>!</div>
          <h1 style={styles.title}>页面暂时没有加载完成</h1>
          <p style={styles.description}>
            可能是服务刚刚重启或临时网络中断，请重新加载后继续。
          </p>
          <div style={styles.actions}>
            <button
              type="button"
              style={{ ...styles.button, ...styles.primaryButton }}
              onClick={() => {
                reset();
                window.location.reload();
              }}
            >
              重新加载
            </button>
            <button
              type="button"
              style={{ ...styles.button, ...styles.secondaryButton }}
              onClick={() => window.location.assign("/portal.html")}
            >
              返回比赛平台
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}

const styles: Record<string, CSSProperties> = {
  body: {
    alignItems: "center",
    background: "linear-gradient(145deg, #071525 0%, #0c2139 100%)",
    color: "#f5f9ff",
    display: "flex",
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
    justifyContent: "center",
    margin: 0,
    minHeight: "100vh",
    padding: "24px",
  },
  card: {
    background: "rgba(11, 30, 52, 0.96)",
    border: "1px solid #315576",
    borderRadius: "24px",
    boxShadow: "0 24px 70px rgba(0, 0, 0, 0.28)",
    boxSizing: "border-box",
    maxWidth: "520px",
    padding: "42px 38px",
    textAlign: "center",
    width: "100%",
  },
  icon: {
    alignItems: "center",
    background: "linear-gradient(145deg, #7559ee, #28b9d6)",
    borderRadius: "18px",
    display: "flex",
    fontSize: "32px",
    fontWeight: 800,
    height: "64px",
    justifyContent: "center",
    margin: "0 auto 24px",
    width: "64px",
  },
  title: {
    fontSize: "28px",
    lineHeight: 1.3,
    margin: "0 0 14px",
  },
  description: {
    color: "#b8cae0",
    fontSize: "16px",
    lineHeight: 1.7,
    margin: "0 auto 28px",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "12px",
    justifyContent: "center",
  },
  button: {
    borderRadius: "12px",
    cursor: "pointer",
    fontSize: "16px",
    fontWeight: 700,
    minHeight: "46px",
    padding: "0 22px",
  },
  primaryButton: {
    background: "linear-gradient(135deg, #6759e8, #20a9c9)",
    border: 0,
    color: "#ffffff",
  },
  secondaryButton: {
    background: "transparent",
    border: "1px solid #527394",
    color: "#dceafa",
  },
};
