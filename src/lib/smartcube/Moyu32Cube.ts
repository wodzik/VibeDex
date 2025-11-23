
import { SmartCubeConnection, SmartCubeEvent, SmartCubeType } from './interfaces';
import * as aesjs from 'aes-js';
import LZString from 'lz-string';
import { Subject } from 'rxjs';

const SERVICE_UUID = '0783b03e-7735-b5a0-1760-a305d2795cb0';
const CHRT_UUID_READ = '0783b03e-7735-b5a0-1760-a305d2795cb1';
const CHRT_UUID_WRITE = '0783b03e-7735-b5a0-1760-a305d2795cb2';

const KEYS = [
    'NoJgjANGYJwQrADgjEUAMBmKAWCP4JNIRswt81Yp5DztE1EB2AXSA',
    'NoRg7ANAzArNAc1IigFgqgTB9MCcE8cAbBCJpKgeaSAAxTSPxgC6QA'
];

export class Moyu32CubeConnection implements SmartCubeConnection {
    type: SmartCubeType = 'Moyu';
    device: BluetoothDevice;
    deviceName: string = '';
    deviceMAC: string = '';
    private server: BluetoothRemoteGATTServer | null = null;
    private service: BluetoothRemoteGATTService | null = null;
    private readChar: BluetoothRemoteGATTCharacteristic | null = null;
    private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
    private events = new Subject<SmartCubeEvent>();

    private decoder: any = null;
    private iv: Uint8Array | null = null;

    private prevMoveCnt = -1;
    private prevMoves: string[] = [];
    private timeOffs: number[] = [];
    // private deviceTime = 0;
    // private deviceTimeOffset = 0;

    constructor(device: BluetoothDevice) {
        this.device = device;
        this.deviceName = device.name || 'Unknown Moyu Cube';
    }

    public setMacAddress(mac: string) {
        console.log("Setting MAC manually:", mac);
        this.initDecoder(mac);
    }

    private deriveMacFromNam(name: string): string | null {
        if (/^WCU_MY32_[0-9A-F]{4}$/.exec(name)) {
            return 'CF:30:16:00:' + name.slice(9, 11) + ':' + name.slice(11, 13);
        }
        return null;
    }

    async connect(): Promise<void> {
        console.log("Connecting to Moyu32Cube:", this.deviceName);
        if (!this.device.gatt) {
            throw new Error('Device has no GATT server');
        }

        this.server = await this.device.gatt.connect();
        this.service = await this.server.getPrimaryService(SERVICE_UUID);
        this.readChar = await this.service.getCharacteristic(CHRT_UUID_READ);
        this.writeChar = await this.service.getCharacteristic(CHRT_UUID_WRITE);

        await this.readChar.startNotifications();
        this.readChar.addEventListener('characteristicvaluechanged', this.onCharacteristicValueChanged.bind(this));

        // Try to derive MAC from name
        const derivedMac = this.deriveMacFromNam(this.deviceName);
        if (derivedMac) {
            console.log("Derived MAC from name:", derivedMac);
            this.deviceMAC = derivedMac;
            this.initDecoder(derivedMac);
        } else {
            console.log("Could not derive MAC from name. Waiting for manual setMacAddress or handshake failure.");
        }

        await this.requestCubeInfo();
        await this.requestCubeStatus();
        await this.requestCubePower();
    }

    disconnect(): void {
        if (this.server) {
            this.server.disconnect();
        }
        this.events.complete();
    }

    events$ = this.events.asObservable();

    private onCharacteristicValueChanged(event: Event) {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;

        if (!this.decoder) {
            // If we don't have a decoder yet, we can't decode.
            // But maybe we can detect MAC from the data? No, data is encrypted.
            // We need the MAC to init the decoder.
            // If we are here, it means we connected but didn't set up decoder.
            // We should probably have set it up before connecting or right after.
            return;
        }

        this.parseData(new Uint8Array(value.buffer));
    }



    async sendCubeCommand(command: { type: string }): Promise<void> {
        // Not implemented for Moyu
        console.log("Command not supported for Moyu:", command);
    }

    private getKeyAndIv(value: number[]): [number[], number[]] {
        const key = JSON.parse(LZString.decompressFromEncodedURIComponent(KEYS[0]));
        const iv = JSON.parse(LZString.decompressFromEncodedURIComponent(KEYS[1]));
        for (let i = 0; i < 6; i++) {
            key[i] = (key[i] + value[5 - i]) % 255;
            iv[i] = (iv[i] + value[5 - i]) % 255;
        }
        return [key, iv];
    }

    private initDecoder(mac: string) {
        console.log("Initializing decoder with MAC:", mac);

        // Validate MAC address format
        if (!mac || !mac.match(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/)) {
            console.error("Invalid MAC address format:", mac);
            throw new Error(`Invalid MAC address format: ${mac}. Expected format: XX:XX:XX:XX:XX:XX`);
        }

        const value: number[] = [];
        // Remove colons if present
        const cleanMac = mac.replace(/:/g, '').replace(/-/g, '');
        for (let i = 0; i < 6; i++) {
            const byte = parseInt(cleanMac.slice(i * 2, i * 2 + 2), 16);
            if (isNaN(byte)) {
                console.error("Failed to parse MAC address byte at position", i, ":", cleanMac.slice(i * 2, i * 2 + 2));
                throw new Error(`Invalid MAC address: could not parse byte at position ${i}`);
            }
            value.push(byte);
        }
        const [key, iv] = this.getKeyAndIv(value);
        // Use aes-js for ECB (block) encryption/decryption
        this.decoder = new aesjs.AES(key);
        this.iv = new Uint8Array(iv);
        console.log("Decoder initialized successfully");
    }

    private decrypt(value: Uint8Array): Uint8Array {
        const ret = new Uint8Array(value);
        if (!this.decoder || !this.iv) return ret;

        // Custom CBC-like decryption from moyu32cube.js
        if (ret.length > 16) {
            const offset = ret.length - 16;
            const block = this.decoder.decrypt(ret.slice(offset));
            for (let i = 0; i < 16; i++) {
                ret[i + offset] = block[i] ^ this.iv[i];
            }
        }
        const firstBlock = this.decoder.decrypt(ret.slice(0, 16));
        for (let i = 0; i < 16; i++) {
            ret[i] = firstBlock[i] ^ this.iv[i];
        }
        return ret;
    }

    private encode(data: number[]): Uint8Array {
        const ret = new Uint8Array(data);
        if (!this.decoder || !this.iv) return ret;

        for (let i = 0; i < 16; i++) {
            ret[i] ^= this.iv[i];
        }
        const firstBlock = this.decoder.encrypt(ret.slice(0, 16));
        ret.set(firstBlock, 0);

        if (ret.length > 16) {
            const offset = ret.length - 16;
            const block = ret.slice(offset);
            for (let i = 0; i < 16; i++) {
                block[i] ^= this.iv[i];
            }
            const encryptedBlock = this.decoder.encrypt(block);
            ret.set(encryptedBlock, offset);
        }
        return ret;
    }

    private async sendRequest(req: number[]) {
        if (!this.writeChar) return;
        const encodedReq = this.encode(req);
        await this.writeChar.writeValue(encodedReq.buffer as ArrayBuffer);
    }

    private async sendSimpleRequest(opcode: number) {
        const req = new Array(20).fill(0);
        req[0] = opcode;
        await this.sendRequest(req);
    }

    private async requestCubeInfo() {
        await this.sendSimpleRequest(161);
    }

    private async requestCubeStatus() {
        await this.sendSimpleRequest(163);
    }

    private async requestCubePower() {
        await this.sendSimpleRequest(164);
    }

    private parseData(value: Uint8Array) {
        const decrypted = this.decrypt(value);
        console.log("Moyu32Cube Raw:", value);
        console.log("Moyu32Cube Decrypted:", decrypted);
        console.log("Moyu32Cube MsgType:", decrypted[0]);

        // Convert to binary string representation as in original code?
        // Or just parse bytes directly. Original code converts to binary string which is inefficient but let's see what it does.
        // It does: value[i] = (value[i] + 256).toString(2).slice(1);
        // Then joins them.
        // Then parses chunks.

        // Let's try to parse bytes directly to avoid string manipulation if possible, 
        // but to be safe and match logic, I'll follow the structure or adapt it.
        // msgType is first byte.

        const msgType = decrypted[0];

        if (msgType === 161) { // Info
            // ...
        } else if (msgType === 163) { // State (facelets)
            // ...
        } else if (msgType === 164) { // Battery
            const batteryLevel = decrypted[1];
            this.events.next({
                type: 'BATTERY',
                batteryLevel: batteryLevel
            });
        } else if (msgType === 165) { // Move
            const moveCnt = decrypted[11]; // slice(88, 96) bits -> byte 11
            if (moveCnt === this.prevMoveCnt || this.prevMoveCnt === -1) {
                this.prevMoveCnt = moveCnt; // Update anyway if -1?
                // Original code: if (moveCnt == prevMoveCnt || prevMoveCnt == -1) return;
                // But it sets prevMoveCnt later.
                if (this.prevMoveCnt === -1) this.prevMoveCnt = moveCnt;
                else return;
            }

            // Parse moves
            // 5 moves max in packet
            // Each move is 5 bits.
            // Original code slices bits.
            // 96 + i*5 to 101 + i*5

            // We need to reconstruct the bit stream for the move section.
            // Bytes 12, 13, 14, 15, 16, 17...
            // Let's look at the bit offsets.
            // Move data starts at bit 96 (byte 12).
            // 5 moves * 5 bits = 25 bits.
            // Bytes 12, 13, 14, 15 contain the moves.

            // Let's just implement a getBits helper.
            const getBits = (start: number, len: number) => {
                let res = 0;
                for (let i = 0; i < len; i++) {
                    const bitPos = start + i;
                    const bytePos = Math.floor(bitPos / 8);
                    const bitInByte = 7 - (bitPos % 8);
                    const bit = (decrypted[bytePos] >> bitInByte) & 1;
                    res = (res << 1) | bit;
                }
                return res;
            };

            this.timeOffs = [];
            this.prevMoves = [];
            let invalidMove = false;

            for (let i = 0; i < 5; i++) {
                const m = getBits(96 + i * 5, 5);
                // timeOffs is 16 bits at 8 + i*16
                // Wait, 8 + i*16 is bit offset?
                // Original: value.slice(8 + i * 16, 24 + i * 16) -> 16 bits.
                // This is in the 'value' array which was converted to bits.
                // So it's bit 8 onwards.
                // Byte 1.
                const timeOff = getBits(8 + i * 16, 16);
                this.timeOffs[i] = timeOff;

                let moveChar = "FBUDLR".charAt(m >> 1);
                let moveMod = " '".charAt(m & 1);
                let moveStr = moveChar + moveMod;

                if (m >= 12) {
                    moveStr = "U "; // Invalid?
                    invalidMove = true;
                }
                this.prevMoves[i] = moveStr.trim();
            }

            if (!invalidMove) {
                const moveDiff = (moveCnt - this.prevMoveCnt) & 0xff;
                this.prevMoveCnt = moveCnt;

                // Emit moves
                // We need to determine which moves are new.
                // Logic from moyu32cube.js:
                // if (moveDiff > prevMoves.length) moveDiff = prevMoves.length;
                // Loop i from moveDiff - 1 down to 0.

                let count = moveDiff;
                if (count > this.prevMoves.length) count = this.prevMoves.length;

                for (let i = count - 1; i >= 0; i--) {
                    const move = this.prevMoves[i];
                    // Map to standard notation if needed.
                    // "F ", "F'" -> "F", "F'"
                    // "FBUDLR" -> Standard is U R F D L B?
                    // "FBUDLR" seems to be the internal mapping.
                    // We need to check if it matches standard.
                    // F=Front, B=Back, U=Up, D=Down, L=Left, R=Right.
                    // Yes.

                    this.events.next({
                        type: 'MOVE',
                        move: move,
                        cubeTimestamp: this.timeOffs[i] // This is delta?
                        // Original code accumulates deviceTime.
                    });
                }
            }
        }
    }
}
