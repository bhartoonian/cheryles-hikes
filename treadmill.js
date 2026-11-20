// Treadmills. Both expose: connect(), start(), pause(), stop(), setSpeed(kmh), setIncline(pct), onData({speed, incline}), onLost()
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class PracticeTreadmill {
  constructor() { this.kind = 'practice'; this.name = 'Practice treadmill'; this.speed = 0; this.incline = 0; this.tSpeed = 0; this.tInc = 0; this.running = false; this.onData = () => {}; this.onLost = () => {}; }
  async connect() {
    clearInterval(this.timer);
    this.timer = setInterval(() => { // behaves like a real belt: speed and tilt change gradually
      const dt = 0.1, target = this.running ? this.tSpeed : 0;
      this.speed += clamp(target - this.speed, -0.6 * dt, 0.35 * dt);   // km/h per second
      this.incline += clamp(this.tInc - this.incline, -0.5 * dt, 0.5 * dt); // % per second
      if (this.speed < 0.01) this.speed = 0;
      this.onData({ speed: this.speed, incline: this.incline });
    }, 100);
  }
  async start() { this.running = true; }
  async pause() { this.running = false; }
  async stop() { this.running = false; this.tInc = 0; }
  async setSpeed(kmh) { this.tSpeed = kmh; }
  async setIncline(pct) { this.tInc = pct; }
}

// Real treadmill over Bluetooth FTMS (Fitness Machine Service). Needs Web Bluetooth:
// Chrome on Mac/Windows/Android, or the Bluefy browser on iPhone/iPad. Not Safari.
export class FtmsTreadmill {
  constructor() { this.kind = 'ftms'; this.name = 'Treadmill'; this.q = Promise.resolve(); this.last = {}; this.onData = () => {}; this.onLost = () => {}; }
  static available() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }
  async connect() {
    this.dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [0x1826] }] });
    this.name = this.dev.name || 'Treadmill';
    this.dev.addEventListener('gattserverdisconnected', () => this.onLost());
    const server = await this.dev.gatt.connect();
    const svc = await server.getPrimaryService(0x1826);
    this.cp = await svc.getCharacteristic(0x2AD9);                 // Fitness Machine Control Point
    await this.cp.startNotifications();                           // indications must be on before writing
    this.cp.addEventListener('characteristicvaluechanged', e => {
      const v = e.target.value; // [0x80, requestOpcode, result]; result 1 = success
      if (v.getUint8(0) === 0x80 && v.getUint8(2) !== 1) console.warn('Treadmill refused command', v.getUint8(1), 'result', v.getUint8(2));
    });
    const data = await svc.getCharacteristic(0x2ACD);              // Treadmill Data
    data.addEventListener('characteristicvaluechanged', e => this.parse(e.target.value));
    await data.startNotifications();
    await this.send([0x00]);                                       // Request Control
  }
  parse(v) {
    const flags = v.getUint16(0, true); let o = 2; const out = {};
    if (!(flags & 0x01)) { out.speed = v.getUint16(o, true) / 100; o += 2; } // km/h
    if (flags & 0x02) o += 2;                                      // average speed
    if (flags & 0x04) o += 3;                                      // total distance
    if (flags & 0x08) { out.incline = v.getInt16(o, true) / 10; o += 4; } // incline % (+ ramp angle)
    this.last = { ...this.last, ...out };
    this.onData(this.last);
  }
  send(bytes) { // GATT writes must not overlap, so queue them
    this.q = this.q.then(() => this.cp.writeValueWithResponse(new Uint8Array(bytes))).catch(e => console.warn('BLE write failed', e));
    return this.q;
  }
  start() { return this.send([0x07]); }
  pause() { return this.send([0x08, 0x02]); }
  stop()  { return this.send([0x08, 0x01]); }
  setSpeed(kmh) { const v = Math.round(kmh * 100); return this.send([0x02, v & 255, v >> 8]); }
  setIncline(pct) { const v = Math.round(pct * 10) & 0xffff; return this.send([0x03, v & 255, v >> 8]); }
}
