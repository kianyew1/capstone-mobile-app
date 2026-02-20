import type {
  APIResponse,
  CalibrationAPIResponse,
  RunSession,
  HeartRateData,
} from "@/types";

// Base URL for the FastAPI backend - replace with actual URL
const API_BASE_URL = "https://api.ecgapp.example.com";

// Simulated network delay
const simulateDelay = (ms: number = 1500) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mock API Service
 * Replace these mock implementations with actual API calls when backend is ready
 */

// ============================================
// CALIBRATION APIs
// ============================================

export async function submitCalibrationData(
  deviceId: string,
  signalData: number[],
): Promise<APIResponse<CalibrationAPIResponse>> {
  // Simulate API call
  await simulateDelay(2000);

  // Mock response - 80% success rate for testing
  const isSuccess = Math.random() > 0.2;

  if (isSuccess) {
    return {
      success: true,
      data: {
        isCalibrated: true,
        signalQuality: 85 + Math.floor(Math.random() * 15), // 85-100%
        message: "Calibration successful! Your device is ready to use.",
        recommendations: [],
      },
    };
  } else {
    return {
      success: false,
      data: {
        isCalibrated: false,
        signalQuality: 30 + Math.floor(Math.random() * 30), // 30-60%
        message:
          "Calibration failed. Please ensure the device is properly placed on your skin.",
        recommendations: [
          "Make sure the electrodes have good skin contact",
          "Clean the sensor area with a damp cloth",
          "Try adjusting the device position slightly",
        ],
      },
    };
  }
}

// ============================================
// SESSION APIs
// ============================================

export async function uploadSessionData(
  session: RunSession,
): Promise<APIResponse<{ sessionId: string; uploadedAt: Date }>> {
  // Simulate upload with progress
  await simulateDelay(2500);

  return {
    success: true,
    data: {
      sessionId: session.id,
      uploadedAt: new Date(),
    },
    message: "Session data uploaded successfully",
  };
}

export async function getSessionAnalysis(sessionId: string): Promise<
  APIResponse<{
    insights: SessionInsight[];
    heartRateZones: HeartRateZone[];
    summary: SessionSummary;
  }>
> {
  // Simulate analysis processing
  await simulateDelay(1500);

  return {
    success: true,
    data: {
      insights: generateMockInsights(),
      heartRateZones: generateMockHeartRateZones(),
      summary: generateMockSummary(),
    },
  };
}

// ============================================
// REAL-TIME DATA APIs
// ============================================

export async function sendHeartRateData(
  sessionId: string,
  data: HeartRateData[],
): Promise<APIResponse<void>> {
  // In production, this would be a WebSocket or streaming connection
  await simulateDelay(100);

  return {
    success: true,
    message: "Data received",
  };
}

// ============================================
// USER APIs
// ============================================

export async function createUserAccount(
  name: string,
  email: string,
): Promise<APIResponse<{ userId: string; token: string }>> {
  await simulateDelay(1000);

  return {
    success: true,
    data: {
      userId: `user_${Date.now()}`,
      token: `mock_token_${Date.now()}`,
    },
  };
}

// ============================================
// TYPES FOR API RESPONSES
// ============================================

export interface SessionInsight {
  id: string;
  type: "positive" | "warning" | "info";
  title: string;
  description: string;
  icon: string;
}

export interface HeartRateZone {
  name: string;
  minBpm: number;
  maxBpm: number;
  duration: number; // seconds
  percentage: number;
  color: string;
}

export interface SessionSummary {
  totalDuration: number;
  totalCalories: number;
  averageHeartRate: number;
  maxHeartRate: number;
  minHeartRate: number;
  recoveryTime: number; // seconds
  performanceScore: number; // 0-100
  comparedToAverage: number; // percentage difference
}

// ============================================
// MOCK DATA GENERATORS
// ============================================

function generateMockInsights(): SessionInsight[] {
  return [
    {
      id: "1",
      type: "positive",
      title: "Great Cardiovascular Performance",
      description:
        "Your heart rate recovery was faster than usual, indicating good cardiovascular fitness.",
      icon: "heart",
    },
    {
      id: "2",
      type: "info",
      title: "Optimal Training Zone",
      description:
        "You spent 65% of your session in the optimal training zone for endurance improvement.",
      icon: "target",
    },
    {
      id: "3",
      type: "warning",
      title: "Peak Heart Rate Reached",
      description:
        "You briefly reached 95% of your estimated max heart rate. Consider pacing for longer sessions.",
      icon: "alert-triangle",
    },
  ];
}

function generateMockHeartRateZones(): HeartRateZone[] {
  return [
    {
      name: "Rest",
      minBpm: 60,
      maxBpm: 100,
      duration: 120,
      percentage: 10,
      color: "#94a3b8",
    },
    {
      name: "Fat Burn",
      minBpm: 100,
      maxBpm: 130,
      duration: 480,
      percentage: 40,
      color: "#22c55e",
    },
    {
      name: "Cardio",
      minBpm: 130,
      maxBpm: 160,
      duration: 420,
      percentage: 35,
      color: "#f59e0b",
    },
    {
      name: "Peak",
      minBpm: 160,
      maxBpm: 200,
      duration: 180,
      percentage: 15,
      color: "#ef4444",
    },
  ];
}

function generateMockSummary(): SessionSummary {
  return {
    totalDuration: 1200, // 20 minutes
    totalCalories: 245,
    averageHeartRate: 142,
    maxHeartRate: 178,
    minHeartRate: 72,
    recoveryTime: 45,
    performanceScore: 82,
    comparedToAverage: 8, // 8% better than average
  };
}

// ============================================
// MOCK HEART RATE GENERATOR (for testing)
// ============================================

export function generateMockHeartRate(
  baseRate: number = 70,
  isExercising: boolean = false,
): number {
  const variation = Math.random() * 10 - 5; // -5 to +5
  const exerciseBoost = isExercising ? 40 + Math.random() * 30 : 0;
  return Math.round(baseRate + variation + exerciseBoost);
}

export function* heartRateDataGenerator(
  intervalMs: number = 1000,
): Generator<HeartRateData, never, boolean | undefined> {
  let isExercising = false;
  let baseRate = 70;

  while (true) {
    // Allow external control of exercise state
    const exerciseState = yield {
      timestamp: Date.now(),
      heartRate: generateMockHeartRate(baseRate, isExercising),
      rrInterval: 60000 / generateMockHeartRate(baseRate, isExercising),
    };

    if (exerciseState !== undefined) {
      isExercising = exerciseState;
      baseRate = isExercising ? 90 : 70;
    }
  }
}
