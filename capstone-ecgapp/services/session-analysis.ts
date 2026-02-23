import { BACKEND_BASE_URL } from "@/config/runtime-config";

export type SessionAnalysisStartResponse = {
  job_id: string;
  status: string;
  record_id: string;
};

export async function startSessionAnalysis(
  recordId: string,
): Promise<SessionAnalysisStartResponse> {
  const url = `${BACKEND_BASE_URL}/session_analysis/start`;
  console.log(`[ANALYSIS] POST ${url} record_id=${recordId}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ record_id: recordId }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Analysis start failed: ${response.status} ${text}`,
    );
  }

  const data = (await response.json()) as SessionAnalysisStartResponse;
  console.log(
    `[ANALYSIS] queued job_id=${data.job_id} status=${data.status} record_id=${data.record_id}`,
  );
  return data;
}

