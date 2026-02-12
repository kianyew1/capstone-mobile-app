export type BleDevice = {
  id: string;
  name?: string | null;
  rssi?: number | null;
};

export type BleStreamOptions = {
  serviceUUID: string;
  characteristicUUID: string;
  scanTimeoutMs?: number;
};
