"use client";

import {
  ArrowLeft,
  Clock3,
  FileArchive,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trophy,
  UploadCloud,
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";

import styles from "./Competition.module.css";

type CompetitionDivision = "primary" | "junior" | "senior";

interface CompetitionTeam {
  id: string;
  teamName: string;
  division: CompetitionDivision;
  createdAt: number;
}

interface CompetitionSubmission {
  id: string;
  status: "submitted";
  submittedAt: number;
}

interface CompetitionMeResponse {
  team: CompetitionTeam | null;
  latestSubmission: CompetitionSubmission | null;
}

interface CompetitionSubmissionResponse {
  submission: CompetitionSubmission;
}

interface ApiErrorPayload {
  error?: string | { code?: string; message?: string };
}

const DIVISIONS: ReadonlyArray<{ value: CompetitionDivision; name: string }> = [
  { value: "primary", name: "小学组" },
  { value: "junior", name: "初中组" },
  { value: "senior", name: "高中组" },
];

class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as ApiErrorPayload).error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw new ApiRequestError(response.status, errorMessage(payload, "请求失败，请稍后重试。"));
  return payload as T;
}

function divisionName(division: CompetitionDivision): string {
  return DIVISIONS.find((item) => item.value === division)?.name ?? division;
}

function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function CompetitionPortal() {
  const [sessionState, setSessionState] = useState<"loading" | "guest" | "ready">("loading");
  const [team, setTeam] = useState<CompetitionTeam | null>(null);
  const [latestSubmission, setLatestSubmission] = useState<CompetitionSubmission | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [submissionBusy, setSubmissionBusy] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submissionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await requestJson<CompetitionMeResponse>("/api/competition/me");
        if (cancelled) return;
        setTeam(payload.team);
        setLatestSubmission(payload.latestSubmission);
        setSessionState(payload.team ? "ready" : "guest");
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          setSessionState("guest");
          return;
        }
        setAuthError(error instanceof Error ? error.message : "无法读取参赛信息，请稍后重试。");
        setSessionState("guest");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const logout = async () => {
    if (authBusy || submissionBusy) return;
    setAuthBusy(true);
    setNotice(null);
    try {
      await fetch("/api/competition/logout", { method: "POST", cache: "no-store" }).catch(() => null);
      const response = await fetch("/api/v1/auth/logout", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("统一平台退出失败，请稍后重试。");
      setTeam(null);
      setLatestSubmission(null);
      setModelFile(null);
      submissionKeyRef.current = null;
      setSessionState("guest");
      window.location.assign("/login.html");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "退出失败，请稍后重试。");
    } finally {
      setAuthBusy(false);
    }
  };

  const submitModel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!modelFile || submissionBusy) return;
    setSubmissionBusy(true);
    setSubmissionError(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("model", modelFile, modelFile.name);
      const idempotencyKey = submissionKeyRef.current ?? crypto.randomUUID();
      submissionKeyRef.current = idempotencyKey;
      const payload = await requestJson<CompetitionSubmissionResponse>("/api/competition/submissions", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body,
      });
      setLatestSubmission(payload.submission);
      setModelFile(null);
      submissionKeyRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = "";
      setNotice("模型已提交。选手端不显示评测成绩，最后一次提交将作为本队计分模型。");
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : "模型提交失败，请稍后重试。");
    } finally {
      setSubmissionBusy(false);
    }
  };

  return (
    <main className={styles.portal}>
      <header className={styles.siteHeader}>
        <Link className={styles.brand} href="/workshop/" aria-label="识物工坊首页">
          <span className={styles.brandMark} aria-hidden="true"><Sparkles size={20} /></span>
          <span>识物工坊竞赛</span>
        </Link>
        <nav className={styles.headerActions} aria-label="页面导航">
          <a className={styles.textLink} href="/portal.html"><ArrowLeft size={16} />返回统一平台</a>
          <Link className={styles.adminLink} href="/workshop/"><Sparkles size={16} />识物训练台</Link>
        </nav>
      </header>

      {sessionState === "loading" ? (
        <section className={styles.centerState} aria-live="polite" aria-busy="true">
          <RefreshCw className={styles.spin} size={28} aria-hidden="true" />
          <h1>正在读取参赛信息</h1>
          <p>请稍候，数据不会离开本次比赛系统。</p>
        </section>
      ) : sessionState === "guest" ? (
        <div className={styles.guestLayout}>
          <section className={styles.hero} aria-labelledby="competition-title">
            <span className={styles.kicker}><Trophy size={16} />橙子识别挑战赛</span>
            <h1 id="competition-title">训练你的模型，<br /><em>准确识别橙子。</em></h1>
            <p>分别采集“橙子”和“非橙子”图片，在识物工坊完成训练并导出模型 ZIP。评测成绩仅赛事管理员可见。</p>
            <ol className={styles.steps} aria-label="参赛步骤">
              <li><strong>01</strong><span>准备均衡的橙子与非橙子图片</span></li>
              <li><strong>02</strong><span>在浏览器训练并导出模型</span></li>
              <li><strong>03</strong><span>登录本页提交，确认提交记录</span></li>
            </ol>
          </section>

          <section className={styles.authCard} aria-labelledby="auth-title">
            <div className={styles.formHeading}>
              <span className={styles.cardIcon}><ShieldCheck size={22} /></span>
              <div><h2 id="auth-title">请先登录统一竞赛平台</h2><p>账号、队伍和参赛组别由统一平台管理，识物工坊不再单独注册。</p></div>
            </div>
            {authError && <p className={styles.errorBox} role="alert">{authError}</p>}
            <a className={styles.primaryButton} href="/login.html">前往统一登录</a>
            <a className={styles.textLink} href="/portal.html"><ArrowLeft size={16} />返回赛题中心</a>
          </section>
        </div>
      ) : team ? (
        <div className={styles.dashboard}>
          <section className={styles.dashboardHero}>
            <div>
              <span className={styles.kicker}><Trophy size={16} />{divisionName(team.division)}</span>
              <h1>你好，{team.teamName}</h1>
              <p>提交训练台导出的“橙子 / 非橙子”模型 ZIP。每支队伍以最后一次提交为准，选手端不显示评测成绩。</p>
            </div>
            <button className={styles.secondaryButton} type="button" disabled={authBusy || submissionBusy} onClick={() => void logout()}><LogOut size={16} />退出队伍</button>
          </section>

          {notice && <p className={styles.notice} role="status" aria-live="polite">{notice}</p>}

          <div className={styles.dashboardGrid}>
            <section className={styles.card} aria-labelledby="submit-model-title">
              <div className={styles.cardHeading}>
                <span className={styles.cardIcon}><UploadCloud size={22} /></span>
                <div><h2 id="submit-model-title">提交橙子识别模型</h2><p>请选择识物工坊导出的完整模型 ZIP。</p></div>
              </div>
              <form className={styles.uploadForm} onSubmit={submitModel} aria-busy={submissionBusy}>
                <label className={`${styles.fileDrop} ${modelFile ? styles.fileSelected : ""}`}>
                  <input ref={fileInputRef} type="file" required accept=".zip,application/zip" disabled={submissionBusy} onChange={(event) => { const file = event.target.files?.[0] ?? null; setModelFile(file); submissionKeyRef.current = file ? crypto.randomUUID() : null; setSubmissionError(null); }} />
                  <FileArchive size={32} aria-hidden="true" />
                  {modelFile ? (
                    <span><strong>{modelFile.name}</strong><small>{formatFileSize(modelFile.size)} · 点击可重新选择</small></span>
                  ) : (
                    <span><strong>选择模型 ZIP</strong><small>也可以将文件拖放到这里</small></span>
                  )}
                </label>
                <p className={styles.helperText}>模型必须且只能包含“橙子”和“非橙子”两个类别；ZIP 不超过 2 MiB，请勿重新压缩或改动内部文件。</p>
                <div className={styles.uploadNote}><ShieldCheck size={16} /><span>评分使用本组测试集；测试图片对选手保密，选手端不会返回测试结果或成绩。</span></div>
                {submissionError && <p className={styles.errorBox} role="alert">{submissionError}</p>}
                <button className={styles.primaryButton} type="submit" disabled={!modelFile || submissionBusy}>
                  {submissionBusy ? <><RefreshCw className={styles.spin} size={18} />正在提交模型</> : <><UploadCloud size={18} />提交本次模型</>}
                </button>
              </form>
            </section>

            <section className={styles.card} aria-labelledby="latest-submission-title">
              <div className={styles.cardHeading}>
                <span className={styles.cardIcon}><Trophy size={22} /></span>
                <div><h2 id="latest-submission-title">最后一次提交</h2><p>这里只显示提交回执，不显示评测成绩。</p></div>
              </div>
              {latestSubmission ? (
                <article className={styles.resultCard}>
                  <div className={styles.resultTopline}>
                    <span className={`${styles.statusPill} ${styles.statusSuccess}`}>提交已接收</span>
                    <time dateTime={new Date(latestSubmission.submittedAt).toISOString()}>{formatDate(latestSubmission.submittedAt)}</time>
                  </div>
                  <div className={styles.scoreBlock}>
                    <span>提交回执</span>
                    <strong>模型已成功提交</strong>
                    <small>为防止反复试探测试集，评测状态、成绩和明细仅赛事管理员可见。</small>
                  </div>
                  <dl className={styles.resultDetails}>
                    <div><dt>提交状态</dt><dd>已接收</dd></div>
                    <div><dt>计分规则</dt><dd>以最后一次提交为准</dd></div>
                    <div><dt>提交编号</dt><dd title={latestSubmission.id}>{latestSubmission.id.slice(0, 12)}</dd></div>
                  </dl>
                </article>
              ) : (
                <div className={styles.emptyState}>
                  <Clock3 size={30} aria-hidden="true" />
                  <strong>还没有提交记录</strong>
                  <p>选择左侧模型 ZIP 并提交后，最后一次提交记录会显示在这里。</p>
                </div>
              )}
            </section>
          </div>
        </div>
      ) : null}

      <footer className={styles.footer}>
        <span>识物工坊竞赛平台</span>
        <span>账号、队伍与会话由统一竞赛平台管理；训练项目仍只保存在当前设备浏览器中。</span>
      </footer>
    </main>
  );
}
