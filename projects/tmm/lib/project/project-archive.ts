import JSZip from "jszip";

import { jpegDataUrlToUint8Array, uint8ArrayToJpegDataUrl, utf8ByteLength } from "./binary";
import { sanitizeFilename } from "./download";
import { PROJECT_FORMAT, PROJECT_FORMAT_VERSION, type Project, type ProjectSample } from "./types";
import { isPlainObject, PROJECT_LIMITS, validateProject } from "./validation";

export const PROJECT_ARCHIVE_FORMAT = "tm-object-project-archive" as const;
export const PROJECT_ARCHIVE_VERSION = 1 as const;
export const PROJECT_ARCHIVE_MIME_TYPE = "application/zip";

export const PROJECT_ARCHIVE_LIMITS = {
  maxArchiveBytes: 220 * 1024 * 1024,
  maxManifestBytes: 8 * 1024 * 1024,
  maxEntries: PROJECT_LIMITS.maxTotalSamples + 100,
} as const;

interface ArchivedProjectSample extends Omit<ProjectSample, "dataUrl"> {
  imagePath: string;
}

interface ProjectArchiveManifest {
  format: typeof PROJECT_ARCHIVE_FORMAT;
  formatVersion: typeof PROJECT_ARCHIVE_VERSION;
  exportedAt: string;
  project: Omit<Project, "classes"> & {
    classes: Array<Omit<Project["classes"][number], "samples"> & {
      samples: ArchivedProjectSample[];
    }>;
  };
}

export class ProjectArchiveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectArchiveError";
  }
}

function safePathSegment(value: string, fallback: string): string {
  return sanitizeFilename(value, fallback).replace(/\s+/g, "-");
}

function imagePath(
  classId: string,
  sampleId: string,
  classIndex: number,
  sampleIndex: number,
): string {
  const classPart = `${String(classIndex + 1).padStart(2, "0")}-${safePathSegment(classId, "class")}`;
  const samplePart = `${String(sampleIndex + 1).padStart(4, "0")}-${safePathSegment(sampleId, "sample")}.jpg`;
  return `images/${classPart}/${samplePart}`;
}

function archiveByteLength(input: Blob | ArrayBuffer | Uint8Array): number {
  if ("size" in input) {
    return input.size;
  }
  return input.byteLength;
}

function declaredUncompressedSize(entry: JSZip.JSZipObject): number | undefined {
  const internal = entry as JSZip.JSZipObject & {
    _data?: { uncompressedSize?: unknown };
  };
  const size = internal._data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : undefined;
}

function assertSafeArchivePath(path: string): void {
  const segments = path.split("/");
  if (
    path.length > 300 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new ProjectArchiveError(`ZIP 中包含不安全路径：${path}`);
  }
}

function parseManifest(json: string): Record<string, unknown> {
  if (utf8ByteLength(json) > PROJECT_ARCHIVE_LIMITS.maxManifestBytes) {
    throw new ProjectArchiveError("project.json 超过大小限制");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new ProjectArchiveError("project.json 不是有效 JSON", { cause: error });
  }
  if (!isPlainObject(parsed)) {
    throw new ProjectArchiveError("project.json 根节点必须是对象");
  }
  if (
    parsed.format !== PROJECT_ARCHIVE_FORMAT ||
    parsed.formatVersion !== PROJECT_ARCHIVE_VERSION ||
    !isPlainObject(parsed.project)
  ) {
    throw new ProjectArchiveError("项目备份格式或版本不受支持");
  }
  return parsed.project;
}

function buildArchiveManifest(project: Project): ProjectArchiveManifest {
  return {
    format: PROJECT_ARCHIVE_FORMAT,
    formatVersion: PROJECT_ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    project: {
      ...project,
      classes: project.classes.map((projectClass, classIndex) => ({
        ...projectClass,
        samples: projectClass.samples.map((sample, sampleIndex) => ({
          id: sample.id,
          name: sample.name,
          source: sample.source,
          createdAt: sample.createdAt,
          width: sample.width,
          height: sample.height,
          ...(sample.captureGroupId ? { captureGroupId: sample.captureGroupId } : {}),
          imagePath: imagePath(projectClass.id, sample.id, classIndex, sampleIndex),
        })),
      })),
    },
  };
}

export async function exportProjectZip(project: Project): Promise<Blob> {
  validateProject(project);
  const archive = new JSZip();
  const manifest = buildArchiveManifest(project);
  let totalImageBytes = 0;

  for (let classIndex = 0; classIndex < project.classes.length; classIndex += 1) {
    const projectClass = project.classes[classIndex];
    for (let sampleIndex = 0; sampleIndex < projectClass.samples.length; sampleIndex += 1) {
      const sample = projectClass.samples[sampleIndex];
      const bytes = jpegDataUrlToUint8Array(sample.dataUrl);
      totalImageBytes += bytes.byteLength;
      if (totalImageBytes > PROJECT_LIMITS.maxProjectBytes) {
        throw new ProjectArchiveError("项目图片总大小超过限制");
      }
      archive.file(imagePath(projectClass.id, sample.id, classIndex, sampleIndex), bytes, {
        binary: true,
        date: new Date(sample.createdAt),
      });
    }
  }

  archive.file("project.json", JSON.stringify(manifest, null, 2));
  const blob = await archive.generateAsync({
    type: "blob",
    mimeType: PROJECT_ARCHIVE_MIME_TYPE,
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  if (blob.size > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new ProjectArchiveError("生成的项目备份超过大小限制");
  }
  return blob;
}

export async function importProjectZip(input: Blob | ArrayBuffer | Uint8Array): Promise<Project> {
  const inputBytes = archiveByteLength(input);
  if (inputBytes < 1 || inputBytes > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new ProjectArchiveError("项目备份为空或超过大小限制");
  }

  let archive: JSZip;
  try {
    const zipInput = "size" in input ? await input.arrayBuffer() : input;
    archive = await JSZip.loadAsync(zipInput, { checkCRC32: false, createFolders: false });
  } catch (error) {
    throw new ProjectArchiveError("无法读取项目 ZIP 备份", { cause: error });
  }

  const entries = Object.values(archive.files);
  if (entries.length > PROJECT_ARCHIVE_LIMITS.maxEntries) {
    throw new ProjectArchiveError("项目备份包含过多文件");
  }
  for (const entry of entries) {
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) {
      throw new ProjectArchiveError(`ZIP 中包含不安全路径：${entry.unsafeOriginalName}`);
    }
    if (!entry.dir) {
      assertSafeArchivePath(entry.name);
      const declaredSize = declaredUncompressedSize(entry);
      const entryLimit = entry.name === "project.json"
        ? PROJECT_ARCHIVE_LIMITS.maxManifestBytes
        : PROJECT_LIMITS.maxSampleBytes;
      if (declaredSize !== undefined && declaredSize > entryLimit) {
        throw new ProjectArchiveError(`ZIP 文件超过解压限制：${entry.name}`);
      }
    }
  }

  const manifestEntry = archive.file("project.json");
  if (!manifestEntry) {
    throw new ProjectArchiveError("项目备份缺少 project.json");
  }
  const archivedProject = parseManifest(await manifestEntry.async("string"));
  if (!Array.isArray(archivedProject.classes)) {
    throw new ProjectArchiveError("project.json 缺少类别列表");
  }

  const expectedEntries = new Set<string>(["project.json"]);
  let totalImageBytes = 0;
  const classes: Record<string, unknown>[] = [];
  for (const [classIndex, classValue] of archivedProject.classes.entries()) {
    if (!isPlainObject(classValue) || !Array.isArray(classValue.samples)) {
      throw new ProjectArchiveError(`类别 ${classIndex + 1} 格式无效`);
    }
    const samples: Record<string, unknown>[] = [];
    for (const [sampleIndex, sampleValue] of classValue.samples.entries()) {
      if (!isPlainObject(sampleValue) || typeof sampleValue.imagePath !== "string") {
        throw new ProjectArchiveError(`类别 ${classIndex + 1} 的样本 ${sampleIndex + 1} 格式无效`);
      }
      const path = sampleValue.imagePath;
      assertSafeArchivePath(path);
      if (!path.startsWith("images/") || !path.toLowerCase().endsWith(".jpg")) {
        throw new ProjectArchiveError(`样本图片路径无效：${path}`);
      }
      if (expectedEntries.has(path)) {
        throw new ProjectArchiveError(`样本图片路径重复：${path}`);
      }
      expectedEntries.add(path);
      const imageEntry = archive.file(path);
      if (!imageEntry) {
        throw new ProjectArchiveError(`项目备份缺少图片：${path}`);
      }
      const bytes = await imageEntry.async("uint8array");
      if (bytes.byteLength < 1 || bytes.byteLength > PROJECT_LIMITS.maxSampleBytes) {
        throw new ProjectArchiveError(`样本图片大小无效：${path}`);
      }
      totalImageBytes += bytes.byteLength;
      if (totalImageBytes > PROJECT_LIMITS.maxProjectBytes) {
        throw new ProjectArchiveError("项目图片总大小超过限制");
      }

      const sampleFields = { ...sampleValue };
      delete sampleFields.imagePath;
      delete sampleFields.dataUrl;
      samples.push({ ...sampleFields, dataUrl: uint8ArrayToJpegDataUrl(bytes) });
    }
    const classFields = { ...classValue };
    delete classFields.samples;
    classes.push({ ...classFields, samples });
  }

  const unexpectedFiles = entries.filter((entry) => !entry.dir && !expectedEntries.has(entry.name));
  if (unexpectedFiles.length > 0) {
    throw new ProjectArchiveError(`项目备份包含未引用文件：${unexpectedFiles[0].name}`);
  }

  const projectFields = { ...archivedProject };
  delete projectFields.classes;
  const projectCandidate: unknown = { ...projectFields, classes };
  try {
    validateProject(projectCandidate);
  } catch (error) {
    throw new ProjectArchiveError("项目内容校验失败", { cause: error });
  }
  if (
    projectCandidate.format !== PROJECT_FORMAT ||
    projectCandidate.formatVersion !== PROJECT_FORMAT_VERSION
  ) {
    throw new ProjectArchiveError("项目版本不受支持");
  }
  return projectCandidate;
}

export function projectArchiveFileName(projectName: string): string {
  return `${sanitizeFilename(projectName, "project")}.tm-project.zip`;
}

export const exportProjectArchive = exportProjectZip;
export const importProjectArchive = importProjectZip;
