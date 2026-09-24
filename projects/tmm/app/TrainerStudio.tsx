"use client";

import {
  AlertTriangle,
  Archive,
  BrainCircuit,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  Eye,
  FileArchive,
  FolderOpen,
  Gauge,
  FolderInput,
  ImagePlus,
  Images,
  LoaderCircle,
  LockKeyhole,
  PackageOpen,
  Play,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  StopCircle,
  SwitchCamera,
  Trash2,
  Trophy,
  Upload,
  X,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  centerCropImage,
  createProjectDatasetSignature,
  createProjectDatasetSignatureForVersion,
  createImageClassifier,
  deleteProjectClassifierModel,
  IMAGE_INPUT_SIZE,
  loadProjectClassifierModel,
  saveProjectClassifierModel,
  upgradeProjectClassifierModelDatasetSignature,
  type ClassPrediction,
  type TeachableImageClassifier,
  type TrainingProgress,
  type ValidationMetrics,
  type ValidationStatus,
} from "@/lib/ml";
import {
  hasOrangeCompetitionLabels,
  ORANGE_COMPETITION_LABELS,
  requireOrangeCompetitionLabels,
} from "@/lib/competition/rules";
import { migrateLegacyOrangeCompetitionProject } from "@/lib/competition/project-migration";
import { downloadBlob } from "@/lib/project/download";
import {
  analyzeProjectDataHealth,
  type DataHealthIssue,
  type ProjectDataHealth,
} from "@/lib/project/data-health";
import { resizeImageFile } from "@/lib/project/image";
import {
  deleteStoredProjectAndModel,
  listStoredProjects,
  loadStoredProject,
  loadStoredProjectById,
  setLastOpenedProjectId,
  saveStoredProject,
  type StoredProjectSummary,
} from "@/lib/project/storage";
import {
  createClassifierMetadata,
  createProject,
  createProjectClass,
  createProjectSample,
  DEFAULT_PREDICTION_SETTINGS,
  type Project,
  type ProjectSample,
  type PredictionSettings,
} from "@/lib/project/types";

const CLASS_COLORS = ["#3157D5", "#F47A5A", "#218C74", "#8C5BD5", "#D9A21B", "#467890"];
const MIN_SAMPLES = 5;
const RECOMMENDED_SAMPLES = 20;
const SAMPLE_MANAGER_PAGE_SIZE = 48;
const GUIDED_CAPTURE_TARGET = 12;
const LIVE_PREDICTION_WINDOW = 5;

const SSR_PROJECT: Project = {
  format: "tm-object-project",
  formatVersion: 1,
  id: "project-initial",
  name: "橙子识别项目",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  training: { epochs: 20, batchSize: 16, learningRate: 0.001 },
  classes: [
    { id: "class-a", name: ORANGE_COMPETITION_LABELS[0], color: CLASS_COLORS[0], samples: [] },
    { id: "class-b", name: ORANGE_COMPETITION_LABELS[1], color: CLASS_COLORS[1], samples: [] },
  ],
};

type SaveState = "loading" | "saving" | "saved" | "error";
type TrainState = "idle" | "running" | "complete" | "stopped" | "error";
type TestSource = "image" | "camera";
type CameraMode = { type: "collect"; classId: string } | { type: "test" };
type Notice = { tone: "success" | "warning" | "error" | "info"; message: string };
type TrainingMetrics = { accuracy?: number; validationAccuracy?: number };
type ModelStorageState = "none" | "loading" | "saving" | "saved" | "restored" | "error";
type WorkspaceTask =
  | "restoring"
  | "importing-project"
  | "importing-model"
  | "switching-project"
  | "deleting-project"
  | "idle";
type ModelOrigin = "project" | "external" | null;
type DataHealthState = "idle" | "checking" | "ready" | "error";
type ProjectChannelEvent = {
  sourceId: string;
  type: "saved" | "deleted";
  projectId: string;
  updatedAt?: string;
};

type PredictionDecision = {
  label: string;
  probability: number;
  uncertain: boolean;
  margin: number;
  reason: "low-confidence" | "small-margin" | null;
};

function freshProject(): Project {
  return createProject("橙子识别项目", [
    createProjectClass(ORANGE_COMPETITION_LABELS[0], CLASS_COLORS[0]),
    createProjectClass(ORANGE_COMPETITION_LABELS[1], CLASS_COLORS[1]),
  ]);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return "不到 1 秒";
  const seconds = Math.round(durationMs / 1_000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function formatProjectUpdatedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function nextProjectUpdatedAt(previous: string): string {
  const previousTime = Date.parse(previous);
  return new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
}

function saveStateLabel(state: SaveState): string {
  if (state === "loading") return "正在读取项目…";
  if (state === "saving") return "正在保存项目…";
  if (state === "saved") return "项目已保存到此设备";
  return "本地保存失败";
}

function userFacingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) return "操作已停止。";
  if (/memory|allocation|texture/i.test(message)) return "设备内存不足，请减少图片数量或关闭其他标签页后重试。";
  if (/webgl|backend/i.test(message)) return "当前浏览器无法启动模型训练，请更新浏览器并确认已开启硬件加速。";
  if (/network|fetch|load|tfhub/i.test(message)) return "基础模型加载失败，请检查网络连接后重试。首次训练需要下载约 8 MB 的基础模型。";
  return message || "发生了意外问题，请重试。";
}

function progressToPercent(progress: TrainingProgress | null): number {
  if (!progress) return 0;
  if (progress.phase === "loading") return Math.round(progress.fraction * 8);
  if (progress.phase === "extracting") return Math.round(8 + progress.fraction * 37);
  if (progress.phase === "training") return Math.round(45 + progress.fraction * 55);
  return 100;
}

function progressLabel(progress: TrainingProgress | null, epochs: number): string {
  if (!progress) return "正在准备模型…";
  if (progress.phase === "loading") return "正在加载视觉基础模型…";
  if (progress.phase === "extracting") return `正在分析样本 ${progress.completed} / ${progress.total}`;
  if (progress.phase === "training") return `正在训练第 ${progress.epoch ?? progress.completed} / ${epochs} 轮`;
  return "正在整理训练结果…";
}

function lastHistoryMetric(
  history: Record<string, number[]>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const values = history[key];
    const value = values?.[values.length - 1];
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function stopMediaStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null): void {
  if (event.key !== "Tab" || !dialog) return;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
  ));
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function captureVideoSquare(video: HTMLVideoElement): string {
  return centerCropImage(video).toDataURL("image/jpeg", 0.86);
}

function makeCameraSample(
  dataUrl: string,
  index: number,
  captureGroupId: string,
): ProjectSample {
  return createProjectSample({
    name: `摄像头样本-${String(index).padStart(3, "0")}.jpg`,
    dataUrl,
    source: "camera",
    size: IMAGE_INPUT_SIZE,
    captureGroupId,
  });
}

function makeCaptureGroupId(): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  return `capture-${suffix}`;
}

function averagePredictionFrames(
  frames: readonly ClassPrediction[][],
): ClassPrediction[] {
  if (frames.length === 0) return [];
  const totals = new Map<string, number>();
  for (const frame of frames) {
    for (const prediction of frame) {
      totals.set(prediction.label, (totals.get(prediction.label) ?? 0) + prediction.probability);
    }
  }
  return Array.from(totals, ([label, total]) => ({
    label,
    probability: total / frames.length,
  })).sort((left, right) => right.probability - left.probability);
}

function decidePrediction(
  predictions: readonly ClassPrediction[],
  settings: PredictionSettings,
): PredictionDecision | null {
  const first = predictions[0];
  if (!first) return null;
  const margin = first.probability - (predictions[1]?.probability ?? 0);
  const reason = first.probability < settings.confidenceThreshold
    ? "low-confidence"
    : margin < settings.marginThreshold
      ? "small-margin"
      : null;
  return {
    label: first.label,
    probability: first.probability,
    margin,
    uncertain: reason !== null,
    reason,
  };
}

function predictionReasonLabel(
  decision: PredictionDecision,
  settings: PredictionSettings,
): string | null {
  if (decision.reason === "low-confidence") {
    return `最高置信度未达到 ${Math.round(settings.confidenceThreshold * 100)}%`;
  }
  if (decision.reason === "small-margin") {
    return `前两类差距小于 ${Math.round(settings.marginThreshold * 100)}%`;
  }
  return null;
}

function PredictionRows({
  predictions,
  colorFor,
  emptyMessage,
  emptyClassName = "prediction-empty",
}: {
  predictions: readonly ClassPrediction[];
  colorFor: (label: string, index: number) => string;
  emptyMessage: string;
  emptyClassName?: string;
}) {
  if (predictions.length === 0) {
    return <p className={emptyClassName}>{emptyMessage}</p>;
  }
  return predictions.map((prediction, index) => (
    <div className="prediction-row" key={prediction.label}>
      <div><span><i style={{ background: colorFor(prediction.label, index) }} />{prediction.label}</span><strong>{Math.round(prediction.probability * 100)}%</strong></div>
      <span className="confidence-track"><span style={{ width: `${prediction.probability * 100}%`, background: colorFor(prediction.label, index) }} /></span>
    </div>
  ));
}

function projectTrainingExamples(project: Project) {
  return project.classes.flatMap((projectClass) => {
    const parent = new Map<string, string>();
    const find = (groupId: string): string => {
      const currentParent = parent.get(groupId) ?? groupId;
      if (currentParent === groupId) return groupId;
      const root = find(currentParent);
      parent.set(groupId, root);
      return root;
    };
    const union = (left: string, right: string) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
    };
    const baseGroups = projectClass.samples.map((sample) => {
      if (sample.captureGroupId) return sample.captureGroupId;
      if (sample.source === "camera") {
        // Older backups did not record burst ids. Keep all legacy camera frames
        // in one conservative group rather than risk near-duplicate leakage.
        return `legacy-camera-${projectClass.id}`;
      }
      return `image-${sample.id}`;
    });
    const firstGroupByImage = new Map<string, string>();
    projectClass.samples.forEach((sample, index) => {
      const baseGroup = baseGroups[index];
      parent.set(baseGroup, parent.get(baseGroup) ?? baseGroup);
      const matchingGroup = firstGroupByImage.get(sample.dataUrl);
      if (matchingGroup) union(matchingGroup, baseGroup);
      else firstGroupByImage.set(sample.dataUrl, baseGroup);
    });
    return projectClass.samples.map((sample, index) => {
      return {
        image: sample.dataUrl,
        label: projectClass.name.trim(),
        groupId: find(baseGroups[index]),
      };
    });
  });
}

export default function TrainerStudio() {
  const [project, setProject] = useState<Project>(SSR_PROJECT);
  const [hydrated, setHydrated] = useState(false);
  const [projectPersistenceEnabled, setProjectPersistenceEnabled] = useState(true);
  const [externalProjectConflict, setExternalProjectConflict] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [persistedProjectUpdatedAt, setPersistedProjectUpdatedAt] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState(1);
  const [uploadClassId, setUploadClassId] = useState<string | null>(null);
  const [processingClassId, setProcessingClassId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [trainingState, setTrainingState] = useState<TrainState>("idle");
  const [trainingProgress, setTrainingProgress] = useState<TrainingProgress | null>(null);
  const [trainingDuration, setTrainingDuration] = useState<number | null>(null);
  const [trainingMetrics, setTrainingMetrics] = useState<TrainingMetrics | null>(null);
  const [validationMetrics, setValidationMetrics] = useState<ValidationMetrics | null>(null);
  const [validationStatus, setValidationStatus] = useState<ValidationStatus | null>(null);
  const [modelStale, setModelStale] = useState(false);
  const [modelLabels, setModelLabels] = useState<string[]>([]);
  const [modelStorageState, setModelStorageState] = useState<ModelStorageState>("loading");
  const [modelOrigin, setModelOrigin] = useState<ModelOrigin>(null);
  const [externalPredictionSettings, setExternalPredictionSettings] = useState<PredictionSettings | null>(null);
  const [workspaceTask, setWorkspaceTask] = useState<WorkspaceTask>("restoring");
  const [testSource, setTestSource] = useState<TestSource>("image");
  const [testImage, setTestImage] = useState<string | null>(null);
  const [predictions, setPredictions] = useState<ClassPrediction[]>([]);
  const [livePredictionAnnouncement, setLivePredictionAnnouncement] = useState<string | null>(null);
  const [predicting, setPredicting] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [continuousCapture, setContinuousCapture] = useState(false);
  const [captureCountdown, setCaptureCountdown] = useState<number | null>(null);
  const [cameraCapturedCount, setCameraCapturedCount] = useState(0);
  const [cameraFacingMode, setCameraFacingMode] = useState<"environment" | "user">("environment");
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [storedProjects, setStoredProjects] = useState<StoredProjectSummary[]>([]);
  const [projectCatalogLoading, setProjectCatalogLoading] = useState(false);
  const [projectCatalogError, setProjectCatalogError] = useState<string | null>(null);
  const [dataHealth, setDataHealth] = useState<ProjectDataHealth | null>(null);
  const [dataHealthState, setDataHealthState] = useState<DataHealthState>("idle");
  const [dataHealthRefresh, setDataHealthRefresh] = useState(0);
  const [healthIssuesExpanded, setHealthIssuesExpanded] = useState(false);
  const [sampleManagerClassId, setSampleManagerClassId] = useState<string | null>(null);
  const [selectedSampleIds, setSelectedSampleIds] = useState<Set<string>>(() => new Set());
  const [sampleManagerPage, setSampleManagerPage] = useState(0);

  const uploadInputRef = useRef<HTMLInputElement>(null);
  const projectImportRef = useRef<HTMLInputElement>(null);
  const modelImportRef = useRef<HTMLInputElement>(null);
  const testInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sampleManagerDialogRef = useRef<HTMLElement>(null);
  const sampleManagerCloseRef = useRef<HTMLButtonElement>(null);
  const sampleManagerTriggerRef = useRef<HTMLElement | null>(null);
  const cameraDialogRef = useRef<HTMLElement>(null);
  const cameraCloseRef = useRef<HTMLButtonElement>(null);
  const cameraTriggerRef = useRef<HTMLElement | null>(null);
  const projectManagerDialogRef = useRef<HTMLElement>(null);
  const projectManagerCloseRef = useRef<HTMLButtonElement>(null);
  const projectManagerTriggerRef = useRef<HTMLElement | null>(null);
  const classifierRef = useRef<TeachableImageClassifier | null>(null);
  const trainingAbortRef = useRef<AbortController | null>(null);
  const livePredictionBusyRef = useRef(false);
  const livePredictionAbortRef = useRef<AbortController | null>(null);
  const livePredictionGenerationRef = useRef(0);
  const livePredictionFramesRef = useRef<ClassPrediction[][]>([]);
  const inputPredictionAbortRef = useRef<AbortController | null>(null);
  const inputPredictionGenerationRef = useRef(0);
  const cameraSampleIndexRef = useRef(0);
  const cameraCapturedCountRef = useRef(0);
  const captureGroupIdRef = useRef(makeCaptureGroupId());
  const workspaceGenerationRef = useRef(0);
  const projectSaveGenerationRef = useRef(0);
  const projectSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const persistedProjectUpdatedAtRef = useRef(new Map<string, string>());
  const intentionalNavigationRef = useRef(false);
  const externalProjectConflictRef = useRef(false);
  const projectChannelRef = useRef<BroadcastChannel | null>(null);
  const tabIdRef = useRef(makeCaptureGroupId());
  const projectRef = useRef<Project>(SSR_PROJECT);
  const workspaceBusyRef = useRef(true);
  const imageProcessingRef = useRef(false);

  const totalSamples = useMemo(
    () => project.classes.reduce((total, item) => total + item.samples.length, 0),
    [project.classes],
  );
  const healthDatasetKey = useMemo(
    () => project.classes.map((projectClass) => [
      projectClass.id,
      projectClass.name,
      ...projectClass.samples.map((sample) => `${sample.id}:${sample.createdAt}:${sample.dataUrl.length}`),
    ].join("|")).join("||"),
    [project.classes],
  );
  const managedClass = useMemo(
    () => project.classes.find((item) => item.id === sampleManagerClassId) ?? null,
    [project.classes, sampleManagerClassId],
  );
  const managedPageCount = Math.max(
    1,
    Math.ceil((managedClass?.samples.length ?? 0) / SAMPLE_MANAGER_PAGE_SIZE),
  );
  const managedPageIndex = Math.min(sampleManagerPage, managedPageCount - 1);
  const managedPageSamples = managedClass?.samples.slice(
    managedPageIndex * SAMPLE_MANAGER_PAGE_SIZE,
    (managedPageIndex + 1) * SAMPLE_MANAGER_PAGE_SIZE,
  ) ?? [];
  const allManagedSamplesSelected = Boolean(
    managedClass?.samples.length &&
    managedClass.samples.every((sample) => selectedSampleIds.has(sample.id)),
  );
  const competitionProjectReady = hasOrangeCompetitionLabels(
    project.classes.map(({ name }) => name),
  );
  const readinessProblems = useMemo(() => {
    const problems: string[] = [];
    if (!competitionProjectReady) problems.push("比赛项目必须使用固定的“橙子”和“非橙子”两个类别");
    project.classes.forEach((item) => {
      if (item.samples.length < MIN_SAMPLES) {
        problems.push(`为“${item.name || "未命名类别"}”再添加 ${MIN_SAMPLES - item.samples.length} 张图片`);
      }
    });
    if (!Number.isInteger(project.training.epochs) || project.training.epochs < 5 || project.training.epochs > 100) {
      problems.push("训练轮次需为 5–100 的整数");
    }
    return problems;
  }, [competitionProjectReady, project.classes, project.training.epochs]);
  const workspaceBusy = !hydrated || workspaceTask !== "idle" || trainingState === "running";
  const projectDirty = hydrated && (
    persistedProjectUpdatedAt !== project.updatedAt
  );
  const dataHealthReadyForTraining = dataHealthState === "ready" && dataHealth !== null;
  const blockingDataHealthIssue = dataHealthState === "ready"
    ? dataHealth?.issues.find((issue) => issue.severity === "error") ?? null
    : null;
  const canTrain =
    readinessProblems.length === 0 &&
    dataHealthReadyForTraining &&
    blockingDataHealthIssue === null &&
    !externalProjectConflict &&
    !workspaceBusy &&
    processingClassId === null &&
    cameraMode === null &&
    sampleManagerClassId === null;
  const trainingBlockMessage = blockingDataHealthIssue?.message
    ?? readinessProblems[0]
    ?? (externalProjectConflict
      ? "项目已在另一个标签页中变化，请重新载入或先导出本页备份。"
      : null)
    ?? (dataHealthState === "error"
      ? "数据健康检查失败，请点击“重新检查”。"
      : !dataHealthReadyForTraining
        ? "正在完成数据健康检查，请稍候。"
        : "请关闭当前弹窗后再训练。");
  const hasModel = modelLabels.length >= 2;
  const competitionModelReady = hasOrangeCompetitionLabels(modelLabels);
  const percent = progressToPercent(trainingProgress);
  const predictionSettings = modelOrigin === "external" && externalPredictionSettings
    ? externalPredictionSettings
    : project.prediction ?? DEFAULT_PREDICTION_SETTINGS;
  const predictionDecision = useMemo(
    () => decidePrediction(predictions, predictionSettings),
    [predictions, predictionSettings],
  );
  const predictionReason = predictionDecision
    ? predictionReasonLabel(predictionDecision, predictionSettings)
    : null;
  const predictionAnnouncementKey = cameraMode?.type === "test" && predictionDecision
    ? predictionDecision.uncertain
      ? `uncertain:${predictionDecision.reason ?? "unknown"}`
      : `label:${predictionDecision.label}`
    : null;
  const predictionAnnouncementText = predictionAnnouncementKey && predictionDecision
    ? predictionDecision.uncertain
      ? `当前无法判断。${predictionReason ?? "结果还不够明确"}`
      : `当前识别为${predictionDecision.label}`
    : null;
  const mostConfusedPair = useMemo(() => {
    if (!validationMetrics) return null;
    let best: { actual: string; predicted: string; count: number } | null = null;
    for (let rowIndex = 0; rowIndex < validationMetrics.confusionMatrix.length; rowIndex += 1) {
      const row = validationMetrics.confusionMatrix[rowIndex];
      for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
        const count = row[columnIndex];
        if (rowIndex === columnIndex || count <= (best?.count ?? 0)) continue;
        best = {
          actual: validationMetrics.perClass[rowIndex]?.label ?? `类别 ${rowIndex + 1}`,
          predicted: validationMetrics.perClass[columnIndex]?.label ?? `类别 ${columnIndex + 1}`,
          count,
        };
      }
    }
    return best;
  }, [validationMetrics]);
  useEffect(() => {
    if (!predictionAnnouncementKey || !predictionAnnouncementText) return;
    const timer = window.setTimeout(() => {
      setLivePredictionAnnouncement(predictionAnnouncementText);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [predictionAnnouncementKey, predictionAnnouncementText]);
  const captureGuidance = cameraCapturedCount < 4
    ? "先拍正面，并让物品占据中央方框"
    : cameraCapturedCount < 8
      ? "轻轻转动物品，补充侧面和俯视角度"
      : "改变距离、光线或背景，补充真实使用场景";
  const dataHealthErrorCount = dataHealth?.issues.filter((issue) => issue.severity === "error").length ?? 0;
  const dataHealthWarningCount = dataHealth?.issues.filter((issue) => issue.severity === "warning").length ?? 0;
  const classHealthIssueCounts = useMemo(() => new Map(
    dataHealth?.classes.map((classHealth) => [classHealth.classId, classHealth.issues.length]) ?? [],
  ), [dataHealth]);

  const notify = useCallback((tone: Notice["tone"], message: string) => {
    setNotice({ tone, message });
  }, []);

  const cancelLivePrediction = useCallback(() => {
    livePredictionAbortRef.current?.abort();
    livePredictionAbortRef.current = null;
    livePredictionGenerationRef.current += 1;
    livePredictionBusyRef.current = false;
    livePredictionFramesRef.current = [];
  }, []);

  const cancelInputPrediction = useCallback(() => {
    inputPredictionAbortRef.current?.abort();
    inputPredictionAbortRef.current = null;
    inputPredictionGenerationRef.current += 1;
    setPredicting(false);
  }, []);

  const refreshProjectCatalog = useCallback(async (showLoading = false) => {
    if (showLoading) setProjectCatalogLoading(true);
    setProjectCatalogError(null);
    try {
      setStoredProjects(await listStoredProjects());
    } catch {
      setProjectCatalogError("无法读取设备上的项目列表。");
      if (showLoading) notify("error", "无法读取设备上的项目列表，请稍后重试。");
    } finally {
      if (showLoading) setProjectCatalogLoading(false);
    }
  }, [notify]);

  const broadcastProjectEvent = useCallback((event: Omit<ProjectChannelEvent, "sourceId">) => {
    projectChannelRef.current?.postMessage({
      ...event,
      sourceId: tabIdRef.current,
    } satisfies ProjectChannelEvent);
  }, []);

  const saveProjectWithLock = useCallback(async (
    projectSnapshot: Project,
    makeLastOpened: boolean,
    saveGeneration: number,
  ): Promise<void> => {
    const save = async () => {
      if (saveGeneration !== projectSaveGenerationRef.current) return;
      if (
        externalProjectConflictRef.current &&
        projectSnapshot.id === projectRef.current.id
      ) {
        throw new Error("项目已在另一个标签页中更新，请重新载入后再保存。");
      }
      const expectedUpdatedAt = persistedProjectUpdatedAtRef.current.has(projectSnapshot.id)
        ? persistedProjectUpdatedAtRef.current.get(projectSnapshot.id) ?? null
        : null;
      try {
        await saveStoredProject(projectSnapshot, { makeLastOpened, expectedUpdatedAt });
      } catch (error) {
        if (
          projectSnapshot.id === projectRef.current.id &&
          error instanceof Error &&
          /其他标签页|已被删除/.test(error.message)
        ) {
          externalProjectConflictRef.current = true;
          projectSaveGenerationRef.current += 1;
          setExternalProjectConflict(true);
          setSaveState("error");
          notify("warning", "此项目已在另一个标签页中变化，当前页面已停止自动保存。请重新载入或先导出本页备份。");
        }
        throw error;
      }
      persistedProjectUpdatedAtRef.current.set(
        projectSnapshot.id,
        projectSnapshot.updatedAt,
      );
      if (projectSnapshot.id === projectRef.current.id) {
        setPersistedProjectUpdatedAt(projectSnapshot.updatedAt);
      }
      if (saveGeneration !== projectSaveGenerationRef.current) return;
      broadcastProjectEvent({
        type: "saved",
        projectId: projectSnapshot.id,
        updatedAt: projectSnapshot.updatedAt,
      });
    };

    if (typeof navigator !== "undefined" && navigator.locks) {
      await navigator.locks.request(`tm-object-project:${projectSnapshot.id}`, save);
    } else {
      await save();
    }
  }, [broadcastProjectEvent, notify]);

  const enqueueProjectSave = useCallback((
    projectSnapshot: Project,
    makeLastOpened = false,
    saveGeneration = projectSaveGenerationRef.current,
  ): Promise<void> => {
    const queued = projectSaveQueueRef.current
      .catch(() => undefined)
      .then(() => saveProjectWithLock(projectSnapshot, makeLastOpened, saveGeneration));
    projectSaveQueueRef.current = queued.catch(() => undefined);
    return queued;
  }, [saveProjectWithLock]);

  const deleteProjectWithLock = useCallback(async (projectId: string): Promise<void> => {
    const remove = () => deleteStoredProjectAndModel(projectId);
    if (typeof navigator !== "undefined" && navigator.locks) {
      await navigator.locks.request(`tm-object-project:${projectId}`, remove);
    } else {
      await remove();
    }
  }, []);

  const cancelAndWaitForProjectSaves = useCallback(async (): Promise<number> => {
    projectSaveGenerationRef.current += 1;
    await projectSaveQueueRef.current.catch(() => undefined);
    return projectSaveGenerationRef.current;
  }, []);

  const commitProject = useCallback((update: (current: Project) => Project, invalidateModel = true) => {
    if (workspaceBusyRef.current || trainingAbortRef.current) return;
    if (invalidateModel) workspaceGenerationRef.current += 1;
    const next = {
      ...update(projectRef.current),
      updatedAt: nextProjectUpdatedAt(projectRef.current.updatedAt),
    };
    projectRef.current = next;
    setProject(next);
    setSaveState("saving");
    if (invalidateModel) {
      setDataHealth(null);
      setDataHealthState("idle");
      setHealthIssuesExpanded(false);
      setValidationMetrics(null);
      setValidationStatus(null);
      if (classifierRef.current?.getState().classifierReady) setModelStale(true);
    }
  }, []);

  const persistClassifier = useCallback(async (
    projectSnapshot: Project,
    classifier: TeachableImageClassifier,
    operationId: number,
  ): Promise<boolean> => {
    if (workspaceGenerationRef.current !== operationId) return false;
    setModelStorageState("saving");
    try {
      const [bundle, datasetSignature] = await Promise.all([
        classifier.exportModel(),
        createProjectDatasetSignature(projectSnapshot),
      ]);
      if (workspaceGenerationRef.current !== operationId) return false;
      await saveProjectClassifierModel(projectSnapshot.id, bundle, datasetSignature, {
        expectedProjectUpdatedAt: projectSnapshot.updatedAt,
      });
      if (workspaceGenerationRef.current !== operationId) return false;
      setModelStorageState("saved");
      return true;
    } catch {
      if (workspaceGenerationRef.current === operationId) setModelStorageState("error");
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const operationId = workspaceGenerationRef.current;
    void (async () => {
      let stored: Project | null;
      let storageRecoveryMessage: string | null = null;
      let legacyMigrationApplied = false;
      let legacyMigrationPersisted = true;
      try {
        stored = await loadStoredProject();
        if (!stored) {
          const candidates = await listStoredProjects();
          for (const candidate of candidates) {
            try {
              stored = await loadStoredProjectById(candidate.id);
              if (stored) break;
            } catch {
              // Keep looking for another readable project without overwriting the bad record.
            }
          }
          if (stored) {
            await setLastOpenedProjectId(stored.id);
            storageRecoveryMessage = "已恢复设备中最近使用的可用项目。";
          } else if (candidates.length > 0) {
            storageRecoveryMessage = "设备中有项目记录无法读取，已创建新的空白项目；异常记录没有被覆盖。";
          }
        }
      } catch {
        try {
          const candidates = await listStoredProjects();
          stored = null;
          for (const candidate of candidates) {
            try {
              stored = await loadStoredProjectById(candidate.id);
              if (stored) break;
            } catch {
              // Keep looking for another readable project without overwriting the bad record.
            }
          }
          if (stored) {
            await setLastOpenedProjectId(stored.id);
            storageRecoveryMessage = "上次打开的项目无法读取，已恢复另一个可用项目；异常记录仍保留在设备中。";
          } else {
            storageRecoveryMessage = candidates.length > 0
              ? "设备中有项目记录无法读取，已创建新的空白项目；异常记录没有被覆盖。"
              : null;
          }
        } catch {
          if (cancelled || workspaceGenerationRef.current !== operationId) return;
          const temporaryProject = freshProject();
          projectRef.current = temporaryProject;
          setProject(temporaryProject);
          setHydrated(true);
          setProjectPersistenceEnabled(false);
          setSaveState("error");
          setModelStorageState("error");
          setWorkspaceTask("idle");
          setNotice({ tone: "error", message: "本地存储暂不可用，已进入临时模式；请及时导出项目备份，现有设备数据不会被覆盖。" });
          return;
        }
      }

      if (cancelled || workspaceGenerationRef.current !== operationId) return;
      if (stored) {
        const migrated = migrateLegacyOrangeCompetitionProject(stored);
        if (migrated) {
          legacyMigrationApplied = true;
          try {
            await saveStoredProject(migrated, {
              makeLastOpened: true,
              expectedUpdatedAt: stored.updatedAt,
            });
            await deleteProjectClassifierModel(stored.id).catch(() => undefined);
          } catch {
            legacyMigrationPersisted = false;
          }
          stored = migrated;
        }
      }
      if (cancelled || workspaceGenerationRef.current !== operationId) return;
      const restoredProject = stored ?? freshProject();
      if (!stored) {
        try {
          await saveStoredProject(restoredProject, {
            makeLastOpened: true,
            expectedUpdatedAt: null,
          });
          persistedProjectUpdatedAtRef.current.set(
            restoredProject.id,
            restoredProject.updatedAt,
          );
        } catch {
          if (cancelled || workspaceGenerationRef.current !== operationId) return;
          projectRef.current = restoredProject;
          setProject(restoredProject);
          setHydrated(true);
          setProjectPersistenceEnabled(false);
          setSaveState("error");
          setModelStorageState("error");
          setWorkspaceTask("idle");
          setNotice({ tone: "error", message: "无法保存新项目，已进入临时模式；请及时导出项目备份。" });
          return;
        }
      }
      if (cancelled || workspaceGenerationRef.current !== operationId) return;
      if (stored && legacyMigrationPersisted) {
        persistedProjectUpdatedAtRef.current.set(stored.id, stored.updatedAt);
      }
      setPersistedProjectUpdatedAt(legacyMigrationPersisted ? restoredProject.updatedAt : null);
      projectRef.current = restoredProject;
      setProject(restoredProject);
      setHydrated(true);
      setProjectPersistenceEnabled(legacyMigrationPersisted);
      setSaveState(legacyMigrationPersisted ? "saved" : "error");
      void refreshProjectCatalog();

      if (!stored) {
        setModelStorageState("none");
        setWorkspaceTask("idle");
        if (storageRecoveryMessage) {
          setNotice({ tone: "warning", message: storageRecoveryMessage });
        }
        return;
      }

      if (legacyMigrationApplied) {
        setModelStorageState("none");
        setWorkspaceTask("idle");
        setNotice({
          tone: legacyMigrationPersisted ? "success" : "warning",
          message: legacyMigrationPersisted
            ? "已把旧项目的“物品 A / 物品 B”自动更新为“橙子 / 非橙子”；请检查原有样本后重新训练。"
            : "已在当前页面改为“橙子 / 非橙子”，但无法保存到设备；请及时导出项目备份。",
        });
        return;
      }

      setModelStorageState("loading");
      try {
        const savedModel = await loadProjectClassifierModel(stored.id);
        if (cancelled || workspaceGenerationRef.current !== operationId || projectRef.current.id !== stored.id) return;
        if (!savedModel) {
          setModelStorageState("none");
          setWorkspaceTask("idle");
          setNotice({
            tone: storageRecoveryMessage ? "warning" : "success",
            message: storageRecoveryMessage ?? "已恢复上次保存在此设备上的项目。",
          });
          return;
        }
        if (!hasOrangeCompetitionLabels(savedModel.bundle.labels)) {
          await deleteProjectClassifierModel(stored.id).catch(() => undefined);
          setModelStorageState("none");
          setWorkspaceTask("idle");
          setNotice({ tone: "warning", message: "旧模型类别不符合橙子比赛要求，项目样本已保留，请重新训练。" });
          return;
        }

        const storedSignatureVersion = savedModel.datasetSignature.startsWith("dataset-v1:")
          ? 1
          : 2;
        const datasetSignature = await createProjectDatasetSignatureForVersion(
          stored,
          storedSignatureVersion,
        );
        if (cancelled || workspaceGenerationRef.current !== operationId || projectRef.current.id !== stored.id) return;
        const classifier = createImageClassifier();
        try {
          await classifier.importModel(savedModel.bundle);
        } catch (error) {
          classifier.dispose();
          throw error;
        }
        if (cancelled || workspaceGenerationRef.current !== operationId || projectRef.current.id !== stored.id) {
          classifier.dispose();
          return;
        }

        const projectLabels = stored.classes.map((item) => item.name.trim());
        const labelsMatch =
          savedModel.bundle.labels.length === projectLabels.length &&
          savedModel.bundle.labels.every((label, index) => label === projectLabels[index]);
        const stale = savedModel.datasetSignature !== datasetSignature || !labelsMatch;
        if (!stale && storedSignatureVersion === 1) {
          const upgradedSignature = await createProjectDatasetSignature(stored);
          if (
            !cancelled &&
            workspaceGenerationRef.current === operationId &&
            projectRef.current.id === stored.id
          ) {
            await upgradeProjectClassifierModelDatasetSignature(
              stored.id,
              savedModel.datasetSignature,
              savedModel.savedAt,
              upgradedSignature,
            ).catch(() => undefined);
          }
        }
        if (cancelled || workspaceGenerationRef.current !== operationId || projectRef.current.id !== stored.id) {
          classifier.dispose();
          return;
        }
        classifierRef.current?.dispose();
        classifierRef.current = classifier;
        setModelLabels(savedModel.bundle.labels);
        setModelStale(stale);
        setTrainingState("complete");
        setTrainingDuration(null);
        setTrainingMetrics(null);
        setValidationMetrics(null);
        setValidationStatus(null);
        setModelStorageState("restored");
        setModelOrigin("project");
        setExternalPredictionSettings(null);
        setWorkspaceTask("idle");
        setNotice({
          tone: stale || storageRecoveryMessage ? "warning" : "success",
          message: storageRecoveryMessage ?? (stale
            ? "已恢复项目和上次模型；样本已变化，建议重新训练。"
            : "已恢复项目和训练模型，可以直接测试。"),
        });
      } catch {
        if (cancelled || workspaceGenerationRef.current !== operationId) return;
        setModelStorageState("error");
        setWorkspaceTask("idle");
        setNotice({ tone: "warning", message: "项目已恢复，但本地模型无法载入，请重新训练。" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshProjectCatalog]);

  useEffect(() => {
    if (
      !hydrated ||
      !projectPersistenceEnabled ||
      workspaceTask !== "idle" ||
      externalProjectConflictRef.current
    ) return;
    const saveGeneration = projectSaveGenerationRef.current;
    const projectSnapshot = project;
    const timer = window.setTimeout(() => {
      void enqueueProjectSave(projectSnapshot, false, saveGeneration)
        .then(() => {
          if (
            saveGeneration !== projectSaveGenerationRef.current ||
            projectRef.current.id !== projectSnapshot.id ||
            projectRef.current.updatedAt !== projectSnapshot.updatedAt
          ) return;
          setSaveState("saved");
          void refreshProjectCatalog();
        })
        .catch(() => {
          if (saveGeneration === projectSaveGenerationRef.current) setSaveState("error");
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [
    enqueueProjectSave,
    hydrated,
    project,
    projectPersistenceEnabled,
    refreshProjectCatalog,
    workspaceTask,
  ]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("tm-object-project-events");
    projectChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (
        typeof message !== "object" ||
        message === null ||
        !("sourceId" in message) ||
        !("type" in message) ||
        !("projectId" in message)
      ) return;
      const projectEvent = message as ProjectChannelEvent;
      if (projectEvent.sourceId === tabIdRef.current) return;
      if (projectEvent.projectId !== projectRef.current.id) {
        void refreshProjectCatalog();
        return;
      }
      const sameSnapshot =
        projectEvent.type === "saved" &&
        projectEvent.updatedAt === projectRef.current.updatedAt;
      if (sameSnapshot) return;
      externalProjectConflictRef.current = true;
      projectSaveGenerationRef.current += 1;
      trainingAbortRef.current?.abort();
      setExternalProjectConflict(true);
      setSaveState("error");
      notify(
        "warning",
        projectEvent.type === "deleted"
          ? "此项目已在另一个标签页中删除。请重新载入或新建项目，当前页面不会再自动保存。"
          : "此项目已在另一个标签页中更新。当前页面已停止自动保存，避免覆盖新数据。",
      );
    };
    return () => {
      channel.close();
      if (projectChannelRef.current === channel) projectChannelRef.current = null;
    };
  }, [notify, refreshProjectCatalog]);

  useEffect(() => {
    if (!projectDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (intentionalNavigationRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [projectDirty]);

  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();
    const projectSnapshot = projectRef.current;
    const timer = window.setTimeout(() => {
      setDataHealthState("checking");
      void analyzeProjectDataHealth(projectSnapshot, {
        signal: controller.signal,
        minimumSamplesPerClass: MIN_SAMPLES,
        recommendedSamplesPerClass: RECOMMENDED_SAMPLES,
      }).then((report) => {
        if (
          controller.signal.aborted ||
          projectRef.current.id !== projectSnapshot.id
        ) return;
        setDataHealth(report);
        setDataHealthState("ready");
      }).catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
        setDataHealthState("error");
      });
    }, 900);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [dataHealthRefresh, healthDatasetKey, hydrated]);

  useEffect(() => {
    workspaceBusyRef.current = workspaceBusy;
  }, [workspaceBusy]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!sampleManagerClassId) return;
    const returnTarget = sampleManagerTriggerRef.current;
    const frame = window.requestAnimationFrame(() => sampleManagerCloseRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSampleManagerClassId(null);
        setSelectedSampleIds(new Set());
        setSampleManagerPage(0);
        return;
      }
      trapDialogFocus(event, sampleManagerDialogRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [sampleManagerClassId]);

  useEffect(() => {
    if (!projectManagerOpen) return;
    const returnTarget = projectManagerTriggerRef.current;
    const frame = window.requestAnimationFrame(() => projectManagerCloseRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setProjectManagerOpen(false);
        return;
      }
      trapDialogFocus(event, projectManagerDialogRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [projectManagerOpen]);

  useEffect(() => {
    if (!cameraMode) return;
    const returnTarget = cameraTriggerRef.current;
    const frame = window.requestAnimationFrame(() => cameraCloseRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelLivePrediction();
        setCameraMode(null);
        setCameraReady(false);
        setContinuousCapture(false);
        setCaptureCountdown(null);
        return;
      }
      trapDialogFocus(event, cameraDialogRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [cameraMode, cancelLivePrediction]);

  useEffect(() => {
    return () => {
      stopMediaStream(streamRef.current);
      trainingAbortRef.current?.abort();
      livePredictionAbortRef.current?.abort();
      inputPredictionAbortRef.current?.abort();
      classifierRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!cameraMode) return;
    let cancelled = false;
    void navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: cameraFacingMode }, width: { ideal: 960 }, height: { ideal: 720 } }, audio: false })
      .then(async (stream) => {
        if (cancelled) {
          stopMediaStream(stream);
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          if (cancelled) {
            stopMediaStream(stream);
            return;
          }
          setCameraReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) setCameraError("无法使用摄像头。请在浏览器地址栏中允许摄像头权限，或改用上传图片。");
      });
    return () => {
      cancelled = true;
      cancelLivePrediction();
      stopMediaStream(streamRef.current);
      streamRef.current = null;
      setContinuousCapture(false);
      setCaptureCountdown(null);
    };
  }, [cameraFacingMode, cameraMode, cancelLivePrediction]);

  const predictInput = useCallback(async (input: string | HTMLVideoElement) => {
    const classifier = classifierRef.current;
    if (!classifier?.getState().classifierReady) return;
    inputPredictionAbortRef.current?.abort();
    const controller = new AbortController();
    const generation = inputPredictionGenerationRef.current + 1;
    inputPredictionGenerationRef.current = generation;
    inputPredictionAbortRef.current = controller;
    setPredictions([]);
    setPredicting(true);
    try {
      const nextPredictions = await classifier.predict(input, { signal: controller.signal });
      if (
        !controller.signal.aborted &&
        inputPredictionGenerationRef.current === generation
      ) {
        setPredictions(nextPredictions);
      }
    } catch (error) {
      if (!controller.signal.aborted) notify("error", userFacingError(error));
    } finally {
      if (inputPredictionGenerationRef.current === generation) {
        inputPredictionAbortRef.current = null;
        setPredicting(false);
      }
    }
  }, [notify]);

  useEffect(() => {
    if (cameraMode?.type !== "test" || !cameraReady || !hasModel) return;
    const generation = livePredictionGenerationRef.current + 1;
    livePredictionGenerationRef.current = generation;
    livePredictionAbortRef.current?.abort();
    const controller = new AbortController();
    livePredictionAbortRef.current = controller;
    livePredictionFramesRef.current = [];
    const interval = window.setInterval(() => {
      const classifier = classifierRef.current;
      if (
        !videoRef.current ||
        !classifier?.getState().classifierReady ||
        livePredictionBusyRef.current
      ) return;
      livePredictionBusyRef.current = true;
      void classifier
        .predict(videoRef.current, { signal: controller.signal })
        .then((nextPredictions) => {
          if (
            controller.signal.aborted ||
            livePredictionGenerationRef.current !== generation
          ) return;
          const frames = [
            ...livePredictionFramesRef.current,
            nextPredictions,
          ].slice(-LIVE_PREDICTION_WINDOW);
          livePredictionFramesRef.current = frames;
          setPredictions(averagePredictionFrames(frames));
        })
        .catch(() => undefined)
        .finally(() => {
          if (livePredictionGenerationRef.current === generation) {
            livePredictionBusyRef.current = false;
          }
        });
    }, 260);
    return () => {
      window.clearInterval(interval);
      controller.abort();
      if (livePredictionAbortRef.current === controller) livePredictionAbortRef.current = null;
      if (livePredictionGenerationRef.current === generation) {
        livePredictionGenerationRef.current += 1;
        livePredictionBusyRef.current = false;
      }
      livePredictionFramesRef.current = [];
    };
  }, [cameraMode, cameraReady, hasModel]);

  const addImageFiles = useCallback(async (classId: string, files: File[]) => {
    if (files.length === 0 || workspaceBusyRef.current || imageProcessingRef.current) return;
    imageProcessingRef.current = true;
    setProcessingClassId(classId);
    const samples: ProjectSample[] = [];
    let failed = 0;
    const selectedFiles = files.slice(0, 100);
    const skipped = files.length - selectedFiles.length;
    try {
      for (const file of selectedFiles) {
        try {
          const processed = await resizeImageFile(file, { size: 224, quality: 0.88 });
          samples.push(createProjectSample({
            name: processed.name,
            dataUrl: processed.dataUrl,
            source: "upload",
            size: processed.width,
          }));
        } catch {
          failed += 1;
        }
      }
      if (samples.length > 0 && !workspaceBusyRef.current) {
        commitProject((current) => ({
          ...current,
          classes: current.classes.map((item) =>
            item.id === classId ? { ...item, samples: [...item.samples, ...samples] } : item,
          ),
        }));
        notify("success", `已添加 ${samples.length} 张图片${failed ? `，${failed} 张无法读取` : ""}${skipped ? `，${skipped} 张因单次上限未处理` : ""}。`);
      } else if (samples.length > 0) {
        notify("warning", "图片已处理完成，但当前有其他操作正在进行，本批图片未添加；请稍后重试。 ");
      } else if (failed) {
        notify("error", "无法读取所选图片，请使用 JPG、PNG 或 WebP 文件。可尝试换一张图片。 ");
      }
    } finally {
      imageProcessingRef.current = false;
      setProcessingClassId(null);
    }
  }, [commitProject, notify]);

  const chooseImages = (classId: string) => {
    if (workspaceBusyRef.current || imageProcessingRef.current) return;
    if (!competitionProjectReady) {
      notify("warning", "当前项目不符合橙子比赛规则，请先新建比赛项目。 ");
      return;
    }
    setUploadClassId(classId);
    uploadInputRef.current?.click();
  };

  const handleUploadInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (uploadClassId) void addImageFiles(uploadClassId, Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLElement>, classId: string) => {
    event.preventDefault();
    if (workspaceBusyRef.current || imageProcessingRef.current) return;
    if (!competitionProjectReady) {
      notify("warning", "当前项目不符合橙子比赛规则，请先新建比赛项目。 ");
      return;
    }
    void addImageFiles(classId, Array.from(event.dataTransfer.files));
  };

  const openSampleManager = (classId: string) => {
    if (workspaceBusyRef.current) return;
    sampleManagerTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSampleManagerClassId(classId);
    setSelectedSampleIds(new Set());
    setSampleManagerPage(0);
  };

  const reviewHealthIssue = (issue: DataHealthIssue, requestedClassId?: string) => {
    const classId = requestedClassId ?? issue.classIds.find((candidate) =>
      project.classes.some((projectClass) => projectClass.id === candidate),
    );
    if (!classId) return;
    const projectClass = project.classes.find((candidate) => candidate.id === classId);
    if (!projectClass) return;
    const firstRelevantIndex = projectClass.samples.findIndex((sample) =>
      issue.sampleIds.includes(sample.id),
    );
    const page = firstRelevantIndex >= 0
      ? Math.floor(firstRelevantIndex / SAMPLE_MANAGER_PAGE_SIZE)
      : 0;
    const pageStart = page * SAMPLE_MANAGER_PAGE_SIZE;
    const visibleIds = new Set(
      projectClass.samples
        .slice(pageStart, pageStart + SAMPLE_MANAGER_PAGE_SIZE)
        .filter((sample) => issue.sampleIds.includes(sample.id))
        .map((sample) => sample.id),
    );
    sampleManagerTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setSampleManagerClassId(classId);
    setSelectedSampleIds(visibleIds);
    setSampleManagerPage(page);
  };

  const healthIssueActionClassIds = (issue: DataHealthIssue): string[] => {
    if (issue.code !== "class-imbalance") return issue.classIds;
    const counts = issue.classIds.map((classId) =>
      project.classes.find((projectClass) => projectClass.id === classId)?.samples.length
      ?? Number.POSITIVE_INFINITY,
    );
    const minimum = Math.min(...counts);
    return issue.classIds.filter((_, index) => counts[index] === minimum);
  };

  const closeSampleManager = () => {
    setSampleManagerClassId(null);
    setSelectedSampleIds(new Set());
    setSampleManagerPage(0);
  };

  const toggleManagedSample = (sampleId: string) => {
    setSelectedSampleIds((current) => {
      const next = new Set(current);
      if (next.has(sampleId)) next.delete(sampleId);
      else next.add(sampleId);
      return next;
    });
  };

  const toggleAllManagedSamples = () => {
    if (!managedClass) return;
    setSelectedSampleIds(
      allManagedSamplesSelected
        ? new Set()
        : new Set(managedClass.samples.map((sample) => sample.id)),
    );
  };

  const deleteSelectedSamples = () => {
    if (!managedClass || selectedSampleIds.size === 0) return;
    const selectedCount = managedClass.samples.reduce(
      (count, sample) => count + Number(selectedSampleIds.has(sample.id)),
      0,
    );
    if (selectedCount === 0) return;
    if (!window.confirm(`从“${managedClass.name}”中删除选中的 ${selectedCount} 张图片？`)) return;
    const classId = managedClass.id;
    commitProject((current) => ({
      ...current,
      classes: current.classes.map((item) =>
        item.id === classId
          ? { ...item, samples: item.samples.filter((sample) => !selectedSampleIds.has(sample.id)) }
          : item,
      ),
    }));
    setSelectedSampleIds(new Set());
    setSampleManagerPage((current) => {
      const remaining = managedClass.samples.length - selectedCount;
      return Math.min(current, Math.max(0, Math.ceil(remaining / SAMPLE_MANAGER_PAGE_SIZE) - 1));
    });
    notify("success", `已删除 ${selectedCount} 张样本图片。`);
  };

  const clearManagedClass = () => {
    if (!managedClass || managedClass.samples.length === 0) return;
    if (!window.confirm(`清空“${managedClass.name}”的全部 ${managedClass.samples.length} 张图片？此操作无法撤销。`)) return;
    const classId = managedClass.id;
    const removedCount = managedClass.samples.length;
    commitProject((current) => ({
      ...current,
      classes: current.classes.map((item) =>
        item.id === classId ? { ...item, samples: [] } : item,
      ),
    }));
    setSelectedSampleIds(new Set());
    setSampleManagerPage(0);
    notify("success", `已清空 ${removedCount} 张样本图片。`);
  };

  const addCameraFrame = useCallback(() => {
    if (cameraMode?.type !== "collect" || !videoRef.current) return;
    if (continuousCapture && cameraCapturedCountRef.current >= GUIDED_CAPTURE_TARGET) {
      setContinuousCapture(false);
      return;
    }
    try {
      cameraSampleIndexRef.current += 1;
      const groupId = continuousCapture
        ? captureGroupIdRef.current
        : makeCaptureGroupId();
      const sample = makeCameraSample(
        captureVideoSquare(videoRef.current),
        cameraSampleIndexRef.current,
        groupId,
      );
      commitProject((current) => ({
        ...current,
        classes: current.classes.map((item) =>
          item.id === cameraMode.classId ? { ...item, samples: [...item.samples, sample] } : item,
        ),
      }));
      const captured = cameraCapturedCountRef.current + 1;
      cameraCapturedCountRef.current = captured;
      setCameraCapturedCount(captured);
      if (continuousCapture && captured >= GUIDED_CAPTURE_TARGET) {
        setContinuousCapture(false);
        notify("success", `本轮已采集 ${captured} 张。建议换一个背景或角度，再开始下一轮。`);
      }
    } catch (error) {
      notify("error", userFacingError(error));
    }
  }, [cameraMode, commitProject, continuousCapture, notify]);

  const startGuidedCapture = () => {
    if (!cameraReady || captureCountdown !== null) return;
    if (continuousCapture) {
      setContinuousCapture(false);
      return;
    }
    cameraCapturedCountRef.current = 0;
    setCameraCapturedCount(0);
    captureGroupIdRef.current = makeCaptureGroupId();
    setCaptureCountdown(3);
  };

  useEffect(() => {
    if (captureCountdown === null) return;
    const timer = window.setTimeout(() => {
      if (captureCountdown > 1) {
        setCaptureCountdown(captureCountdown - 1);
      } else {
        setCaptureCountdown(null);
        setContinuousCapture(true);
      }
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [captureCountdown]);

  useEffect(() => {
    if (!continuousCapture || cameraMode?.type !== "collect" || !cameraReady) return;
    const firstFrame = window.setTimeout(addCameraFrame, 0);
    const interval = window.setInterval(addCameraFrame, 850);
    return () => {
      window.clearTimeout(firstFrame);
      window.clearInterval(interval);
    };
  }, [addCameraFrame, cameraMode, cameraReady, continuousCapture]);

  useEffect(() => {
    if (!cameraMode) return;
    const onVisibilityChange = () => {
      if (document.hidden) {
        setContinuousCapture(false);
        setCaptureCountdown(null);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [cameraMode]);

  const startTraining = async () => {
    if (!canTrain) {
      notify(
        "warning",
        workspaceBusy
          ? "请等待当前操作完成后再开始训练。"
          : trainingBlockMessage,
      );
      return;
    }
    const trainingProject = projectRef.current;
    const operationId = workspaceGenerationRef.current + 1;
    workspaceGenerationRef.current = operationId;
    workspaceBusyRef.current = true;
    setActiveStep(2);
    document.querySelector("#train")?.scrollIntoView({ behavior: "smooth", block: "start" });
    const controller = new AbortController();
    trainingAbortRef.current = controller;
    setTrainingState("running");
    try {
      if (projectPersistenceEnabled) {
        const saveGeneration = await cancelAndWaitForProjectSaves();
        await saveProjectWithLock(trainingProject, false, saveGeneration);
      }
    } catch (error) {
      if (workspaceGenerationRef.current !== operationId) return;
      if (trainingAbortRef.current === controller) trainingAbortRef.current = null;
      setTrainingState("error");
      workspaceBusyRef.current = false;
      notify("error", `训练前无法保存项目：${userFacingError(error)}`);
      return;
    }
    if (workspaceGenerationRef.current !== operationId) return;
    if (controller.signal.aborted) {
      if (trainingAbortRef.current === controller) trainingAbortRef.current = null;
      setTrainingState("stopped");
      workspaceBusyRef.current = false;
      return;
    }
    classifierRef.current?.dispose();
    const classifier = createImageClassifier();
    classifierRef.current = classifier;
    setModelLabels([]);
    setTrainingProgress(null);
    setTrainingDuration(null);
    setTrainingMetrics(null);
    setValidationMetrics(null);
    setValidationStatus(null);
    setModelOrigin(null);
    setExternalPredictionSettings(null);
    setPredictions([]);
    try {
      const result = await classifier.train(
        projectTrainingExamples(trainingProject),
        {
          ...trainingProject.training,
          validationSplit: trainingProject.classes.reduce((total, item) => total + item.samples.length, 0) >= 20 ? 0.15 : 0,
          signal: controller.signal,
          onProgress: (progress) => {
            if (workspaceGenerationRef.current === operationId) setTrainingProgress(progress);
          },
        },
      );
      if (workspaceGenerationRef.current !== operationId || controller.signal.aborted) return;
      if (trainingAbortRef.current === controller) trainingAbortRef.current = null;
      setTrainingDuration(result.durationMs);
      setTrainingMetrics({
        accuracy: lastHistoryMetric(result.history, "acc", "accuracy"),
        validationAccuracy: lastHistoryMetric(result.history, "val_acc", "val_accuracy"),
      });
      setValidationMetrics(result.validation);
      setValidationStatus(result.validationStatus);
      setModelLabels(result.labels);
      const modelSaved = await persistClassifier(trainingProject, classifier, operationId);
      if (workspaceGenerationRef.current !== operationId) return;
      setTrainingState("complete");
      workspaceBusyRef.current = false;
      setModelOrigin("project");
      setExternalPredictionSettings(null);
      setModelStale(false);
      setActiveStep(3);
      notify(
        modelSaved ? "success" : "warning",
        modelSaved
          ? "训练完成，模型已自动保存在此设备上。"
          : "训练完成，但模型自动保存失败；请先下载训练模型备份。",
      );
    } catch (error) {
      if (workspaceGenerationRef.current !== operationId) return;
      if (controller.signal.aborted) {
        setTrainingState("stopped");
        workspaceBusyRef.current = false;
        notify("info", "训练已停止，你的图片样本仍然保留。 ");
      } else {
        setTrainingState("error");
        workspaceBusyRef.current = false;
        notify("error", userFacingError(error));
      }
    } finally {
      if (trainingAbortRef.current === controller) trainingAbortRef.current = null;
    }
  };

  const stopTraining = () => {
    if (trainingProgress?.phase !== "complete") trainingAbortRef.current?.abort();
  };

  const exportProject = async () => {
    try {
      const { exportProjectArchive } = await import("@/lib/project/project-archive");
      const archive = await exportProjectArchive(project);
      downloadBlob(archive, `${project.name || "识物项目"}.识物项目.zip`);
      notify("success", "项目备份已下载，包含类别、图片样本和训练设置。 ");
    } catch (error) {
      notify("error", userFacingError(error));
    }
  };

  const exportModel = async () => {
    const classifier = classifierRef.current;
    if (!classifier?.getState().classifierReady) {
      notify("warning", "请先完成一次模型训练。 ");
      return;
    }
    try {
      const { exportModelArchive } = await import("@/lib/project/model-archive");
      const bundle = await classifier.exportModel();
      requireOrangeCompetitionLabels(bundle.labels, "导出模型类别");
      const exportClasses = bundle.labels.map((label, index) => {
        const projectClass = project.classes.find((item) => item.name.trim() === label);
        return {
          id: `model-label-${index + 1}`,
          name: label,
          color: projectClass?.color ?? CLASS_COLORS[index % CLASS_COLORS.length],
          samples: [],
        };
      });
      const metadata = createClassifierMetadata({
        ...project,
        prediction: { ...predictionSettings },
        classes: exportClasses.map((item) => ({ ...item, name: item.name.trim() })),
      });
      metadata.featureExtractor = "MobileNet v2 alpha 0.5 embedding";
      const archive = await exportModelArchive(bundle, metadata);
      downloadBlob(archive, `${project.name || "识物模型"}.识物模型.zip`);
      notify("success", "TensorFlow.js 模型包已下载。 ");
    } catch (error) {
      notify("error", userFacingError(error));
    }
  };

  const importProjectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (workspaceBusyRef.current) {
      notify("warning", "请等待当前操作完成后再导入项目。");
      return;
    }
    if (!confirmLeavingConflictedProject()) return;
    if (!projectPersistenceEnabled && (totalSamples > 0 || hasModel) && !window.confirm("当前处于临时模式，导入后会替换本页内容。请确认已经导出备份，仍要继续吗？")) return;
    const operationId = workspaceGenerationRef.current + 1;
    workspaceGenerationRef.current = operationId;
    workspaceBusyRef.current = true;
    setWorkspaceTask("importing-project");
    try {
      const saveGeneration = await cancelAndWaitForProjectSaves();
      const { importProjectArchive } = await import("@/lib/project/project-archive");
      const importedArchive = await importProjectArchive(file);
      requireOrangeCompetitionLabels(
        importedArchive.classes.map(({ name }) => name),
        "导入项目类别",
      );
      if (workspaceGenerationRef.current !== operationId) return;
      if (projectPersistenceEnabled && !externalProjectConflictRef.current) {
        await saveProjectWithLock(projectRef.current, false, saveGeneration);
      }
      const now = new Date().toISOString();
      const imported: Project = {
        ...importedArchive,
        id: freshProject().id,
        createdAt: now,
        updatedAt: now,
        prediction: importedArchive.prediction ?? { ...DEFAULT_PREDICTION_SETTINGS },
      };
      if (projectPersistenceEnabled) {
        await saveProjectWithLock(imported, true, saveGeneration);
      }
      if (workspaceGenerationRef.current !== operationId) return;
      classifierRef.current?.dispose();
      classifierRef.current = null;
      externalProjectConflictRef.current = false;
      setExternalProjectConflict(false);
      projectRef.current = imported;
      setProject(imported);
      setPersistedProjectUpdatedAt(projectPersistenceEnabled ? imported.updatedAt : null);
      setModelLabels([]);
      setModelOrigin(null);
      setExternalPredictionSettings(null);
      setPredictions([]);
      setModelStale(false);
      setTrainingState("idle");
      setTrainingDuration(null);
      setTrainingMetrics(null);
      setValidationMetrics(null);
      setValidationStatus(null);
      setModelStorageState("none");
      setSaveState(projectPersistenceEnabled ? "saved" : "error");
      setWorkspaceTask("idle");
      workspaceBusyRef.current = false;
      void refreshProjectCatalog();
      notify(
        "success",
        projectPersistenceEnabled
          ? `已将“${imported.name}”导入为新项目，原项目仍保留。`
          : `已导入“${imported.name}”；当前处于临时模式，请及时导出项目备份。`,
      );
    } catch (error) {
      if (workspaceGenerationRef.current !== operationId) return;
      setWorkspaceTask("idle");
      workspaceBusyRef.current = false;
      notify("error", `无法导入项目：${userFacingError(error)}`);
    }
  };

  const importModelFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (workspaceBusyRef.current) {
      notify("warning", "请等待当前操作完成后再载入模型。");
      return;
    }
    const operationId = workspaceGenerationRef.current + 1;
    workspaceGenerationRef.current = operationId;
    workspaceBusyRef.current = true;
    setWorkspaceTask("importing-model");
    const projectId = projectRef.current.id;
    let classifier: TeachableImageClassifier | null = null;
    try {
      const { importModelArchive } = await import("@/lib/project/model-archive");
      const { bundle, metadata } = await importModelArchive(file);
      requireOrangeCompetitionLabels(bundle.labels, "导入模型类别");
      if (workspaceGenerationRef.current !== operationId || projectRef.current.id !== projectId) return;
      classifier = createImageClassifier();
      await classifier.importModel(bundle);
      if (workspaceGenerationRef.current !== operationId || projectRef.current.id !== projectId) {
        classifier.dispose();
        return;
      }
      classifierRef.current?.dispose();
      classifierRef.current = classifier;
      classifier = null;
      setExternalPredictionSettings({
        ...(metadata.prediction
          ?? projectRef.current.prediction
          ?? DEFAULT_PREDICTION_SETTINGS),
      });
      setModelLabels(bundle.labels);
      setModelOrigin("external");
      setModelStale(false);
      setTrainingState("complete");
      setTrainingDuration(null);
      setTrainingMetrics(null);
      setValidationMetrics(null);
      setValidationStatus(null);
      setPredictions([]);
      setActiveStep(3);
      setModelStorageState("none");
      setWorkspaceTask("idle");
      workspaceBusyRef.current = false;
      notify("info", `外部模型“${metadata.name}”已载入；它未关联当前项目，刷新后需要重新导入。`);
      window.setTimeout(() => document.querySelector("#test")?.scrollIntoView({ behavior: "smooth" }), 50);
    } catch (error) {
      classifier?.dispose();
      if (workspaceGenerationRef.current !== operationId) return;
      setWorkspaceTask("idle");
      workspaceBusyRef.current = false;
      notify("error", `模型文件无法载入：${userFacingError(error)}`);
    }
  };

  const handleTestImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const processed = await resizeImageFile(file, { size: 224, quality: 0.9 });
      setTestImage(processed.dataUrl);
      await predictInput(processed.dataUrl);
    } catch (error) {
      notify("error", userFacingError(error));
    }
  };

  function confirmLeavingConflictedProject(): boolean {
    return !externalProjectConflictRef.current || window.confirm(
      "当前页包含尚未保存的冲突版本。继续会放弃本页改动；如需保留，请先导出项目备份。仍要继续吗？",
    );
  }

  const newProject = async () => {
    if (workspaceBusyRef.current) {
      notify("warning", "请等待当前操作完成后再新建项目。");
      return;
    }
    if (!confirmLeavingConflictedProject()) return;
    if (!projectPersistenceEnabled && (totalSamples > 0 || hasModel) && !window.confirm("当前处于临时模式，新建后本页项目将无法恢复。请确认已经导出备份，仍要继续吗？")) return;
    const operationId = workspaceGenerationRef.current + 1;
    workspaceGenerationRef.current = operationId;
    workspaceBusyRef.current = true;
    setWorkspaceTask("switching-project");
    trainingAbortRef.current?.abort();
    try {
      const saveGeneration = await cancelAndWaitForProjectSaves();
      if (projectPersistenceEnabled && !externalProjectConflictRef.current) {
        await saveProjectWithLock(projectRef.current, true, saveGeneration);
      }
      if (workspaceGenerationRef.current !== operationId) return;
      const next = freshProject();
      if (projectPersistenceEnabled) {
        await saveProjectWithLock(next, true, saveGeneration);
      }
      if (workspaceGenerationRef.current !== operationId) return;
      classifierRef.current?.dispose();
      classifierRef.current = null;
      externalProjectConflictRef.current = false;
      setExternalProjectConflict(false);
      projectRef.current = next;
      setProject(next);
      setPersistedProjectUpdatedAt(projectPersistenceEnabled ? next.updatedAt : null);
      setModelLabels([]);
      setModelOrigin(null);
      setExternalPredictionSettings(null);
      setPredictions([]);
      setTestImage(null);
      setTrainingState("idle");
      setTrainingDuration(null);
      setTrainingMetrics(null);
      setValidationMetrics(null);
      setValidationStatus(null);
      setModelStale(false);
      setModelStorageState("none");
      setSaveState(projectPersistenceEnabled ? "saved" : "error");
      setWorkspaceTask("idle");
      workspaceBusyRef.current = false;
      setProjectManagerOpen(false);
      setActiveStep(1);
      void refreshProjectCatalog();
      notify(
        "success",
        projectPersistenceEnabled
          ? "已创建新项目，原项目仍保留在项目管理中。"
          : "已创建临时项目；当前浏览器无法持久保存，请及时导出项目备份。",
      );
    } catch (error) {
      if (workspaceGenerationRef.current !== operationId) return;
      setWorkspaceTask("idle");
      workspaceBusyRef.current = false;
      notify("error", `无法创建新项目：${userFacingError(error)}`);
    }
  };

  const openProjectManager = () => {
    if (workspaceBusyRef.current) return;
    projectManagerTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setProjectManagerOpen(true);
    void refreshProjectCatalog(true);
  };

  const switchStoredProject = async (projectId: string) => {
    if (workspaceBusyRef.current) return;
    if (projectId === projectRef.current.id) {
      setProjectManagerOpen(false);
      return;
    }
    if (!confirmLeavingConflictedProject()) return;
    const operationId = workspaceGenerationRef.current + 1;
    workspaceGenerationRef.current = operationId;
    workspaceBusyRef.current = true;
    setWorkspaceTask("switching-project");
    try {
      const saveGeneration = await cancelAndWaitForProjectSaves();
      if (!externalProjectConflictRef.current) {
        await saveProjectWithLock(projectRef.current, false, saveGeneration);
      }
      const target = await loadStoredProjectById(projectId);
      if (!target) throw new Error("目标项目不存在或已被删除。");
      await setLastOpenedProjectId(projectId);
      intentionalNavigationRef.current = true;
      window.location.reload();
    } catch (error) {
      if (workspaceGenerationRef.current !== operationId) return;
      setWorkspaceTask("idle");
      workspaceBusyRef.current = false;
      notify("error", `无法打开项目：${userFacingError(error)}`);
    }
  };

  const removeStoredProject = async (summary: StoredProjectSummary) => {
    if (workspaceBusyRef.current) return;
    if (!window.confirm(`删除项目“${summary.name || "未命名项目"}”？其中 ${summary.sampleCount} 张图片及本地模型会被移除，此操作无法撤销。`)) return;
    const operationId = workspaceGenerationRef.current + 1;
    workspaceGenerationRef.current = operationId;
    workspaceBusyRef.current = true;
    setWorkspaceTask("deleting-project");
    try {
      await cancelAndWaitForProjectSaves();
      await deleteProjectWithLock(summary.id);
      persistedProjectUpdatedAtRef.current.delete(summary.id);
      broadcastProjectEvent({ type: "deleted", projectId: summary.id });
      const remaining = await listStoredProjects();
      if (summary.id === projectRef.current.id) {
        await setLastOpenedProjectId(remaining[0]?.id ?? null);
        intentionalNavigationRef.current = true;
        window.location.reload();
        return;
      }
      if (workspaceGenerationRef.current !== operationId) return;
      setStoredProjects(remaining);
      window.requestAnimationFrame(() => projectManagerCloseRef.current?.focus());
      setWorkspaceTask("idle");
      workspaceBusyRef.current = false;
      notify("success", `项目“${summary.name || "未命名项目"}”已删除。`);
    } catch (error) {
      if (workspaceGenerationRef.current !== operationId) return;
      setWorkspaceTask("idle");
      workspaceBusyRef.current = false;
      notify("error", `无法删除项目：${userFacingError(error)}`);
    }
  };

  const openCamera = (mode: CameraMode) => {
    if (workspaceBusyRef.current) return;
    if (mode.type === "collect" && !competitionProjectReady) {
      notify("warning", "当前项目不符合橙子比赛规则，请先新建比赛项目。 ");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      notify("error", "当前浏览器不支持摄像头，请改用上传图片。 ");
      return;
    }
    setCameraReady(false);
    setCameraError(null);
    setCaptureCountdown(null);
    setContinuousCapture(false);
    cameraCapturedCountRef.current = 0;
    setCameraCapturedCount(0);
    captureGroupIdRef.current = makeCaptureGroupId();
    cancelInputPrediction();
    cancelLivePrediction();
    setLivePredictionAnnouncement(null);
    if (mode.type === "test") setPredictions([]);
    if (mode.type === "collect") {
      cameraSampleIndexRef.current = project.classes.find((item) => item.id === mode.classId)?.samples.length ?? 0;
    }
    cameraTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCameraMode(mode);
  };

  const closeCamera = () => {
    cancelLivePrediction();
    setLivePredictionAnnouncement(null);
    setCameraMode(null);
    setCameraReady(false);
    setContinuousCapture(false);
    setCaptureCountdown(null);
    cameraCapturedCountRef.current = 0;
    setCameraCapturedCount(0);
    stopMediaStream(streamRef.current);
    streamRef.current = null;
  };

  const switchCamera = () => {
    if (!cameraMode) return;
    cancelLivePrediction();
    setLivePredictionAnnouncement(null);
    setCameraReady(false);
    setCameraError(null);
    setContinuousCapture(false);
    setCaptureCountdown(null);
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    if (cameraMode.type === "test") setPredictions([]);
    setCameraFacingMode((current) => current === "environment" ? "user" : "environment");
  };

  const changeTestSource = (source: TestSource) => {
    if (source === testSource) return;
    cancelInputPrediction();
    cancelLivePrediction();
    setLivePredictionAnnouncement(null);
    setPredictions([]);
    setTestSource(source);
  };

  const updateConfidenceThreshold = (confidenceThreshold: number) => {
    if (modelOrigin === "external") {
      setExternalPredictionSettings((current) => ({
        ...(current ?? predictionSettings),
        confidenceThreshold,
      }));
      return;
    }
    commitProject((current) => ({
      ...current,
      prediction: {
        ...(current.prediction ?? DEFAULT_PREDICTION_SETTINGS),
        confidenceThreshold,
      },
    }), false);
  };

  const predictionColors = useMemo(() => {
    const map = new Map(project.classes.map((item) => [item.name.trim(), item.color]));
    return (label: string, index: number) => map.get(label) ?? CLASS_COLORS[index % CLASS_COLORS.length];
  }, [project.classes]);

  return (
    <main className="studio-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="识物工坊首页">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span>识物工坊</span>
          <span className="mode-badge">橙子二分类</span>
        </a>
        <label className="project-name-field">
          <span className="sr-only">项目名称</span>
          <input
            value={project.name}
            maxLength={120}
            disabled={workspaceBusy}
            onChange={(event) => commitProject((current) => ({ ...current, name: event.target.value }), false)}
            onBlur={() => {
              if (!project.name.trim()) commitProject((current) => ({ ...current, name: "未命名项目" }), false);
            }}
            aria-label="项目名称"
          />
        </label>
        <div className="top-actions">
          <span className={`save-state save-${saveState}`} role={saveState === "error" ? "alert" : "status"} aria-live="polite">{saveStateLabel(saveState)}</span>
          <a className="quiet-button" href="/portal.html"><ChevronLeft size={16} /><span>统一平台</span></a>
          <a className="quiet-button competition-entry" href="/competition"><Trophy size={16} /><span>比赛提交</span></a>
          <button className="quiet-button desktop-action" type="button" disabled={workspaceBusy || !projectPersistenceEnabled} onClick={openProjectManager}><FolderOpen size={16} />项目管理</button>
          <button className="quiet-button desktop-action" type="button" disabled={workspaceBusy} onClick={() => void newProject()}>新建项目</button>
          <details className="action-menu">
            <summary className="quiet-button"><FolderInput size={16} />导入<ChevronDown size={14} /></summary>
            <div className="menu-popover">
              <div className="mobile-project-controls">
                <label><span>项目名称</span><input value={project.name} maxLength={120} disabled={workspaceBusy} onChange={(event) => commitProject((current) => ({ ...current, name: event.target.value }), false)} aria-label="移动端项目名称" /></label>
                <span className={`mobile-save-state save-${saveState}`} role={saveState === "error" ? "alert" : "status"}>{saveStateLabel(saveState)}</span>
                <button type="button" disabled={workspaceBusy || !projectPersistenceEnabled} onClick={openProjectManager}><FolderOpen size={18} /><span><strong>项目管理</strong><small>打开、切换或删除设备项目</small></span></button>
                <button type="button" disabled={workspaceBusy} onClick={() => void newProject()}><Plus size={18} /><span><strong>新建项目</strong><small>创建一个空白训练项目</small></span></button>
              </div>
              <button type="button" disabled={workspaceBusy} onClick={() => projectImportRef.current?.click()}><FileArchive size={18} /><span><strong>导入项目备份</strong><small>恢复类别、图片与设置</small></span></button>
              <button type="button" disabled={workspaceBusy} onClick={() => modelImportRef.current?.click()}><PackageOpen size={18} /><span><strong>载入现有模型</strong><small>直接测试识物模型包</small></span></button>
            </div>
          </details>
          <details className="action-menu">
            <summary className="primary-small"><Download size={16} />导出<ChevronDown size={14} /></summary>
            <div className="menu-popover menu-right">
              <button type="button" onClick={() => void exportProject()}><Archive size={18} /><span><strong>备份训练项目</strong><small>包含全部图片，可继续编辑</small></span></button>
              <button type="button" disabled={!hasModel || !competitionModelReady} onClick={() => void exportModel()}><BrainCircuit size={18} /><span><strong>下载训练模型</strong><small>{competitionModelReady ? "不含样本图片 · TensorFlow.js" : hasModel ? "模型类别不符合比赛要求" : "请先完成训练"}</small></span></button>
            </div>
          </details>
          <a className="help-button" href="#guide" aria-label="使用帮助"><CircleHelp size={19} /></a>
        </div>
      </header>

      <aside className="side-panel">
        <nav className="workflow" aria-label="模型训练步骤">
          <p className="eyebrow">训练流程</p>
          {[
            { number: 1, href: "#dataset", title: "准备样本", copy: `${project.classes.length} 类 · ${totalSamples} 张` },
            { number: 2, href: "#train", title: "训练模型", copy: trainingState === "complete" ? "训练完成" : "浏览器内训练" },
            { number: 3, href: "#test", title: "测试与导出", copy: hasModel ? "模型已就绪" : "等待训练" },
          ].map((step) => (
            <a
              key={step.number}
              className={`workflow-step ${activeStep === step.number ? "active" : ""}`}
              href={step.href}
              aria-current={activeStep === step.number ? "step" : undefined}
              onClick={() => setActiveStep(step.number)}
            >
              <span className="step-number">{step.number}</span>
              <span><strong>{step.title}</strong><small>{step.copy}</small></span>
            </a>
          ))}
        </nav>
        <div className="privacy-note"><ShieldCheck size={20} /><div><strong>数据留在你的设备</strong><p>图片和训练过程默认不会上传。</p></div></div>
      </aside>

      <div className="workspace" id="top">
        <section className="workspace-heading" aria-labelledby="page-title">
          <div>
            <p className="section-kicker"><Sparkles size={14} />橙子识别比赛训练台</p>
            <h1 id="page-title">训练模型识别橙子</h1>
            <p className="section-copy">分别上传“橙子”和“非橙子”图片，在浏览器里完成训练、测试并导出参赛模型。</p>
            <p className="mode-note"><Zap size={14} />当前是整张图片分类，不会在画面中框出物体位置。</p>
          </div>
          <div className="dataset-summary" aria-label="项目数据概览">
            <span><strong>{project.classes.length}</strong> 个类别</span>
            <span><strong>{totalSamples}</strong> 张样本</span>
          </div>
        </section>

        {!competitionProjectReady && (
          <div className="external-conflict" role="alert">
            <AlertTriangle size={19} />
            <div><strong>当前项目不是橙子比赛项目</strong><p>比赛固定使用“橙子”和“非橙子”两个类别。请保留此项目备份，并新建一个比赛项目。</p></div>
            <button type="button" disabled={workspaceBusy} onClick={() => void newProject()}><Plus size={15} />新建比赛项目</button>
          </div>
        )}

        {externalProjectConflict && (
          <div className="external-conflict" role="alert">
            <AlertTriangle size={19} />
            <div><strong>项目在另一个标签页中发生了变化</strong><p>当前页面已停止自动保存，避免覆盖较新的数据。可以重新载入，或先导出本页项目备份。</p></div>
            <button type="button" onClick={() => window.location.reload()}><RotateCcw size={15} />重新载入</button>
          </div>
        )}

        <section className="stage-card data-stage" id="dataset" aria-labelledby="dataset-title">
          <div className="stage-heading">
            <span className="large-step">1</span>
            <div><h2 id="dataset-title">准备样本</h2><p>分别收集橙子和非橙子画面，让模型学会正确识别与排除。</p></div>
            <span className="stage-tip">每类建议 {RECOMMENDED_SAMPLES} 张以上</span>
          </div>

          <div className="inline-alert info">
            <ShieldCheck size={17} />
            <span><strong>比赛类别已经固定</strong>“橙子”放不同品种、角度、距离和光线的橙子；“非橙子”放苹果、橘子、橙色球、手、桌面和空背景等容易混淆的画面。</span>
          </div>

          <div className={`data-health-panel health-${dataHealthState}`}>
            <div className="data-health-summary">
              <span><Gauge size={20} /></span>
              <div>
                <strong>数据健康度</strong>
                <p role="status" aria-live="polite" aria-atomic="true">
                  {dataHealthState === "checking" && "正在本地检查样本数量、类别平衡和重复画面…"}
                  {dataHealthState === "error" && "本次检查未完成，可以重新尝试。"}
                  {(dataHealthState === "idle" || !dataHealth) && dataHealthState !== "checking" && "添加图片后会自动在设备上检查，不会上传。"}
                  {dataHealthState === "ready" && dataHealth && dataHealth.issues.length === 0 && "没有发现明显问题，类别数量和平衡度都不错。"}
                  {dataHealthState === "ready" && dataHealth && dataHealth.issues.length > 0 && `${dataHealthErrorCount} 项需要处理 · ${dataHealthWarningCount} 项优化建议`}
                </p>
              </div>
              <button className="secondary-button" type="button" disabled={dataHealthState === "checking"} onClick={() => setDataHealthRefresh((current) => current + 1)}>
                {dataHealthState === "checking" ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}
                重新检查
              </button>
            </div>
            {dataHealthState === "ready" && dataHealth && dataHealth.issues.length > 0 && (
              <div className="data-health-issues">
                {dataHealth.issues.slice(0, healthIssuesExpanded ? undefined : 5).map((issue, index) => (
                  <div className={`health-issue issue-${issue.severity}`} key={`${issue.code}-${issue.classIds.join("-")}-${index}`}>
                    <span>{issue.severity === "error" ? <AlertTriangle size={15} /> : <Sparkles size={15} />}</span>
                    <p>{issue.message}</p>
                    {issue.sampleIds.length > 0 && (
                      <div className="health-issue-actions">
                        {issue.classIds.map((classId) => {
                          const className = project.classes.find((projectClass) => projectClass.id === classId)?.name;
                          return <button type="button" key={classId} onClick={() => reviewHealthIssue(issue, classId)}>{issue.classIds.length > 1 ? `查看${className || "类别"}` : "查看样本"}</button>;
                        })}
                      </div>
                    )}
                    {issue.sampleIds.length === 0 && issue.classIds.length > 0 && (
                      <div className="health-issue-actions">
                        {healthIssueActionClassIds(issue).map((classId) => {
                          const className = project.classes.find((projectClass) => projectClass.id === classId)?.name;
                          return <button type="button" key={classId} disabled={!competitionProjectReady} onClick={() => chooseImages(classId)}>为{className || "该类别"}添加图片</button>;
                        })}
                      </div>
                    )}
                  </div>
                ))}
                {dataHealth.issues.length > 5 && (
                  <button className="health-expand" type="button" onClick={() => setHealthIssuesExpanded((current) => !current)}>
                    {healthIssuesExpanded ? "收起问题" : `查看其余 ${dataHealth.issues.length - 5} 项`}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="class-grid">
            {project.classes.map((item, classIndex) => (
              <article className="class-card" key={item.id} style={{ "--class-color": item.color } as React.CSSProperties}>
                <div className="class-card-head">
                  <span className="class-swatch" aria-hidden="true" />
                  <label>
                    <span>类别 {classIndex + 1}</span>
                    <input value={item.name} readOnly aria-readonly="true" aria-label={`类别 ${classIndex + 1} 名称（比赛固定）`} title="比赛类别名称固定，不能修改" />
                  </label>
                  <span className={`sample-count ${item.samples.length >= MIN_SAMPLES ? "ready" : ""} ${(classHealthIssueCounts.get(item.id) ?? 0) > 0 ? "has-health-issues" : ""}`} title={(classHealthIssueCounts.get(item.id) ?? 0) > 0 ? `${classHealthIssueCounts.get(item.id)} 项数据提示` : undefined}>{item.samples.length} 张</span>
                </div>

                {item.samples.length > 0 ? (
                  <div className="sample-grid" aria-live="polite">
                    {item.samples.slice(-12).map((sample) => (
                      <figure key={sample.id}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={sample.dataUrl} alt="" />
                      </figure>
                    ))}
                    <button className="sample-add-tile" type="button" disabled={workspaceBusy || processingClassId !== null || !competitionProjectReady} onClick={() => chooseImages(item.id)} aria-label={`继续为${item.name}添加图片`}><Plus size={20} /></button>
                  </div>
                ) : (
                  <div
                    className="drop-zone"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => handleDrop(event, item.id)}
                  >
                    <span className="upload-shape"><Images size={22} /></span>
                    <strong>拖入图片，或从设备中选择</strong>
                    <small>JPG、PNG、WebP · 单张不超过 15 MB</small>
                  </div>
                )}

                <div className="class-actions">
                  <button className="class-primary" type="button" onClick={() => chooseImages(item.id)} disabled={workspaceBusy || processingClassId !== null || !competitionProjectReady}>
                    {processingClassId === item.id ? <LoaderCircle className="spin" size={16} /> : <ImagePlus size={16} />}
                    {processingClassId === item.id ? "正在处理…" : "添加图片"}
                  </button>
                  <button type="button" disabled={workspaceBusy || processingClassId !== null || !competitionProjectReady} onClick={() => openCamera({ type: "collect", classId: item.id })}><Camera size={16} />摄像头采集</button>
                  {item.samples.length > 0 && (
                    <button className="manage-samples" type="button" disabled={workspaceBusy} onClick={() => openSampleManager(item.id)}><Eye size={16} />查看并管理全部 {item.samples.length} 张</button>
                  )}
                </div>
                <p className="class-hint">
                  {item.samples.length < MIN_SAMPLES
                    ? `还需 ${MIN_SAMPLES - item.samples.length} 张即可训练`
                    : item.samples.length < RECOMMENDED_SAMPLES
                      ? `可以训练，再补 ${RECOMMENDED_SAMPLES - item.samples.length} 张效果会更好`
                      : "样本数量不错，记得保持角度和背景多样"}
                </p>
              </article>
            ))}
          </div>
        </section>

        <div className="lower-stages">
          <section className="stage-card train-stage" id="train" aria-labelledby="train-title">
            <div className="stage-heading">
              <span className="large-step">2</span>
              <div><h2 id="train-title">训练模型</h2><p>训练会在你的浏览器中完成。</p></div>
              {trainingState === "complete" && <span className="success-badge"><Check size={13} />已完成</span>}
            </div>

            {modelStale && <div className="inline-alert warning"><AlertTriangle size={17} /><span><strong>样本已更新</strong>重新训练后，新样本才会生效。</span></div>}

            {trainingState === "running" ? (
              <div className="training-progress" aria-live="polite">
                <span className="training-orbit"><BrainCircuit size={28} /></span>
                <div className="progress-copy"><strong>{progressLabel(trainingProgress, project.training.epochs)}</strong><span>{percent}% · 训练期间请保持页面开启</span></div>
                <progress value={percent} max={100} aria-label="训练进度" />
                <button className="danger-soft" type="button" disabled={trainingProgress?.phase === "complete"} onClick={stopTraining}><StopCircle size={17} />{trainingProgress?.phase === "complete" ? "正在保存" : "停止训练"}</button>
              </div>
            ) : trainingState === "complete" ? (
              <div className="training-complete">
                <span><CheckCircle2 size={28} /></span>
                <div>
                  <strong>{trainingDuration ? "训练完成" : "模型已就绪"}</strong>
                  <p>
                    {modelOrigin === "external"
                      ? `${modelLabels.length} 个模型类别 · 外部导入，未关联当前项目`
                      : `${project.classes.length} 个类别 · ${totalSamples} 张样本${trainingDuration ? ` · 用时 ${formatDuration(trainingDuration)}` : " · 已恢复模型"}${trainingMetrics?.validationAccuracy !== undefined ? ` · 分层验证准确率 ${Math.round(trainingMetrics.validationAccuracy * 100)}%` : ""}`}
                  </p>
                  <small className={`model-storage-status model-storage-${modelStorageState}`}>
                    {modelStorageState === "loading" && "正在读取本地模型…"}
                    {modelStorageState === "saving" && "正在把模型保存到此设备…"}
                    {(modelStorageState === "saved" || modelStorageState === "restored") && "模型已保存在此设备，刷新页面也可恢复"}
                    {modelStorageState === "error" && "模型本地保存失败，请下载模型备份"}
                    {modelStorageState === "none" && (modelOrigin === "external" ? "外部模型仅在本页有效，刷新后需要重新导入" : "当前模型仅在本页有效，请下载模型备份")}
                  </small>
                </div>
              </div>
            ) : (
              <div className="training-readiness">
                <div className="readiness-number"><strong>{totalSamples}</strong><span>训练样本</span></div>
                <div>
                  <strong>{canTrain ? "数据已经可以开始训练" : !dataHealthReadyForTraining ? "正在检查数据健康度" : blockingDataHealthIssue ? "先处理数据问题" : "还需要完善训练数据"}</strong>
                  <p>{canTrain ? "会先提取视觉特征，再学习你的类别。" : trainingBlockMessage}</p>
                </div>
              </div>
            )}

            {trainingState === "complete" && modelOrigin === "project" && validationMetrics && (
              <div className="validation-report">
                <div className="validation-report-head">
                  <div><strong>分组验证报告</strong><p>{validationMetrics.exampleCount} 张未参与训练的图片 · 同一连续拍摄组不会跨集合</p></div>
                  <span>{Math.round(validationMetrics.accuracy * 100)}%<small>总体准确率</small></span>
                </div>
                <div className="validation-summary-grid">
                  <span><strong>{Math.round(validationMetrics.macroF1 * 100)}%</strong><small>Macro F1</small></span>
                  <span><strong>{Math.round(validationMetrics.balancedAccuracy * 100)}%</strong><small>平衡准确率</small></span>
                  <span><strong>{validationMetrics.exampleCount}</strong><small>验证样本</small></span>
                </div>
                <div className="confusion-matrix-wrap">
                  <p>混淆矩阵 <small>行是真实类别，列是模型预测</small></p>
                  {mostConfusedPair && (
                    <p className="confusion-summary">最容易混淆：真实“{mostConfusedPair.actual}”被识别为“{mostConfusedPair.predicted}” {mostConfusedPair.count} 次。</p>
                  )}
                  <table
                    className="confusion-matrix"
                    style={{ minWidth: `${Math.max(360, (modelLabels.length + 1) * 82)}px` }}
                  >
                    <caption className="sr-only">验证集混淆矩阵，行是真实类别，列是预测类别</caption>
                    <thead><tr><th scope="col">真实 \ 预测</th>{modelLabels.map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
                    <tbody>
                      {validationMetrics.confusionMatrix.map((row, rowIndex) => (
                        <tr key={modelLabels[rowIndex] ?? rowIndex}>
                          <th scope="row">{modelLabels[rowIndex]}</th>
                          {row.map((value, columnIndex) => <td className={rowIndex === columnIndex && value > 0 ? "correct" : value > 0 ? "confused" : ""} key={`${rowIndex}-${columnIndex}`}>{value}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="class-metrics">
                  {validationMetrics.perClass.map((metric) => (
                    <div key={metric.label}>
                      <strong>{metric.label}</strong>
                      <span>样本 {metric.support}</span>
                      <span>精确率 {Math.round(metric.precision * 100)}%</span>
                      <span>召回率 {Math.round(metric.recall * 100)}%</span>
                      <span>F1 {Math.round(metric.f1 * 100)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {trainingState === "complete" && trainingDuration && modelOrigin === "project" && validationStatus && validationStatus !== "available" && (
              <div className="validation-unavailable"><AlertTriangle size={16} /><span><strong>暂时没有可靠的分组验证报告</strong>{validationStatus === "disabled" ? "项目至少达到 20 张样本后会启用验证。" : "每个类别至少需要两个独立上传图片或拍摄批次；请换背景或角度再采集一轮。"}</span></div>
            )}

            <details className="advanced-settings">
              <summary><Settings2 size={16} /><span>高级训练设置<small>通常保持默认即可</small></span><ChevronDown size={15} /></summary>
              <div className="settings-grid">
                <label>训练轮次<input type="number" min={5} max={100} disabled={workspaceBusy} value={project.training.epochs} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) commitProject((current) => ({ ...current, training: { ...current.training, epochs: Math.min(500, Math.max(1, Math.round(value))) } }), false); }} onBlur={() => commitProject((current) => ({ ...current, training: { ...current.training, epochs: Math.min(100, Math.max(5, Math.round(current.training.epochs))) } }), false)} /></label>
                <label>批次大小<select disabled={workspaceBusy} value={project.training.batchSize} onChange={(event) => commitProject((current) => ({ ...current, training: { ...current.training, batchSize: Number(event.target.value) } }), false)}><option value={8}>8</option><option value={16}>16</option><option value={32}>32</option></select></label>
                <label>学习率<select disabled={workspaceBusy} value={project.training.learningRate} onChange={(event) => commitProject((current) => ({ ...current, training: { ...current.training, learningRate: Number(event.target.value) } }), false)}><option value={0.0005}>0.0005</option><option value={0.001}>0.001</option><option value={0.003}>0.003</option></select></label>
              </div>
            </details>

            {trainingState !== "running" && (
              <button className="stage-primary" type="button" onClick={() => void startTraining()} disabled={!canTrain} aria-describedby={!canTrain ? "training-requirement" : undefined}>
                {trainingState === "complete" ? <RotateCcw size={18} /> : <Play size={18} fill="currentColor" />}
                {trainingState === "complete" ? "重新训练" : "开始训练"}
              </button>
            )}
            {!canTrain && <p className="button-reason" id="training-requirement">{trainingBlockMessage}</p>}
          </section>

          <section className="stage-card test-stage" id="test" aria-labelledby="test-title">
            <div className="stage-heading">
              <span className="large-step">3</span>
              <div><h2 id="test-title">测试与导出</h2><p>看看模型能不能认出新的画面。</p></div>
            </div>

            {!hasModel ? (
              <div className="locked-test"><span><LockKeyhole size={25} /></span><strong>等待模型</strong><p>训练完成后，可用摄像头或图片测试模型。</p></div>
            ) : (
              <>
                <div className="test-tabs" role="tablist" aria-label="测试方式">
                  <button type="button" role="tab" aria-selected={testSource === "image"} className={testSource === "image" ? "active" : ""} onClick={() => changeTestSource("image")}><Upload size={15} />上传图片</button>
                  <button type="button" role="tab" aria-selected={testSource === "camera"} className={testSource === "camera" ? "active" : ""} onClick={() => changeTestSource("camera")}><Camera size={15} />摄像头</button>
                </div>

                <div className="test-workspace">
                  <button className={`test-preview ${testImage ? "has-image" : ""}`} type="button" onClick={() => testSource === "camera" ? openCamera({ type: "test" }) : testInputRef.current?.click()}>
                    {testImage && testSource === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={testImage} alt="用于模型测试的图片" />
                    ) : (
                      <><span>{testSource === "camera" ? <Camera size={24} /> : <ImagePlus size={24} />}</span><strong>{testSource === "camera" ? "开启摄像头" : "选择测试图片"}</strong><small>使用训练图片之外的新画面</small></>
                    )}
                    {predicting && <span className="preview-loading"><LoaderCircle className="spin" size={22} />正在识别</span>}
                  </button>

                  <div className={`prediction-panel ${predictionDecision?.uncertain ? "is-uncertain" : ""}`} aria-live={cameraMode?.type === "test" ? "off" : "polite"}>
                    <div className="prediction-title">
                      <strong>识别结果</strong>
                      {predictionDecision && (
                        <span>{predictionDecision.uncertain ? "无法判断" : predictionDecision.label} · {Math.round(predictionDecision.probability * 100)}%</span>
                      )}
                    </div>
                    {predictionDecision?.uncertain && predictionReason && (
                      <p className="prediction-reason"><AlertTriangle size={13} />{predictionReason}</p>
                    )}
                    <PredictionRows
                      predictions={predictions}
                      colorFor={predictionColors}
                      emptyMessage="选择一个新画面后，这里会显示所有类别的置信度。"
                    />
                  </div>
                </div>
                <label className="unknown-threshold">
                  <span><Gauge size={14} /><strong>最低识别置信度</strong><b>{Math.round(predictionSettings.confidenceThreshold * 100)}%</b></span>
                  <input
                    type="range"
                    min={0.45}
                    max={0.9}
                    step={0.05}
                    disabled={workspaceBusy}
                    value={predictionSettings.confidenceThreshold}
                    onChange={(event) => updateConfidenceThreshold(Number(event.target.value))}
                    aria-label="最低识别置信度"
                  />
                </label>
                <p className="confidence-note">最高置信度低于阈值，或前两类差距小于 {Math.round(predictionSettings.marginThreshold * 100)}%，就显示“无法判断”。实时结果会综合最近 {LIVE_PREDICTION_WINDOW} 帧，减少跳动。{modelOrigin === "external" ? " 当前设置属于已载入的外部模型，不会改写当前项目。" : ""}</p>
              </>
            )}

            <div className="export-row">
              <button className="stage-primary" type="button" disabled={!hasModel || !competitionModelReady} onClick={() => void exportModel()}><Download size={17} />下载训练模型</button>
              <button className="secondary-button" type="button" onClick={() => void exportProject()}><Save size={17} />备份项目（含图片）</button>
            </div>
            {hasModel && !competitionModelReady && <p className="button-reason">当前模型不是“橙子 / 非橙子”二分类模型，不能作为参赛模型导出。</p>}
          </section>
        </div>

        <section className="guide-card" id="guide" aria-labelledby="guide-title">
          <div><span><BrainCircuit size={21} /></span><div><h2 id="guide-title">怎样训练得更准？</h2><p>两类使用相近数量的图片；橙子样本要变化角度、距离和光线，非橙子样本要重点加入橘子、苹果和橙色物品等易混淆画面。</p></div></div>
          <div className="guide-pills"><span>本地运行</span><span>无需代码</span><span>可导入导出</span></div>
        </section>
      </div>

      <input ref={uploadInputRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={handleUploadInput} />
      <input ref={projectImportRef} className="sr-only" type="file" accept=".zip,application/zip" onChange={(event) => void importProjectFile(event)} />
      <input ref={modelImportRef} className="sr-only" type="file" accept=".zip,application/zip" onChange={(event) => void importModelFile(event)} />
      <input ref={testInputRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void handleTestImage(event)} />

      {notice && <div className={`toast toast-${notice.tone}`} role="status"><span>{notice.tone === "success" ? <CheckCircle2 size={18} /> : notice.tone === "error" ? <AlertTriangle size={18} /> : <Sparkles size={18} />}</span>{notice.message}<button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={15} /></button></div>}

      {projectManagerOpen && (
        <div className="dialog-backdrop project-manager-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setProjectManagerOpen(false)}>
          <section ref={projectManagerDialogRef} className="project-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="project-manager-title" tabIndex={-1}>
            <div className="dialog-heading">
              <div><h2 id="project-manager-title">项目管理</h2><p>项目、样本和对应模型都保存在当前浏览器设备中。</p></div>
              <button ref={projectManagerCloseRef} type="button" onClick={() => setProjectManagerOpen(false)} aria-label="关闭项目管理"><X size={20} /></button>
            </div>
            <div className="project-manager-toolbar">
              <div><strong>{storedProjects.length}</strong><span>个设备项目</span></div>
              <button className="stage-primary" type="button" disabled={workspaceBusy} onClick={() => void newProject()}><Plus size={17} />新建项目</button>
            </div>
            <div className="project-list" aria-live="polite">
              {projectCatalogLoading ? (
                <div className="project-list-state"><LoaderCircle className="spin" size={25} /><strong>正在读取项目…</strong></div>
              ) : projectCatalogError ? (
                <div className="project-list-state" role="alert"><AlertTriangle size={28} /><strong>{projectCatalogError}</strong><p>项目数据没有被删除，可以稍后重试。</p><button type="button" onClick={() => void refreshProjectCatalog(true)}>重新读取</button></div>
              ) : storedProjects.length > 0 ? storedProjects.map((summary) => {
                const current = summary.id === project.id;
                return (
                  <article className={`project-list-item ${current ? "current" : ""}`} key={summary.id}>
                    <button className="project-open" type="button" disabled={current || workspaceBusy} onClick={() => void switchStoredProject(summary.id)}>
                      <span className="project-folder"><FolderOpen size={21} /></span>
                      <span><strong>{summary.name.trim() || "未命名项目"}</strong><small>{summary.classCount} 个类别 · {summary.sampleCount} 张样本 · {formatProjectUpdatedAt(summary.updatedAt)}</small><em className={summary.hasModel ? "has-model" : ""}>{summary.hasModel ? "有本地模型" : "仅项目数据"}</em></span>
                      {current ? <b><Check size={13} />当前项目</b> : <ChevronRight size={18} />}
                    </button>
                    <button className="project-delete" type="button" disabled={workspaceBusy} onClick={() => void removeStoredProject(summary)} aria-label={`删除项目${summary.name || "未命名项目"}`}><Trash2 size={17} /></button>
                  </article>
                );
              }) : (
                <div className="project-list-state"><FolderOpen size={28} /><strong>还没有保存的项目</strong><p>新建项目后会自动出现在这里。</p></div>
              )}
            </div>
            <div className="project-manager-note"><ShieldCheck size={16} />清理浏览器网站数据会移除这些项目，重要内容请定期导出项目备份。</div>
          </section>
        </div>
      )}

      {managedClass && (
        <div className="dialog-backdrop sample-manager-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeSampleManager()}>
          <section ref={sampleManagerDialogRef} className="sample-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="sample-manager-title" tabIndex={-1}>
            <div className="dialog-heading">
              <div><h2 id="sample-manager-title">管理“{managedClass.name}”的样本</h2><p>全部 {managedClass.samples.length} 张 · 点击图片可多选，然后批量删除。</p></div>
              <button ref={sampleManagerCloseRef} type="button" onClick={closeSampleManager} aria-label="关闭样本管理"><X size={20} /></button>
            </div>
            <div className="sample-manager-toolbar">
              <button className="secondary-button" type="button" onClick={toggleAllManagedSamples} aria-pressed={allManagedSamplesSelected}>
                <Check size={16} />{allManagedSamplesSelected ? "取消全选" : `全选 ${managedClass.samples.length} 张`}
              </button>
              <span>已选择 {selectedSampleIds.size} 张</span>
              <button className="danger-soft" type="button" disabled={selectedSampleIds.size === 0} onClick={deleteSelectedSamples}><Trash2 size={16} />删除所选</button>
              <button className="danger-soft clear-samples" type="button" disabled={managedClass.samples.length === 0} onClick={clearManagedClass}><Trash2 size={16} />清空类别</button>
            </div>
            {managedPageSamples.length > 0 ? (
              <div className="sample-manager-grid">
                {managedPageSamples.map((sample, index) => {
                  const selected = selectedSampleIds.has(sample.id);
                  const sampleNumber = managedPageIndex * SAMPLE_MANAGER_PAGE_SIZE + index + 1;
                  return (
                    <button
                      className={selected ? "selected" : ""}
                      type="button"
                      key={sample.id}
                      aria-pressed={selected}
                      aria-label={`${selected ? "取消选择" : "选择"}${managedClass.name}的第 ${sampleNumber} 张图片`}
                      onClick={() => toggleManagedSample(sample.id)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={sample.dataUrl} alt="" />
                      <span className="sample-selection" aria-hidden="true">{selected && <Check size={14} />}</span>
                      <small>{sampleNumber}</small>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="sample-manager-empty"><Images size={28} /><strong>这个类别还没有图片</strong></div>
            )}
            <div className="sample-manager-footer">
              <span>第 {managedPageIndex + 1} / {managedPageCount} 页</span>
              <div>
                <button type="button" disabled={managedPageIndex === 0} onClick={() => setSampleManagerPage((current) => Math.max(0, current - 1))}><ChevronLeft size={17} />上一页</button>
                <button type="button" disabled={managedPageIndex >= managedPageCount - 1} onClick={() => setSampleManagerPage((current) => Math.min(managedPageCount - 1, current + 1))}>下一页<ChevronRight size={17} /></button>
              </div>
            </div>
          </section>
        </div>
      )}

      {cameraMode && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeCamera()}>
          <section ref={cameraDialogRef} className={`camera-dialog ${cameraMode.type === "test" ? "test-camera-dialog" : ""}`} role="dialog" aria-modal="true" aria-labelledby="camera-title" tabIndex={-1}>
            <div className="dialog-heading"><div><h2 id="camera-title">{cameraMode.type === "collect" ? "引导式摄像头采集" : "实时测试"}</h2><p>{cameraMode.type === "collect" ? `本轮目标 ${GUIDED_CAPTURE_TARGET} 张 · ${captureGuidance}` : `将新物品放在镜头前；最近 ${LIVE_PREDICTION_WINDOW} 帧会自动平滑。`}</p></div><button ref={cameraCloseRef} type="button" onClick={closeCamera} aria-label="关闭摄像头"><X size={20} /></button></div>
            <div className={cameraMode.type === "test" ? "camera-test-layout" : undefined}>
              <div className="camera-frame">
                <video ref={videoRef} muted playsInline aria-label="摄像头预览" />
                {!cameraReady && !cameraError && <div className="camera-state"><LoaderCircle className="spin" size={28} /><span>正在启动摄像头…</span></div>}
                {cameraError && <div className="camera-state error" role="alert"><AlertTriangle size={28} /><span>{cameraError}</span></div>}
                {captureCountdown !== null && <div className="capture-countdown" aria-live="assertive"><strong>{captureCountdown}</strong><span>准备转动物品</span></div>}
                <button className="switch-camera" type="button" disabled={!cameraReady} onClick={switchCamera}><SwitchCamera size={17} />切换镜头</button>
                {cameraMode.type === "collect" && cameraReady && (
                  <div className="capture-progress">
                    <span>本轮采集</span><strong>{cameraCapturedCount} / {GUIDED_CAPTURE_TARGET}</strong>
                    <progress aria-label="引导采集进度" value={Math.min(cameraCapturedCount, GUIDED_CAPTURE_TARGET)} max={GUIDED_CAPTURE_TARGET} />
                    {cameraCapturedCount > 0 && <span className="sr-only" role="status" aria-live="polite">{cameraCapturedCount >= GUIDED_CAPTURE_TARGET ? "本轮采集完成" : cameraCapturedCount >= 8 ? "已完成三分之二，请改变距离、光线或背景" : cameraCapturedCount >= 4 ? "已完成三分之一，请补充侧面和俯视角度" : "正在采集正面样本"}</span>}
                  </div>
                )}
                {cameraMode.type === "test" && <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{livePredictionAnnouncement}</span>}
              </div>
              {cameraMode.type === "test" && (
                // The probability list scrolls independently when a model has many classes.
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                <section className={`camera-test-results ${predictionDecision?.uncertain ? "is-uncertain" : ""}`} aria-labelledby="camera-result-title" tabIndex={0}>
                  <div className="camera-test-results-heading">
                    <div><strong id="camera-result-title">识别结果</strong><small>实时 · 最近 {LIVE_PREDICTION_WINDOW} 帧平滑</small></div>
                    {predictionDecision ? (
                      <span><b>{predictionDecision.uncertain ? "无法判断" : predictionDecision.label}</b><em>{Math.round(predictionDecision.probability * 100)}%</em></span>
                    ) : <span className="waiting">等待画面</span>}
                  </div>
                  {predictionDecision?.uncertain && predictionReason && (
                    <p className="prediction-reason"><AlertTriangle size={13} />{predictionReason}</p>
                  )}
                  <div className="camera-test-result-list">
                    <PredictionRows
                      predictions={predictions}
                      colorFor={predictionColors}
                      emptyMessage="摄像头准备好后，这里会实时显示所有类别的置信度。"
                      emptyClassName="camera-test-result-empty"
                    />
                  </div>
                </section>
              )}
            </div>
            {cameraMode.type === "collect" ? (
              <>
                <div className="capture-guidance"><span>{captureGuidance}</span><small>同一次连续采集会作为一个验证组，避免相似画面让准确率虚高。</small></div>
                <div className="camera-actions">
                  <button className="secondary-button" type="button" disabled={!cameraReady || continuousCapture || captureCountdown !== null} onClick={addCameraFrame}><Camera size={18} />拍一张</button>
                  <button className={`stage-primary ${continuousCapture ? "capturing" : ""}`} type="button" disabled={!cameraReady || captureCountdown !== null} onClick={startGuidedCapture}>{continuousCapture ? <Square size={16} fill="currentColor" /> : <Play size={17} fill="currentColor" />}{continuousCapture ? "停止本轮采集" : captureCountdown !== null ? `准备中 ${captureCountdown}` : "开始引导采集"}</button>
                </div>
              </>
            ) : (
              <div className="camera-actions"><button className="stage-primary" type="button" onClick={closeCamera}>完成测试</button></div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
