import { Observable } from 'rxjs';

export interface SmartCubeEvent {
    type: "GYRO" | "MOVE" | "FACELETS" | "HARDWARE" | "BATTERY" | "DISCONNECT";
    move?: string;
    facelets?: string;
    quaternion?: { x: number, y: number, z: number, w: number };
    velocity?: { x: number, y: number, z: number };
    hardwareName?: string;
    hardwareVersion?: string;
    softwareVersion?: string;
    productDate?: string;
    gyroSupported?: boolean;
    batteryLevel?: number;
    // Compatibility with GanCubeMove
    face?: number;
    direction?: number;
    localTimestamp?: number | null;
    cubeTimestamp?: number | null;
}

export type SmartCubeType = 'GAN' | 'Moyu';

export interface SmartCubeConnection {
    type: SmartCubeType;
    events$: Observable<SmartCubeEvent>;
    deviceName: string;
    deviceMAC: string;

    sendCubeCommand(command: { type: string }): Promise<void>;
    disconnect(): void;
}
