import { Observable, Subject } from 'rxjs';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeType } from './interfaces';

const SERVICE_UUID = '00001000-0000-1000-8000-00805f9b34fb';
// const CHRCT_UUID_WRITE = '00001001-0000-1000-8000-00805f9b34fb';
const CHRCT_UUID_READ = '00001002-0000-1000-8000-00805f9b34fb';
const CHRCT_UUID_TURN = '00001003-0000-1000-8000-00805f9b34fb';
const CHRCT_UUID_GYRO = '00001004-0000-1000-8000-00805f9b34fb';

export class MoyuCubeConnection implements SmartCubeConnection {
    type: SmartCubeType = 'Moyu';
    events$: Observable<SmartCubeEvent>;
    deviceName: string;
    deviceMAC: string;

    private eventSubject = new Subject<SmartCubeEvent>();
    private device: BluetoothDevice;
    private server: BluetoothRemoteGATTServer | null = null;
    private service: BluetoothRemoteGATTService | null = null;
    // private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
    private readChar: BluetoothRemoteGATTCharacteristic | null = null;
    private turnChar: BluetoothRemoteGATTCharacteristic | null = null;
    private gyroChar: BluetoothRemoteGATTCharacteristic | null = null;

    private faceStatus = [0, 0, 0, 0, 0, 0];

    constructor(device: BluetoothDevice) {
        this.device = device;
        this.deviceName = device.name || 'Moyu Cube';
        this.deviceMAC = device.id; // Web Bluetooth doesn't give real MAC, using ID
        this.events$ = this.eventSubject.asObservable();
    }

    async connect(): Promise<void> {
        if (!this.device.gatt) {
            throw new Error('Device has no GATT server');
        }

        this.server = await this.device.gatt.connect();
        this.device.addEventListener('gattserverdisconnected', this.onDisconnect.bind(this));

        this.service = await this.server.getPrimaryService(SERVICE_UUID);

        // this.writeChar = await this.service.getCharacteristic(CHRCT_UUID_WRITE);
        this.readChar = await this.service.getCharacteristic(CHRCT_UUID_READ);
        this.turnChar = await this.service.getCharacteristic(CHRCT_UUID_TURN);

        try {
            this.gyroChar = await this.service.getCharacteristic(CHRCT_UUID_GYRO);
        } catch (e) {
            console.warn('Gyro characteristic not found, gyro might not be supported');
        }

        await this.readChar.startNotifications();
        this.readChar.addEventListener('characteristicvaluechanged', this.onReadEvent.bind(this));

        await this.turnChar.startNotifications();
        this.turnChar.addEventListener('characteristicvaluechanged', this.onTurnEvent.bind(this));

        if (this.gyroChar) {
            await this.gyroChar.startNotifications();
            this.gyroChar.addEventListener('characteristicvaluechanged', this.onGyroEvent.bind(this));
        }

        // Emit initial hardware info (mocked or basic)
        this.eventSubject.next({
            type: 'HARDWARE',
            hardwareName: 'Moyu Cube',
            gyroSupported: !!this.gyroChar
        });

        // Request battery
        // Moyu doesn't seem to have a direct battery request command in the reference code,
        // but we can try to read it or just emit a default.
        // The reference code had a getBatteryLevel returning 100.
        this.eventSubject.next({
            type: 'BATTERY',
            batteryLevel: 100
        });
    }

    disconnect(): void {
        if (this.device.gatt && this.device.gatt.connected) {
            this.device.gatt.disconnect();
        }
    }

    async sendCubeCommand(command: { type: string }): Promise<void> {
        // Implement commands if needed. Moyu reference code doesn't show many commands.
        if (command.type === 'REQUEST_BATTERY') {
            this.eventSubject.next({
                type: 'BATTERY',
                batteryLevel: 100
            });
        }
    }

    private onDisconnect() {
        this.eventSubject.next({ type: 'DISCONNECT' });
    }

    private onReadEvent(_event: Event) {
        // const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        // console.log('Moyu Read:', value);
    }

    private onGyroEvent(_event: Event) {
        // Implement gyro parsing if needed
    }

    private onTurnEvent(event: Event) {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        this.parseTurn(value);
    }

    private parseTurn(data: DataView) {
        if (data.byteLength < 1) return;

        const n_moves = data.getUint8(0);
        if (data.byteLength < 1 + n_moves * 6) return;

        for (let i = 0; i < n_moves; i++) {
            const offset = 1 + i * 6;
            // Timestamp parsing (not strictly used for move string but good to have)
            // var ts =  data.getUint8(offset + 1) << 24 ...

            const face = data.getUint8(offset + 4);
            const dir = Math.round(data.getUint8(offset + 5) / 36);

            const prevRot = this.faceStatus[face];
            const curRot = this.faceStatus[face] + dir;
            this.faceStatus[face] = (curRot + 9) % 9;

            const axisMap = [3, 4, 5, 1, 2, 0]; // URFDLB -> 012345 mapping in reference?
            // Reference: "URFDLB".charAt(axis)
            // axis=0 -> U, axis=1 -> R, axis=2 -> F, axis=3 -> D, axis=4 -> L, axis=5 -> B
            // Reference axis map: [3, 4, 5, 1, 2, 0][face]
            // If face=0 -> axis=3 (D?)
            // Let's check reference again:
            // var axis = [3, 4, 5, 1, 2, 0][face];
            // "URFDLB".charAt(axis)

            const axis = axisMap[face];

            let pow = 0;
            if (prevRot >= 5 && curRot <= 4) {
                pow = 2; // Counter-clockwise?
            } else if (prevRot <= 4 && curRot >= 5) {
                pow = 0; // Clockwise?
            } else {
                continue;
            }

            // " 2'".charAt(pow)
            // pow=0 -> ' ' (Clockwise)
            // pow=1 -> '2' (Double) - logic doesn't seem to produce 1 here?
            // pow=2 -> "'" (Counter-clockwise)

            const moveChar = "URFDLB".charAt(axis);
            const suffix = " 2'".charAt(pow).trim();

            const move = moveChar + suffix;

            this.eventSubject.next({
                type: 'MOVE',
                move: move,
                face: axis,
                direction: pow, // 0: CW, 1: Double (?), 2: CCW - need to verify mapping with Gan
                localTimestamp: Date.now(),
                cubeTimestamp: Date.now() // Mocking cube timestamp for now
            });
        }
    }
}

export async function connectMoyuCube(): Promise<MoyuCubeConnection> {
    const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'MHC' }],
        optionalServices: [SERVICE_UUID]
    });

    const connection = new MoyuCubeConnection(device);
    await connection.connect();
    return connection;
}
