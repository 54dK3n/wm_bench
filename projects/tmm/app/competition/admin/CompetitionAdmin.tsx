"use client";

import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Database,
  Download,
  FileArchive,
  Layers3,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Trophy,
  UploadCloud,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";

import {
  buildCompetitionEvaluationSet,
  type EvaluationBuildProgress,
} from "@/lib/competition/evaluation-builder";
import type { CompetitionEvaluationSet } from "@/lib/competition/evaluation-format";
import { hasOrangeCompetitionLabels } from "@/lib/competition/rules";
import styles from "../Competition.module.css";

type CompetitionDivision = "primary" | "junior" | "senior";
type SubmissionStatus = "pending" | "uploaded" | "evaluating" | "scored" | "failed" | "rejected";

interface AdminSessionResponse {
  authenticated: boolean;
}

interface EvaluationSetSummary {
  division: CompetitionDivision;
  version: string | number;
  sampleCount: number;
  labels: string[];
  updatedAt: number;
}

interface TeamStanding {
  teamId: string;
  teamName: string;
  division: CompetitionDivision;
  submittedAt: number;
  status: SubmissionStatus;
  scoreMicros: number | null;
  correctCount: number | null;
  totalCount: number | null;
  modelName: string | null;
  submissionId: string;
  errorMessage: string | null;
  evaluationVersion: string | null;
}

interface AdminOverviewResponse {
  evaluationSets: EvaluationSetSummary[];
  leaderboards: Record<CompetitionDivision, TeamStanding[]>;
}

interface EvaluationSetResponse {
  evaluationSet: EvaluationSetSummary;
  rescoredSubmissionCount: number;
  rescoreFailedCount: number;
  rescoreQueuedCount?: number;
  rescoreDeferredCount?: number;
}

interface ApiErrorPayload {
  error?: string | { code?: string; message?: string };
}

const DIVISIONS: ReadonlyArray<{ value: CompetitionDivision; name: string; description: string }> = [
  { value: "primary", name: "小学组", description: "小学阶段队伍" },
  { value: "junior", name: "初中组", description: "初中阶段队伍" },
  { value: "senior", name: "高中组", description: "高中阶段队伍" },
];

const EMPTY_LEADERBOARDS: Record<CompetitionDivision, TeamStanding[]> = {
  primary: [],
  junior: [],
  senior: [],
};

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

async function readSession(): Promise<AdminSessionResponse> {
  return requestJson<AdminSessionResponse>("/api/competition/admin/session");
}

function divisionName(division: CompetitionDivision): string {
  return DIVISIONS.find((item) => item.value === division)?.name ?? division;
}

function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
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

function scorePercent(scoreMicros: number | null): string {
  return scoreMicros === null ? "—" : `${(scoreMicros / 10_000).toFixed(2)}%`;
}

function statusLabel(status: SubmissionStatus): string {
  switch (status) {
    case "pending": return "等待评分";
    case "uploaded": return "模型已接收";
    case "evaluating": return "正在评分";
    case "scored": return "已评分";
    case "failed": return "评分失败";
    case "rejected": return "已拒绝";
  }
}

function statusClass(status: SubmissionStatus): string {
  if (status === "scored") return styles.statusSuccess;
  if (status === "failed" || status === "rejected") return styles.statusDanger;
  return styles.statusPending;
}

function normalizeOverview(payload: AdminOverviewResponse): AdminOverviewResponse {
  return {
    evaluationSets: Array.isArray(payload.evaluationSets) ? payload.evaluationSets : [],
    leaderboards: {
      primary: Array.isArray(payload.leaderboards?.primary) ? payload.leaderboards.primary : [],
      junior: Array.isArray(payload.leaderboards?.junior) ? payload.leaderboards.junior : [],
      senior: Array.isArray(payload.leaderboards?.senior) ? payload.leaderboards.senior : [],
    },
  };
}

export default function CompetitionAdmin() {
  const [sessionState, setSessionState] = useState<"loading" | "guest" | "ready">("loading");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [overview, setOverview] = useState<AdminOverviewResponse>({ evaluationSets: [], leaderboards: EMPTY_LEADERBOARDS });
  const [overviewBusy, setOverviewBusy] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [selectedDivision, setSelectedDivision] = useState<CompetitionDivision>("primary");
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [evaluationBusy, setEvaluationBusy] = useState(false);
  const [evaluationStage, setEvaluationStage] = useState<"idle" | "building" | "saving">("idle");
  const [buildProgress, setBuildProgress] = useState<EvaluationBuildProgress | null>(null);
  const [evaluationAnnouncement, setEvaluationAnnouncement] = useState("");
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const evaluationAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await readSession();
        if (cancelled) return;
        if (!session.authenticated) {
          setSessionState("guest");
          return;
        }
        try {
          const payload = normalizeOverview(await requestJson<AdminOverviewResponse>("/api/competition/admin/overview"));
          if (!cancelled) setOverview(payload);
        } catch (error) {
          if (!cancelled) setOverviewError(error instanceof Error ? error.message : "无法读取比赛数据。");
        }
        if (!cancelled) setSessionState("ready");
      } catch (error) {
        if (cancelled) return;
        setAuthError(error instanceof Error ? error.message : "无法读取管理员状态。");
        setSessionState("guest");
      }
    })();
    return () => {
      cancelled = true;
      evaluationAbortRef.current?.abort();
    };
  }, []);

  const handleExpiredAdminSession = (error: unknown): boolean => {
    if (!(error instanceof ApiRequestError) || error.status !== 401) return false;
    setSessionState("guest");
    setOverview({ evaluationSets: [], leaderboards: EMPTY_LEADERBOARDS });
    setAuthError("统一管理员会话已过期，请重新登录。");
    return true;
  };

  const refreshOverview = async () => {
    if (overviewBusy) return;
    setOverviewBusy(true);
    setOverviewError(null);
    try {
      const payload = normalizeOverview(await requestJson<AdminOverviewResponse>("/api/competition/admin/overview"));
      setOverview(payload);
    } catch (error) {
      if (!handleExpiredAdminSession(error)) {
        setOverviewError(error instanceof Error ? error.message : "无法刷新比赛数据。");
      }
    } finally {
      setOverviewBusy(false);
    }
  };

  const logout = async () => {
    if (authBusy || evaluationBusy) return;
    setAuthBusy(true);
    try {
      await fetch("/api/competition/admin/logout", { method: "POST", cache: "no-store" }).catch(() => null);
      const response = await fetch("/api/v1/auth/logout", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("统一平台退出失败，请稍后重试。");
      setSessionState("guest");
      setOverview({ evaluationSets: [], leaderboards: EMPTY_LEADERBOARDS });
      setNotice(null);
      window.location.assign("/login.html");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "退出失败，请稍后重试。");
    } finally {
      setAuthBusy(false);
    }
  };

  const submitEvaluationSet = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!archiveFile || evaluationBusy) return;
    const currentEvaluationSet = overview.evaluationSets.find((item) => item.division === selectedDivision);
    const currentSubmissionCount = overview.leaderboards[selectedDivision]?.length ?? 0;
    if (currentEvaluationSet) {
      const confirmed = window.confirm(
        currentSubmissionCount > 0
          ? `确定替换${divisionName(selectedDivision)}当前测试集吗？系统将自动按新测试集重新评分 ${currentSubmissionCount} 支队伍的最后一次提交，排行榜成绩可能变化。`
          : `确定替换${divisionName(selectedDivision)}当前测试集吗？当前版本将保留用于审计。`,
      );
      if (!confirmed) return;
    }
    const controller = new AbortController();
    evaluationAbortRef.current = controller;
    setEvaluationBusy(true);
    setEvaluationStage("building");
    setBuildProgress(null);
    setEvaluationAnnouncement("开始在当前浏览器处理测试集。");
    setEvaluationError(null);
    setNotice(null);
    try {
      const evaluationSet: CompetitionEvaluationSet = await buildCompetitionEvaluationSet(archiveFile, selectedDivision, {
        signal: controller.signal,
        onProgress: setBuildProgress,
      });
      setEvaluationStage("saving");
      setEvaluationAnnouncement("图片特征提取完成，正在保存测试集并重新评分已有提交。");
      const payload = await requestJson<EvaluationSetResponse>("/api/competition/admin/evaluation-set", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evaluationSet }),
        signal: controller.signal,
      });
      setOverview((current) => ({
        ...current,
        evaluationSets: [
          ...current.evaluationSets.filter((item) => item.division !== payload.evaluationSet.division),
          payload.evaluationSet,
        ],
      }));
      setArchiveFile(null);
      if (archiveInputRef.current) archiveInputRef.current.value = "";
      const queued = payload.rescoreQueuedCount ?? payload.rescoredSubmissionCount;
      const deferred = payload.rescoreDeferredCount ?? payload.rescoreFailedCount;
      const deferredCopy = deferred > 0
        ? `；${deferred} 支队伍将在队列空闲后自动重试`
        : "";
      setNotice(`${divisionName(selectedDivision)}测试集已更新，共 ${payload.evaluationSet.sampleCount} 张图片；已安排后台重新评分 ${queued} 支队伍${deferredCopy}。`);
      if (deferred > 0) {
        setEvaluationError("部分队伍正在等待评测队列空闲，稍后刷新即可查看进度。 ");
      }
      setEvaluationAnnouncement(deferred > 0 ? "测试集已更新，部分队伍等待后台评分。" : "测试集已更新，后台重新评分已开始。");
      await refreshOverview();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setNotice("已停止处理测试集。");
        setEvaluationAnnouncement("已停止处理测试集。");
      } else if (handleExpiredAdminSession(error)) {
        setEvaluationAnnouncement("管理员登录已过期。");
      } else {
        setEvaluationError(error instanceof Error ? `${error.message} 请刷新数据确认当前测试集版本。` : "测试集处理失败，请刷新数据确认当前版本。");
        setEvaluationAnnouncement("测试集处理未完成，请刷新数据确认当前版本。");
        await refreshOverview();
      }
    } finally {
      if (evaluationAbortRef.current === controller) evaluationAbortRef.current = null;
      setEvaluationBusy(false);
      setEvaluationStage("idle");
    }
  };

  const selectedEvaluationSet = overview.evaluationSets.find((item) => item.division === selectedDivision) ?? null;
  const selectedEvaluationReady = selectedEvaluationSet !== null
    && hasOrangeCompetitionLabels(selectedEvaluationSet.labels);
  const selectedLeaderboard = overview.leaderboards[selectedDivision] ?? [];
  const buildPercent = buildProgress && buildProgress.total > 0
    ? Math.round((buildProgress.completed / buildProgress.total) * 100)
    : 0;

  return (
    <main className={`${styles.portal} ${styles.adminPortal}`}>
      <header className={styles.siteHeader}>
        <a className={styles.brand} href="/admin.html" aria-label="返回统一竞赛后台">
          <span className={`${styles.brandMark} ${styles.adminBrandMark}`} aria-hidden="true"><ShieldCheck size={20} /></span>
          <span>竞赛管理台</span>
        </a>
        <nav className={styles.headerActions} aria-label="页面导航">
          <a className={styles.textLink} href="/admin.html"><ArrowLeft size={16} />返回统一后台</a>
          <Link className={styles.textLink} href="/workshop/competition">查看识物提交端</Link>
          {sessionState === "ready" && <button className={styles.headerButton} type="button" disabled={authBusy || evaluationBusy} onClick={() => void logout()}><LogOut size={16} />安全退出</button>}
        </nav>
      </header>

      {sessionState === "loading" ? (
        <section className={styles.centerState} aria-live="polite" aria-busy="true">
          <RefreshCw className={styles.spin} size={28} aria-hidden="true" />
          <h1>正在验证管理员会话</h1>
          <p>验证完成后会自动进入管理台。</p>
        </section>
      ) : sessionState === "guest" ? (
        <div className={styles.adminAuthLayout}>
          <section className={styles.adminIntro}>
            <span className={styles.kicker}><ShieldCheck size={16} />仅限赛事管理员</span>
            <h1>需要统一平台管理员权限</h1>
            <p>识物工坊不再单独设置管理员密码。请从统一后台登录后进入本页面。</p>
            <div className={styles.securityNote}><Database size={20} /><span><strong>测试集安全处理</strong><small>测试集对选手保密；ZIP 图片仅在当前浏览器提取 MobileNet 特征，服务器不会接收原始图片。</small></span></div>
          </section>
          <section className={styles.authCard} aria-labelledby="admin-auth-title">
            <div className={styles.formHeading}>
              <span className={styles.cardIcon}><ShieldCheck size={22} /></span>
              <div><h2 id="admin-auth-title">统一管理员登录</h2><p>登录成功后，统一平台会把管理员身份安全传给识物工坊。</p></div>
            </div>
            {authError && <p className={styles.errorBox} role="alert">{authError}</p>}
            <a className={styles.primaryButton} href="/login.html">前往统一登录</a>
            <a className={styles.textLink} href="/admin.html"><ArrowLeft size={16} />返回统一后台</a>
          </section>
        </div>
      ) : (
        <div className={styles.adminDashboard}>
          <section className={styles.dashboardHero}>
            <div>
              <span className={styles.kicker}><ShieldCheck size={16} />赛事控制中心</span>
              <h1>橙子识别测试集与排行榜</h1>
              <p>按组别更新“橙子 / 非橙子”测试集，并查看每支队伍最后一次提交的评分。</p>
            </div>
            <button className={styles.secondaryButton} type="button" disabled={overviewBusy} onClick={() => void refreshOverview()}><RefreshCw className={overviewBusy ? styles.spin : ""} size={16} />刷新数据</button>
          </section>

          {notice && <p className={styles.notice} role="status" aria-live="polite">{notice}</p>}
          {overviewError && <p className={styles.errorBox} role="alert">{overviewError}</p>}

          <div className={styles.adminSummary} aria-label="比赛概览">
            <article><span><Layers3 size={20} /></span><div><strong>{overview.evaluationSets.length} / 3</strong><small>已配置测试集</small></div></article>
            <article><span><Users size={20} /></span><div><strong>{Object.values(overview.leaderboards).reduce((total, rows) => total + rows.length, 0)}</strong><small>已有提交队伍</small></div></article>
            <article><span><Trophy size={20} /></span><div><strong>{Object.values(overview.leaderboards).flat().filter((row) => row.status === "scored").length}</strong><small>已完成评分</small></div></article>
          </div>

          <section className={`${styles.card} ${styles.scoringRulesCard}`} aria-labelledby="scoring-rules-title">
            <div className={styles.cardHeading}>
              <span className={styles.cardIcon}><Trophy size={22} /></span>
              <div><h2 id="scoring-rules-title">评分规则</h2><p>以下规则由后台评分程序直接执行。</p></div>
            </div>
            <ol className={styles.scoringRules}>
              <li><strong>成绩公式</strong><span>成绩＝（橙子识别正确率＋非橙子排除正确率）÷ 2 × 100%。两类图片数量不同时也各占总成绩的一半。</span></li>
              <li><strong>预测方式</strong><span>每张图片取输出值最高的类别；训练台设置的置信度和“无法判断”阈值不参与比赛评分。</span></li>
              <li><strong>类别要求</strong><span>模型和测试集必须且只能包含“橙子”和“非橙子”两个类别；类别顺序可以不同。</span></li>
              <li><strong>最后提交</strong><span>每队只取最后一次提交。后提交的无效模型也会替代上一份，并按 0 分记录。</span></li>
              <li><strong>同分排序</strong><span>有效提交先按成绩从高到低；同分时提交较早者优先，再按队伍名称排序。</span></li>
              <li><strong>替换测试集</strong><span>管理员确认替换后，系统自动用新版本重新评分各队最后一次提交，避免新旧版本成绩混排。</span></li>
            </ol>
          </section>

          <div className={styles.divisionTabs} role="tablist" aria-label="选择查看的组别">
            {DIVISIONS.map((item) => (
              <button key={item.value} id={`division-tab-${item.value}`} type="button" role="tab" aria-selected={selectedDivision === item.value} aria-controls="division-panel" className={selectedDivision === item.value ? styles.activeDivisionTab : ""} disabled={evaluationBusy} onClick={() => { setSelectedDivision(item.value); setArchiveFile(null); if (archiveInputRef.current) archiveInputRef.current.value = ""; setEvaluationError(null); }}>
                <strong>{item.name}</strong><small>{overview.leaderboards[item.value]?.length ?? 0} 支队伍</small>
              </button>
            ))}
          </div>

          <div id="division-panel" className={styles.adminGrid} role="tabpanel" aria-labelledby={`division-tab-${selectedDivision}`}>
            <section className={styles.card} aria-labelledby="evaluation-upload-title">
              <div className={styles.cardHeading}>
                <span className={styles.cardIcon}><Database size={22} /></span>
                <div><h2 id="evaluation-upload-title">{divisionName(selectedDivision)}测试集</h2><p>{selectedEvaluationSet ? "上传后可替换当前版本，并自动重新评分本组最后提交。" : "上传包含“橙子”和“非橙子”的 ZIP，创建本组测试集。"}</p></div>
              </div>

              {selectedEvaluationSet ? (
                <div className={styles.evaluationSummary}>
                  <div><CheckCircle2 size={20} /><span><strong>版本 {selectedEvaluationSet.version}</strong><small>更新于 {formatDate(selectedEvaluationSet.updatedAt)}</small></span></div>
                  <dl>
                    <div><dt>图片</dt><dd>{selectedEvaluationSet.sampleCount} 张</dd></div>
                    <div><dt>类别</dt><dd>{selectedEvaluationSet.labels.length} 个</dd></div>
                  </dl>
                  <div className={styles.labelList} aria-label="测试集类别">
                    {selectedEvaluationSet.labels.map((label) => <span key={label}>{label}</span>)}
                  </div>
                </div>
              ) : (
                <div className={styles.warningBox}><AlertTriangle size={19} /><span><strong>本组尚未配置测试集</strong><small>配置完成前，本组队伍无法提交模型进行评分。</small></span></div>
              )}

              {selectedEvaluationSet && !selectedEvaluationReady && <div className={styles.warningBox}><AlertTriangle size={19} /><span><strong>当前测试集不符合橙子比赛规则</strong><small>请重新上传只包含“橙子”和“非橙子”两个类别的测试集；更新前本组选手无法提交。</small></span></div>}

              {selectedEvaluationSet && selectedLeaderboard.length > 0 && <div className={styles.warningBox}><AlertTriangle size={19} /><span><strong>替换后会自动重新评分</strong><small>当前有 {selectedLeaderboard.length} 支队伍进入榜单。确认替换后，系统会用新测试集重新评分各队最后一次提交。</small></span></div>}

              <form className={styles.uploadForm} onSubmit={submitEvaluationSet} aria-busy={evaluationBusy}>
                <label className={`${styles.fileDrop} ${archiveFile ? styles.fileSelected : ""}`}>
                  <input ref={archiveInputRef} type="file" required accept=".zip,application/zip" disabled={evaluationBusy} onChange={(event) => { setArchiveFile(event.target.files?.[0] ?? null); setEvaluationError(null); }} />
                  <FileArchive size={30} aria-hidden="true" />
                  {archiveFile ? <span><strong>{archiveFile.name}</strong><small>{formatFileSize(archiveFile.size)} · 点击可重新选择</small></span> : <span><strong>选择测试集 ZIP</strong><small>必须包含“橙子”和“非橙子”两个类别</small></span>}
                </label>

                {evaluationBusy && (
                  <div className={styles.buildProgress}>
                    <div><strong>{evaluationStage === "saving" ? "正在保存测试集并重新评分" : "正在提取图片特征"}</strong><span>{evaluationStage === "saving" ? "请勿关闭页面" : `${buildPercent}%`}</span></div>
                    <progress max={100} value={evaluationStage === "saving" ? 100 : buildPercent} aria-label={evaluationStage === "saving" ? "正在保存测试集并重新评分" : "测试集处理进度"} />
                    {evaluationStage === "building" && buildProgress?.fileName && <small title={buildProgress.fileName}>正在处理：{buildProgress.label} / {buildProgress.fileName}</small>}
                  </div>
                )}
                <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">{evaluationAnnouncement}</span>

                <p className={styles.helperText}>可直接选择类别正确的识物项目备份；普通 ZIP 中请建立“橙子”和“非橙子”两个文件夹。支持 JPG、PNG、WebP，最多 600 张图片，ZIP 不超过 100 MiB。原始图片不会上传。</p>
                {evaluationError && <p className={styles.errorBox} role="alert">{evaluationError}</p>}
                <div className={styles.formActions}>
                  {evaluationBusy && evaluationStage === "building" && <button className={styles.cancelButton} type="button" onClick={() => evaluationAbortRef.current?.abort()}><X size={17} />停止处理</button>}
                  <button className={styles.primaryButton} type="submit" disabled={!archiveFile || evaluationBusy}>
                    {evaluationBusy ? <><RefreshCw className={styles.spin} size={18} />{evaluationStage === "saving" ? "正在保存并评分" : "正在处理"}</> : <><UploadCloud size={18} />{selectedEvaluationSet ? "替换当前测试集" : "生成并保存测试集"}</>}
                  </button>
                </div>
              </form>
            </section>

            <section className={`${styles.card} ${styles.leaderboardCard}`} aria-labelledby="leaderboard-title">
              <div className={styles.cardHeading}>
                <span className={styles.cardIcon}><Trophy size={22} /></span>
                <div><h2 id="leaderboard-title">{divisionName(selectedDivision)}排行榜</h2><p>按各队最后一次提交结果展示。</p></div>
              </div>
              {selectedLeaderboard.length > 0 ? (
                <>
                  {/* 横向数据表需要成为键盘焦点，以便窄屏用户使用方向键滚动。 */}
                  {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
                  <div className={styles.tableScroller} role="region" aria-label={`${divisionName(selectedDivision)}排行榜，可横向滚动`} tabIndex={0}>
                    <table className={styles.leaderboard}>
                      <thead><tr><th scope="col">名次</th><th scope="col">队伍</th><th scope="col">均衡成绩</th><th scope="col">原始正确数</th><th scope="col">状态</th><th scope="col">测试集版本</th><th scope="col">模型</th><th scope="col">提交时间</th></tr></thead>
                      <tbody>
                        {selectedLeaderboard.map((row, index) => (
                          <tr key={row.submissionId}>
                            <td>{selectedEvaluationReady && row.status === "scored" ? index + 1 : "—"}</td>
                            <th scope="row"><strong>{row.teamName}</strong><small title={row.teamId}>{row.teamId.slice(0, 8)}</small></th>
                            <td className={styles.tableScore}>{selectedEvaluationReady && row.scoreMicros !== null ? scorePercent(row.scoreMicros) : "—"}</td>
                            <td>{selectedEvaluationReady && row.correctCount !== null && row.totalCount !== null ? `${row.correctCount} / ${row.totalCount}` : "—"}</td>
                            <td><span className={`${styles.statusPill} ${statusClass(row.status)}`}>{statusLabel(row.status)}</span>{row.errorMessage && <small className={styles.rowError}>{row.errorMessage}</small>}</td>
                            <td>{row.evaluationVersion ? `v${row.evaluationVersion}` : "—"}</td>
                            <td>
                              <span className={styles.modelFileName} title={row.modelName ?? undefined}>{row.modelName || "未命名模型"}</span>
                              <a className={styles.downloadModelLink} href={`/api/competition/admin/submissions/${row.submissionId}/model`} download>
                                <Download size={12} aria-hidden="true" />下载提交模型
                              </a>
                            </td>
                            <td><time dateTime={new Date(row.submittedAt).toISOString()}>{formatDate(row.submittedAt)}</time></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className={styles.emptyState}><Users size={30} /><strong>本组还没有提交</strong><p>参赛队伍提交模型后会出现在这里。</p></div>
              )}
            </section>
          </div>
        </div>
      )}

      <footer className={styles.footer}><span>识物工坊竞赛管理台</span><span>替换测试集会自动重新评分各队最后一次提交，请核对组别与类别后操作。</span></footer>
    </main>
  );
}
