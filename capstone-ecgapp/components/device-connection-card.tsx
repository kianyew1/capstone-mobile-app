import { useState } from "react";
import { View, ActivityIndicator } from "react-native";
import {
  Bluetooth,
  Check,
  RefreshCw,
  Unplug,
  Signal,
  AlertCircle,
} from "lucide-react-native";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useBluetoothService } from "@/services/bluetooth-service";

export function DeviceConnectionCard() {
  const [isUnpairing, setIsUnpairing] = useState(false);

  const {
    bluetoothStatus,
    connectionStatus,
    connectedDevice,
    pairedDevice,
    isScanning,
    error,
    startScan,
    reconnectToPairedDevice,
    unpairDevice,
  } = useBluetoothService();

  const isConnected = connectionStatus === "connected";
  const isConnecting =
    connectionStatus === "connecting" || connectionStatus === "reconnecting";

  const handleReconnect = async () => {
    await reconnectToPairedDevice();
  };

  const handleUnpair = async () => {
    setIsUnpairing(true);
    await unpairDevice();
    setIsUnpairing(false);
  };

  const getStatusColor = () => {
    if (isConnected) return "text-green-500";
    if (isConnecting) return "text-yellow-500";
    if (error) return "text-destructive";
    return "text-muted-foreground";
  };

  const getStatusText = () => {
    if (isConnected) return "Connected";
    if (isConnecting) return "Connecting...";
    if (connectionStatus === "error") return "Connection Error";
    if (pairedDevice) return "Disconnected";
    return "No Device Paired";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex-row items-center gap-2">
          <Bluetooth size={20} className="text-primary" />
          <Text className="font-semibold">ECG Device</Text>
        </CardTitle>
        <CardDescription>Manage your ECG device connection</CardDescription>
      </CardHeader>
      <CardContent className="gap-4">
        {/* Device Status */}
        <View className="bg-muted/50 rounded-xl p-4">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-3">
              <View
                className={`w-10 h-10 rounded-full items-center justify-center ${
                  isConnected ? "bg-green-500/10" : "bg-muted"
                }`}
              >
                {isConnecting ? (
                  <ActivityIndicator size="small" />
                ) : isConnected ? (
                  <Check size={20} className="text-green-500" />
                ) : (
                  <Bluetooth size={20} className="text-muted-foreground" />
                )}
              </View>
              <View>
                <Text className="font-medium">
                  {pairedDevice?.name || "No Device"}
                </Text>
                <Text className={`text-sm ${getStatusColor()}`}>
                  {getStatusText()}
                </Text>
              </View>
            </View>

            {pairedDevice && !isConnected && !isConnecting && (
              <Button variant="ghost" size="icon" onPress={handleReconnect}>
                <RefreshCw size={18} className="text-foreground" />
              </Button>
            )}
          </View>

          {/* Signal Strength */}
          {isConnected && connectedDevice && (
            <View className="flex-row items-center gap-2 mt-3 pt-3 border-t border-border">
              <Signal size={14} className="text-green-500" />
              <Text className="text-sm text-muted-foreground">
                Signal: {connectedDevice.rssi || "N/A"} dBm
              </Text>
            </View>
          )}
        </View>

        {/* Error Message */}
        {error && (
          <View className="flex-row items-center gap-2 bg-destructive/10 rounded-lg p-3">
            <AlertCircle size={16} className="text-destructive" />
            <Text className="text-sm text-destructive flex-1">{error}</Text>
          </View>
        )}

        {/* Actions */}
        <View className="flex-row gap-3">
          {!pairedDevice ? (
            <Button
              variant="default"
              className="flex-1"
              onPress={startScan}
              disabled={isScanning || bluetoothStatus !== "poweredOn"}
            >
              <Bluetooth size={16} className="text-primary-foreground mr-2" />
              <Text className="text-primary-foreground font-medium">
                {isScanning ? "Scanning..." : "Scan for Device"}
              </Text>
            </Button>
          ) : (
            <>
              {!isConnected && (
                <Button
                  variant="default"
                  className="flex-1"
                  onPress={handleReconnect}
                  disabled={isConnecting}
                >
                  <RefreshCw
                    size={16}
                    className="text-primary-foreground mr-2"
                  />
                  <Text className="text-primary-foreground font-medium">
                    Reconnect
                  </Text>
                </Button>
              )}

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    className={isConnected ? "flex-1" : ""}
                    disabled={isUnpairing}
                  >
                    <Unplug size={16} className="text-foreground mr-2" />
                    <Text className="font-medium">
                      {isUnpairing ? "Unpairing..." : "Unpair"}
                    </Text>
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Unpair Device?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will disconnect and remove the paired ECG device. You
                      will need to pair again to use the device.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>
                      <Text>Cancel</Text>
                    </AlertDialogCancel>
                    <AlertDialogAction onPress={handleUnpair}>
                      <Text className="text-destructive-foreground">
                        Unpair
                      </Text>
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </View>
      </CardContent>
    </Card>
  );
}
