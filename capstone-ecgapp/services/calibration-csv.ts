import { BACKEND_BASE_URL } from "@/config/runtime-config";

export async function uploadCalibrationCsv(params: {
  csv: string;
  runId: string;
  rows: number;
  invalidPackets: number;
}): Promise<void> {
  const url = `${BACKEND_BASE_URL}/calibration_channels_csv`;
  console.log(`LOG ${url}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/csv",
      "X-Run-Id": params.runId,
      "X-Row-Count": String(params.rows),
      "X-Invalid-Packets": String(params.invalidPackets),
    },
    body: params.csv,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `CSV upload failed: ${response.status} ${text}`,
    );
  }
}
