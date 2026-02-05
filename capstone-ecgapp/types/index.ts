// User types
export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

// Onboarding types
export type OnboardingStep =
  | "welcome"
  | "account"
  | "permissions"
  | "bluetooth"
  | "calibration"
  | "complete";

export interface OnboardingState {
  currentStep: OnboardingStep;
  isComplete: boolean;
  permissionsGranted: {
    bluetooth: boolean;
    location: boolean;
  };
}

// Bluetooth/Device types
export interface ECGDevice {
  id: string;
  name: string;
  rssi: number;
  isConnected: boolean;
  isPaired: boolean;
  lastConnected?: Date;
}

export type BluetoothStatus =
  | "unknown"
  | "resetting"
  | "unsupported"
  | "unauthorized"
  | "poweredOff"
  | "poweredOn";

export type ConnectionStatus =
  | "disconnected"
  | "scanning"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

// Calibration types
export type CalibrationStatus =
  | "not-started"
  | "in-progress"
  | "success"
  | "failed";

export interface CalibrationResult {
  status: CalibrationStatus;
  message?: string;
  timestamp?: Date;
  signalQuality?: number;
}

// Run session types
export type SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "ending"
  | "completed";

export interface HeartRateData {
  timestamp: number;
  heartRate: number;
  rrInterval?: number;
}

export interface ECGDataPacket {
  timestamp: number;
  data: number[];
  sequenceNumber: number;
}

export interface EventMarker {
  id: string;
  timestamp: number;
  type: "symptom" | "episode" | "user-mark";
  description?: string;
}

export interface RunSession {
  id: string;
  startTime: Date;
  endTime?: Date;
  status: SessionStatus;
  duration: number; // in seconds
  heartRateData: HeartRateData[];
  ecgPackets: ECGDataPacket[];
  eventMarkers: EventMarker[];
  averageHeartRate?: number;
  maxHeartRate?: number;
  minHeartRate?: number;
}

// API types
export interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface CalibrationAPIResponse {
  isCalibrated: boolean;
  signalQuality: number;
  message: string;
  recommendations?: string[];
}

// Storage keys
export const STORAGE_KEYS = {
  ONBOARDING_COMPLETE: "onboarding_complete",
  USER_DATA: "user_data",
  PAIRED_DEVICE: "paired_device",
  CALIBRATION_DATA: "calibration_data",
  SESSION_HISTORY: "session_history",
} as const;
