export type BaselineStatus = "pass" | "fail";

export interface BaselineRegisterRequest {
  local_session_id: string;
  started_at_ms: number;
  ended_at_ms: number;
  fs: number;
  lead_count: number;
  layout: string;
  gap_count: number;
  sha256: string;
  storage_key: string;
}

export interface BaselineRegisterResponse {
  baseline_cloud_id: string;
  status: BaselineStatus;
  reason?: string;
}

export interface RunRegisterRequest {
  local_session_id: string;
  baseline_cloud_id: string;
  started_at_ms: number;
  ended_at_ms: number;
  fs: number;
  lead_count: number;
  layout: string;
  gap_count: number;
  sha256: string;
  storage_key: string;
}

export interface RunRegisterResponse {
  run_cloud_id: string;
}

export interface AnalysisTriggerRequest {
  run_cloud_id: string;
  baseline_cloud_id: string;
}

export interface AnalysisTriggerResponse {
  job_id: string;
}

export type AnalysisStatus = "queued" | "running" | "done" | "fail";

export interface AnalysisStatusResponse {
  status: AnalysisStatus;
  reason?: string;
}

export interface InsightsResponse {
  summary: string;
  confidence: number;
  flags: string[];
  plot_urls: Record<string, string>;
  metrics: Record<string, unknown>;
}

const DEFAULT_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://example.com";

async function http<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${DEFAULT_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`API error ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function registerBaseline(
  body: BaselineRegisterRequest,
): Promise<BaselineRegisterResponse> {
  return await http<BaselineRegisterResponse>("/baseline-sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function registerRun(
  body: RunRegisterRequest,
): Promise<RunRegisterResponse> {
  return await http<RunRegisterResponse>("/run-sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function triggerAnalysis(
  body: AnalysisTriggerRequest,
): Promise<AnalysisTriggerResponse> {
  return await http<AnalysisTriggerResponse>("/analysis", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function pollAnalysis(
  jobId: string,
): Promise<AnalysisStatusResponse> {
  return await http<AnalysisStatusResponse>(`/analysis/${jobId}`);
}

export async function fetchInsights(
  runCloudId: string,
): Promise<InsightsResponse> {
  return await http<InsightsResponse>(`/run-sessions/${runCloudId}/insights`);
}
